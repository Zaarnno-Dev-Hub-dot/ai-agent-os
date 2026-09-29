/**
 * Polls/Approvals rail wiring:
 * REST create, WS decide, expiry-sweep settle, and the two on-decide side
 * effects (requester notify + Paperclip POST-back). Pulled out of index.ts
 * into its own module — same split as bridge.ts/loop.ts: this file owns the
 * decision + side-effect logic against an explicitly-threaded context (unit-
 * testable against a throwaway Fastify instance + fake deps, no full gateway
 * boot required), index.ts owns wiring it to the live maps/closures and the
 * actual WS pre-switch dispatch.
 */

import type { FastifyInstance } from 'fastify';
import type { AgentState, Message, Room } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';
import { relayMessageToAgents } from './relay.js';
import { insertMessage, persistDatabase } from './db.js';
import { buildBridgeMessageContent, newBridgeMessageId } from './bridge.js';
import {
  createPoll,
  decidePoll,
  deferPoll,
  requestPollInfo,
  savePolls,
  sweepExpiredPolls,
  withdrawPoll,
  MAX_POLL_DEFERRALS,
  type CreatePollInput,
  type Poll,
  type PollsState,
} from './polls.js';
import { postApprovalDecision } from './paperclip.js';
import { applyWorkshopPoll } from './workshopRoutes.js';
import { isValidHumanToken, HUMAN_TOKEN_REQUIRED_ERROR } from './humanAuth.js';

/** Non-agent sender for poll requester-notify messages, same class as 'system'/bridge.ts's BRIDGE_SENDER_ID — never registered in the `agents` map. */
export const POLL_SYSTEM_SENDER_ID = 'poll-system';

/**
 * Context the route/handlers need from index.ts — the same live maps/
 * closures every other route/handler in index.ts already reads, threaded
 * explicitly instead of via module-scoped globals (bridge.ts's
 * BridgeRouteContext precedent).
 */
export interface PollsRouteContext {
  relayDeps: RelayDeps;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  db: RelayDeps['db'];
  dataDir: string;
  /** Repo root — Wave 6 workshop-apply's `git worktree add` runs here. Unused by any non-workshop poll source. */
  projectRoot: string;
  paperclipBaseUrl: string;
  getPollsState: () => PollsState;
  setPollsState: (state: PollsState) => void;
  broadcast: RelayDeps['broadcast'];
  markBusy: (agentIds: Iterable<string>) => void;
  /** Broadcast a fresh state.sync — index.ts's own buildStateSync+broadcast, threaded in so this module never builds a ServerEvent shape it doesn't own (state.sync's `polls` field construction stays in index.ts's buildStateSync). */
  broadcastStateSync: () => void;
  /** Persisted, broadcast system-line helper — index.ts's own postSystemLine. */
  postSystemLine: (roomId: string, content: string) => void;
  /** Boot-minted humanToken — poll.decide REQUIRES a caller to present this exact value; see handlePollDecide's `providedToken` param. */
  humanToken: string;
  /**
   * Two-Reviewer Policy hook (Wave 7 M3): fired for every poll that just
   * settled (manual decide OR expiry sweep — both funnel through
   * notifyPollSettled), AFTER the existing settle side effects. Optional so
   * every pre-M3 test/caller of this module keeps working unchanged;
   * production wiring (index.ts) always supplies it. Never awaited/throws
   * into the caller — reviews are purely additive ledger bookkeeping, never
   * a reason to delay or fail a decide.
   */
  onPollSettled?: (poll: Poll) => void;
}

export function pollOptionLabel(poll: Poll): string {
  const optionId = poll.decision?.optionId;
  return poll.options.find((o) => o.id === optionId)?.label ?? optionId ?? '(unknown)';
}

/** System-line text for a poll that just settled — decided (manual or auto-default) or expired with no default. */
export function pollDecisionLine(poll: Poll): string {
  if (poll.status === 'expired') {
    return `→ poll: "${poll.question}" expired with no decision.`;
  }
  if (poll.status === 'withdrawn') {
    return `→ poll withdrawn: "${poll.question}".`;
  }
  const by = poll.decision?.decidedBy === 'auto-default' ? 'auto-default (expiry)' : '@human';
  return `→ poll decided: "${poll.question}" → ${pollOptionLabel(poll)} (${by}).`;
}

/** Server->client readback for a poll mutation, cast at the endpoint by the caller (index.ts) like room.autoroute.status/loop.status — ServerEvent has no dedicated field for this. Kept as a plain broadcast call here so this module stays free of the shared-type cast (index.ts owns exactly one cast site per event name, same convention as every other gateway-local event). */
export function broadcastPollUpdated(ctx: PollsRouteContext, poll: Poll): void {
  ctx.broadcast({ type: 'poll.updated', payload: poll } as unknown as Parameters<PollsRouteContext['broadcast']>[0]);
}

/**
 * Shared requester-wake plumbing for every poll side effect that must reach
 * back into a room (settle notify AND more-info notify) — only if
 * `requestedBy` is a currently-VERIFIED seat. REUSES bridge.ts's buildBridgeMessageContent/
 * newBridgeMessageId (mention-injection-safe prompt building) and the exact
 * persisted-message + delivery-only-clone shape bridge.ts's own route uses,
 * rather than forking that logic. Never throws into the caller — log-once on
 * failure, same isolation contract as the Paperclip poller's fetch side.
 */
async function notifyRequesterSeat(ctx: PollsRouteContext, poll: Poll, summary: string): Promise<void> {
  const requester = ctx.agents.get(poll.requestedBy);
  if (!requester || requester.status !== 'VERIFIED') return;
  try {
    const content = buildBridgeMessageContent(poll.requestedBy, summary);
    const msg: Message = {
      id: newBridgeMessageId(),
      roomId: poll.roomId,
      senderId: POLL_SYSTEM_SENDER_ID,
      content,
      mentions: [poll.requestedBy],
      createdAt: Date.now(),
    };
    insertMessage(ctx.db, msg);
    persistDatabase(ctx.db, ctx.dataDir);
    const list = ctx.messages.get(poll.roomId) ?? [];
    list.push(msg);
    ctx.messages.set(poll.roomId, list);
    ctx.broadcast({ type: 'message.new', payload: msg });
    // Delivery-only clone (never persisted), senderId 'human' — identical
    // reasoning to bridge.ts's registerBridgeRoute: relay.ts's frozen
    // resolveRelayTargets only honors an explicit @mention from a
    // non-agent-looking sender for its specific-mentions branch.
    ctx.markBusy([poll.requestedBy]);
    relayMessageToAgents(ctx.relayDeps, poll.roomId, { ...msg, senderId: 'human', mentions: [poll.requestedBy] });
  } catch (e) {
    console.error('[polls] requester notify failed', poll.id, e);
  }
}

/**
 * Side effects for a poll that just settled:
 *   (b) if requestedBy is a currently-VERIFIED seat, wake it with the
 *       decision via notifyRequesterSeat.
 *   (c) if source='paperclip', POST the decision back to Paperclip per the
 *       scout's real API shapes.
 * Never throws into the caller (decide/expiry path) — every branch is its
 * own try/catch, log-once-per-call on failure, same isolation contract as
 * the Paperclip poller's fetch side.
 */
export async function notifyPollSettled(ctx: PollsRouteContext, poll: Poll): Promise<void> {
  const summary =
    poll.status === 'expired'
      ? `Your poll "${poll.question}" expired with no decision.`
      : `Your poll "${poll.question}" was decided: ${pollOptionLabel(poll)}${
          poll.decision?.note ? ` — "${poll.decision.note}"` : ''
        }.`;
  await notifyRequesterSeat(ctx, poll, summary);

  // Two-Reviewer Policy (Wave 7 M3): cancel pending reviews, mark stragglers
  // timed-out, and backfill the human decision onto the ledger for the
  // red-override metric. Runs for BOTH triggers this function already
  // covers (manual decide and expiry sweep) — same "reviews never gate or
  // extend a poll's life" contract as the rest of this function's side
  // effects. try/catch: a ledger-bookkeeping failure must never surface as a
  // decide/expiry failure.
  try {
    ctx.onPollSettled?.(poll);
  } catch (e) {
    console.error('[polls] review-policy settle hook failed', poll.id, e);
  }

  if (poll.source === 'paperclip' && poll.externalRef && poll.status === 'decided') {
    // Fixed option order from paperclip.ts's pollInputForApproval
    // ([Approve, Reject]) — options[0].id is 'approve', anything else is
    // 'reject'. Robust to option ids being caller-chosen rather than parsed
    // from the (locale-able) label text.
    const action = poll.decision?.optionId === poll.options[0]?.id ? 'approve' : 'reject';
    try {
      await postApprovalDecision(ctx.paperclipBaseUrl, poll.externalRef.approvalId, action, poll.decision?.note);
    } catch (e) {
      console.error('[polls] Paperclip POST-back failed', poll.id, poll.externalRef.approvalId, e);
    }
  }

  // Workshop apply: fixed
  // option ids from workshopRoutes.ts's registerWorkshopRoute
  // ([{id:'approve'},{id:'reject'}]) — same "poll.status==='decided'" guard
  // as the paperclip branch above, which also naturally excludes an EXPIRED
  // workshop poll (workshop polls can never carry a defaultOptionId per
  // polls.ts's createPoll, so expiry always settles as 'expired', never
  // 'decided' — sweepExpiredPolls only reaches 'decided' via a
  // defaultOptionId auto-default). Reject applies nothing — the existing pollDecisionLine
  // system line from handlePollDecide/sweepAndSettlePolls already covers that
  // half; only approve does more work here. Every propose/apply/reject gets a
  // gateway log line — propose's is in
  // workshopRoutes.ts, decide's (both outcomes) is here.
  if (poll.source === 'workshop' && poll.status === 'decided') {
    const approved = poll.decision?.optionId === 'approve';
    console.log(`[workshop] decide poll=${poll.id} seat=${poll.requestedBy} outcome=${approved ? 'approve' : 'reject'}`);
    if (approved) {
      try {
        const result = await applyWorkshopPoll({ projectRoot: ctx.projectRoot, agents: ctx.agents }, poll);
        if (result.ok) {
          ctx.postSystemLine(poll.roomId, `→ workshop applied: branch ${result.branch} @ ${result.sha}.`);
          console.log(`[workshop] applied poll=${poll.id} branch=${result.branch} sha=${result.sha}`);
        } else {
          ctx.postSystemLine(poll.roomId, `→ workshop apply FAILED: ${result.error}`);
          console.error('[workshop] apply failed', poll.id, result.error);
        }
      } catch (e) {
        ctx.postSystemLine(poll.roomId, `→ workshop apply FAILED: ${(e as Error).message}`);
        console.error('[workshop] apply threw', poll.id, e);
      }
    }
  }
}

/**
 * Requester-notify for a more-info ask. Unlike notifyPollSettled there is no Paperclip POST-back branch —
 * the poll hasn't settled, there is nothing to report back externally.
 */
export async function notifyPollInfoRequested(ctx: PollsRouteContext, poll: Poll, note?: string): Promise<void> {
  const summary = note
    ? `More info was requested on your poll "${poll.question}": ${note}`
    : `More info was requested on your poll "${poll.question}".`;
  await notifyRequesterSeat(ctx, poll, summary);
}

/** Fire-and-forget wrapper for call sites (WS/REST decide, expiry sweep) that must never let a settle side effect delay or throw into their own response path. notifyPollSettled already self-catches; this is belt-and-suspenders. */
export function settlePollAsync(ctx: PollsRouteContext, poll: Poll): void {
  void notifyPollSettled(ctx, poll).catch((e) => console.error('[polls] settle side-effects failed', poll.id, e));
}

/** Fire-and-forget wrapper for the more-info notify, same reasoning as settlePollAsync. */
function notifyInfoRequestedAsync(ctx: PollsRouteContext, poll: Poll, note?: string): void {
  void notifyPollInfoRequested(ctx, poll, note).catch((e) =>
    console.error('[polls] more-info notify failed', poll.id, e)
  );
}

export type DecideOutcome = { ok: true; poll: Poll } | { ok: false; error: string };

/**
 * WS poll.decide. Settle-once via polls.ts's decidePoll,
 * persist, system line, poll.updated broadcast, fresh state.sync, and the
 * on-decide side effects — fire-and-forget so a slow/failing notify or
 * Paperclip POST-back never delays the WS response.
 *
 * `providedToken` ("invariant-already-false (loopback WS decide)"): checked FIRST, before
 * `decidePoll` even runs — a caller who cannot present the exact boot-minted
 * humanToken (delivered only via the served index.html; see index.ts) gets
 * `HUMAN_TOKEN_REQUIRED_ERROR` and nothing is decided. This closes the hole
 * where any local non-browser WS client that merely passes the Origin gate
 * (no Origin header at all is treated as "not a drive-by browser vector",
 * not as "not human") could call poll.decide today.
 */
export function handlePollDecide(
  ctx: PollsRouteContext,
  pollId: string,
  optionId: string,
  decidedBy: string,
  note?: string,
  providedToken?: unknown
): DecideOutcome {
  if (!isValidHumanToken(ctx.humanToken, providedToken)) {
    return { ok: false, error: HUMAN_TOKEN_REQUIRED_ERROR };
  }
  const result = decidePoll(ctx.getPollsState(), pollId, optionId, decidedBy, note);
  if (!result.ok) return { ok: false, error: result.error };
  ctx.setPollsState(result.state);
  savePolls(ctx.dataDir, result.state);
  ctx.postSystemLine(result.poll.roomId, pollDecisionLine(result.poll));
  broadcastPollUpdated(ctx, result.poll);
  ctx.broadcastStateSync();
  settlePollAsync(ctx, result.poll);
  return { ok: true, poll: result.poll };
}

export type WithdrawOutcome = { ok: true; poll: Poll } | { ok: false; error: string };

/**
 * REST POST /api/polls/:id/withdraw: the human
 * "remove this decision" affordance. humanToken-gated the SAME way as
 * handlePollDecide — checked FIRST, before withdrawPoll even runs, so an
 * agent (or any local non-browser caller that merely passes the loopback
 * trust model) cannot retire a poll out from under a human; only a caller
 * holding the boot-minted token served via index.html can.
 *
 * Deliberately NOT the full notifyPollSettled/settlePollAsync path: decide/
 * expiry SETTLE a poll toward an answer (requester wake, Paperclip
 * POST-back, workshop apply all make sense there); withdrawing is a silent
 * retraction of the ask itself — there is no outcome to report downstream,
 * and firing the Paperclip POST-back or workshop-apply branches for a
 * withdrawn (undecided) poll would be actively wrong (both branches key off
 * `poll.decision`, which withdrawPoll never sets). The ONE piece of
 * notifyPollSettled's work that still applies is `ctx.onPollSettled` (Two-
 * Reviewer Policy, Wave 7 M3): pollReviews.ts's own onPollSettled is generic
 * "poll left open" cleanup (cancels any still-pending review waits so
 * nothing is left hanging), gated internally on `poll.status === 'decided'`
 * for the one branch that doesn't apply here — safe and correct to fire for
 * 'withdrawn' too, same fire-and-forget/never-throws contract as every
 * other caller of this hook.
 */
export function handlePollWithdraw(
  ctx: PollsRouteContext,
  pollId: string,
  note: string | undefined,
  providedToken: unknown
): WithdrawOutcome {
  if (!isValidHumanToken(ctx.humanToken, providedToken)) {
    return { ok: false, error: HUMAN_TOKEN_REQUIRED_ERROR };
  }
  const result = withdrawPoll(ctx.getPollsState(), pollId, note);
  if (!result.ok) return { ok: false, error: result.error };
  ctx.setPollsState(result.state);
  savePolls(ctx.dataDir, result.state);
  ctx.postSystemLine(result.poll.roomId, pollDecisionLine(result.poll));
  broadcastPollUpdated(ctx, result.poll);
  ctx.broadcastStateSync();
  try {
    ctx.onPollSettled?.(result.poll);
  } catch (e) {
    console.error('[polls] review-policy settle hook failed (withdraw)', result.poll.id, e);
  }
  return { ok: true, poll: result.poll };
}

/**
 * WS poll.defer, human-seats-only — same access
 * model as poll.decide (see index.ts's WS pre-switch case). Delegates the
 * extension math + cap enforcement to polls.ts's deferPoll; this wrapper
 * owns persistence, the room system line, and the live broadcasts. The poll
 * stays 'open' — no settle side effects (no requester notify, no Paperclip
 * POST-back; there is nothing to report back yet).
 */
export function handlePollDefer(ctx: PollsRouteContext, pollId: string, by: string, note?: string): DecideOutcome {
  const result = deferPoll(ctx.getPollsState(), pollId, by, note);
  if (!result.ok) return { ok: false, error: result.error };
  ctx.setPollsState(result.state);
  savePolls(ctx.dataDir, result.state);
  const n = result.poll.deferrals?.length ?? 0;
  ctx.postSystemLine(result.poll.roomId, `→ poll deferred (${n}/${MAX_POLL_DEFERRALS}): "${result.poll.question}".`);
  broadcastPollUpdated(ctx, result.poll);
  ctx.broadcastStateSync();
  return { ok: true, poll: result.poll };
}

/**
 * WS poll.info-requested, human-seats-only — same
 * access model as poll.decide. Posts the needs-info message (polls.ts's
 * requestPollInfo; no status change) AND notifies the requester seat over
 * the bridge, fire-and-forget same as settlePollAsync so a slow/failing
 * notify never delays the WS response.
 */
export function handlePollInfoRequested(
  ctx: PollsRouteContext,
  pollId: string,
  by: string,
  note?: string
): DecideOutcome {
  const result = requestPollInfo(ctx.getPollsState(), pollId, by, note);
  if (!result.ok) return { ok: false, error: result.error };
  ctx.setPollsState(result.state);
  savePolls(ctx.dataDir, result.state);
  ctx.postSystemLine(result.poll.roomId, `→ more info requested: "${result.poll.question}".`);
  broadcastPollUpdated(ctx, result.poll);
  ctx.broadcastStateSync();
  notifyInfoRequestedAsync(ctx, result.poll, note);
  return { ok: true, poll: result.poll };
}

/**
 * Expiry sweep: interval + boot rehydrate, so
 * a poll that expired while the gateway was down is not left open forever.
 * Pure decision lives in polls.ts (sweepExpiredPolls); this wrapper owns
 * persistence + broadcast + settle side effects, same split as handlePollDecide.
 */
export function sweepAndSettlePolls(ctx: PollsRouteContext): void {
  const { state, changed } = sweepExpiredPolls(ctx.getPollsState());
  if (changed.length === 0) return;
  ctx.setPollsState(state);
  savePolls(ctx.dataDir, state);
  for (const poll of changed) {
    ctx.postSystemLine(poll.roomId, pollDecisionLine(poll));
    broadcastPollUpdated(ctx, poll);
    settlePollAsync(ctx, poll);
  }
  ctx.broadcastStateSync();
}

/**
 * POST /api/polls. REST, loopback trust model —
 * same convention as POST /api/bridge/wake ("the gateway binds 127.0.0.1 and
 * trusts local callers; this endpoint invents no new auth system"). Agents,
 * scripts, and (indirectly, via createPoll called in-process) the Paperclip
 * poller all use this one shape.
 */
export function registerPollsRoute(fastify: FastifyInstance, ctx: PollsRouteContext): void {
  fastify.post<{ Body: Record<string, unknown> }>('/api/polls', async (req, reply) => {
    const body = req.body ?? {};
    const roomId = typeof body.roomId === 'string' ? body.roomId : undefined;
    if (!roomId) {
      reply.code(400);
      return { error: 'roomId is required.' };
    }
    const room = ctx.rooms.get(roomId);
    if (!room || room.archivedAt != null) {
      reply.code(400);
      return { error: 'Room not found or archived.' };
    }
    const input: CreatePollInput = {
      roomId,
      question: typeof body.question === 'string' ? body.question : '',
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      // Rich-card fields — additive,
      // same bare-cast-with-fallback style as `options` below. This route only
      // checks "is it an array" — the cast is NOT a runtime shape guarantee.
      // Per-item shape (crucially, `kind` being one of the 4 literals the type
      // declares) is deep-validated one call down, in createPoll() itself,
      // via polls.ts's own isPollAttachment/isPollDisputeSide (SECURITY,
      // the original design correction #1 reopened: a missing/non-canonical `kind`
      // used to sail through to the UI's attachmentSrc() allowlist, which
      // gates url/data SHAPE but not `kind` — see pollPresent.ts). Rejecting
      // malformed attachments at creation time, not just relying on the
      // render-time allowlist, is what actually keeps bad data out of live
      // state in the first place.
      detailSummary: typeof body.detailSummary === 'string' ? body.detailSummary : undefined,
      recommendation: typeof body.recommendation === 'string' ? body.recommendation : undefined,
      attachments: Array.isArray(body.attachments) ? (body.attachments as CreatePollInput['attachments']) : undefined,
      disputeSides: Array.isArray(body.disputeSides)
        ? (body.disputeSides as CreatePollInput['disputeSides'])
        : undefined,
      options: Array.isArray(body.options) ? (body.options as Array<{ id?: string; label: string }>) : [],
      recommendationId: typeof body.recommendationId === 'string' ? body.recommendationId : undefined,
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : '',
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : undefined,
      defaultOptionId: typeof body.defaultOptionId === 'string' ? body.defaultOptionId : undefined,
      source: body.source === 'paperclip' ? 'paperclip' : 'local',
      externalRef:
        typeof body.externalRef === 'object' && body.externalRef != null
          ? (body.externalRef as { approvalId: string; companyId: string })
          : undefined,
    };
    const result = createPoll(ctx.getPollsState(), input);
    if (!result.ok) {
      reply.code(400);
      return { error: result.error };
    }
    ctx.setPollsState(result.state);
    savePolls(ctx.dataDir, result.state);
    broadcastPollUpdated(ctx, result.poll);
    ctx.broadcastStateSync();
    return result.poll;
  });

  /**
   * POST /api/polls/:id/withdraw (owner-directed, "remove
   * decision" button). humanToken-gated in the body — same convention as
   * POST /api/review-policy (pollReviews.ts's registerPollReviewRoutes),
   * which is the existing REST (non-WS) precedent for this exact gate;
   * poll.decide/poll.defer are WS-only, so this route's auth check mirrors
   * that REST sibling's shape, not a WS handler's. 401 on a missing/wrong
   * token (matches the review-policy route); 400 for every other rejection
   * (not found / already settled).
   */
  fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/polls/:id/withdraw',
    async (req, reply) => {
      const body = req.body ?? {};
      const note = typeof body.note === 'string' ? body.note : undefined;
      const outcome = handlePollWithdraw(ctx, req.params.id, note, body.humanToken);
      if (!outcome.ok) {
        reply.code(outcome.error === HUMAN_TOKEN_REQUIRED_ERROR ? 401 : 400);
        return { error: outcome.error };
      }
      return outcome.poll;
    }
  );
}
