/**
 * Two-Reviewer Policy — wiring (Wave 7 M3,
 * docs/DESIGN-two-reviewer-policy.md "Review execution" + "Ledger"). Owns:
 *   - the actual reviewer wakes, REUSING bridge.ts's BridgeWaitRegistry/
 *     buildBridgeMessageContent/newBridgeMessageId — the SAME "post a
 *     message addressed to one seat, deliver via relay.ts's unmodified
 *     relayMessageToAgents, observe its next message.new reply" seam
 *     registerBridgeRoute/escalateRoutes.ts already use, not a new
 *     mechanism;
 *   - the 4-min per-reviewer wake timeout + T+4 parallel substitute (F7);
 *   - the 10-min card deadline sweep;
 *   - three hooks other gateway-local-editable modules call
 *     (onPollProposed / onPollSettled / onSeatDisconnected) — see index.ts's
 *     wiring for where each fires;
 *   - the humanToken-gated review_policy toggle route, the (ungated) per-
 *     finding valid/invalid toggle route, and the digest route.
 *
 * Route/decision logic lives here — unit-testable against a throwaway
 * Fastify instance + fake deps (no full gateway boot required), same split
 * as bridge.ts/pollsRoutes.ts/workshopRoutes.ts. index.ts owns wiring it to
 * the live maps/closures.
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentState, Message, PollReview, Room, ServerEvent } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';
import { relayMessageToAgents } from './relay.js';
import { insertMessage, persistDatabase, type SqlDatabase } from './db.js';
import { buildBridgeMessageContent, newBridgeMessageId, type BridgeWaitRegistry, type BridgeWakeResult } from './bridge.js';
import { isAttestedManifest } from './attestedVerifier.js';
import { isValidHumanToken, HUMAN_TOKEN_REQUIRED_ERROR } from './humanAuth.js';
import { pollsForStateSync, type Poll, type PollsState } from './polls.js';
import {
  buildReviewPrompt,
  candidatesFromAgents,
  isActionCovered,
  lanePartnerOf,
  loadLanes,
  reviewRoomName,
  saveReviewPolicy,
  selectReviewers,
  selectSubstitute,
  parseVerdictBlock,
  type CoveredActionType,
  type ReviewPolicyMode,
  type ReviewPolicyState,
} from './reviewPolicy.js';
import {
  applyPollReviewsSchema,
  backfillHumanDecision,
  computeReviewDigest,
  insertFindings,
  insertPollReview,
  lastSelectedAtBySeat,
  loadPollReviewById,
  loadReviewsForPoll,
  loadReviewsForPolls,
  markPollReviewAttached,
  markPollReviewSubstituted,
  markPollReviewTimedOut,
  setFindingValidity,
  type ReviewDigest,
} from './pollReviewsDb.js';

export { applyPollReviewsSchema };

/** Explicit 4-min per-reviewer wake timeout (design doc F7: "NOT the bridge 570s default"). */
export const REVIEW_WAKE_TIMEOUT_MS = 4 * 60_000;
/** 10-min card deadline (design doc F7). */
export const REVIEW_CARD_DEADLINE_MS = 10 * 60_000;

/** Non-agent sender for review wake messages, same class as bridge.ts's BRIDGE_SENDER_ID / pollsRoutes.ts's POLL_SYSTEM_SENDER_ID. */
export const REVIEW_SENDER_ID = 'review-system';

// ============================================================================
// Tracker — the ONLY mutable bookkeeping this feature needs beyond the DB
// (pending-wait cancel functions + the card-deadline timer per poll).
// Explicitly threaded (constructed once in index.ts, passed through ctx-
// adjacent calls), same "no module-scoped globals" convention as
// BridgeIdempotencyStore/BridgeWaitRegistry — lets tests build a fresh one
// per test instead of sharing process-lifetime state.
// ============================================================================

export class PollReviewTracker {
  private readonly cancelFns = new Map<string, () => void>();
  private readonly pendingBySeat = new Map<string, Set<string>>();
  private readonly cardDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  trackPending(reviewId: string, seatId: string, cancel: () => void): void {
    this.cancelFns.set(reviewId, cancel);
    const set = this.pendingBySeat.get(seatId) ?? new Set<string>();
    set.add(reviewId);
    this.pendingBySeat.set(seatId, set);
  }

  clearPending(reviewId: string, seatId: string): void {
    this.cancelFns.delete(reviewId);
    this.pendingBySeat.get(seatId)?.delete(reviewId);
  }

  /** Snapshot copy — safe to iterate while the caller mutates via clearPending. */
  pendingReviewIdsForSeat(seatId: string): string[] {
    return Array.from(this.pendingBySeat.get(seatId) ?? []);
  }

  cancel(reviewId: string): void {
    this.cancelFns.get(reviewId)?.();
  }

  setCardDeadlineTimer(pollId: string, timer: ReturnType<typeof setTimeout>): void {
    this.cardDeadlineTimers.set(pollId, timer);
  }

  clearCardDeadlineTimer(pollId: string): void {
    const t = this.cardDeadlineTimers.get(pollId);
    if (t) {
      clearTimeout(t);
      this.cardDeadlineTimers.delete(pollId);
    }
  }
}

// ============================================================================
// Context
// ============================================================================

export interface PollReviewsContext {
  relayDeps: RelayDeps;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  db: SqlDatabase;
  dataDir: string;
  projectRoot: string;
  defaultRoomTurnCap: number;
  broadcast: (event: ServerEvent) => void;
  markBusy: (agentIds: Iterable<string>) => void;
  persistRoomMutation: (room: Room) => void;
  postSystemLine: (roomId: string, content: string) => void;
  /** SAME BridgeWaitRegistry instance index.ts's broadcast() hook already observes message.new against for bridge.ts/escalateRoutes.ts — reused, not duplicated (its observe() is generic over any (roomId, seatId) pair). */
  waits: BridgeWaitRegistry;
  getReviewPolicy: () => ReviewPolicyState;
  setReviewPolicy: (state: ReviewPolicyState) => void;
  /** Resolve a poll by id (for system-line room targeting from hooks that only carry a pollId, e.g. onSeatDisconnected) — reads the SAME pollsState index.ts/pollsRoutes.ts already hold. Best-effort: a lookup miss just skips the system line, never throws. */
  getPoll: (pollId: string) => Poll | undefined;
  humanToken: string;
  /** Injectable — tests only. Production callers omit (defaults below). */
  now?: () => number;
  wakeTimeoutMs?: number;
  cardDeadlineMs?: number;
}

function findOrCreateReviewRoom(ctx: PollReviewsContext, seatId: string): Room {
  const wantedName = reviewRoomName(seatId);
  let room = Array.from(ctx.rooms.values()).find((r) => r.name === wantedName && r.archivedAt == null);
  if (!room) {
    room = {
      id: randomUUID(),
      name: wantedName,
      type: 'dm',
      memberIds: [seatId],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCap: ctx.defaultRoomTurnCap,
    };
    ctx.persistRoomMutation(room);
  } else if (!room.memberIds.includes(seatId)) {
    room = { ...room, memberIds: [...room.memberIds, seatId], updatedAt: Date.now() };
    ctx.persistRoomMutation(room);
  }
  return room;
}

/** `poll.review.updated` — gateway-local extension of the frozen ServerEvent union, same cast-at-the-endpoint idiom as `poll.updated` (pollsRoutes.ts's broadcastPollUpdated). No-op if the review can't be re-read (should not happen — every call site just wrote it). */
function broadcastReviewUpdated(ctx: PollReviewsContext, review: PollReview | undefined): void {
  if (!review) return;
  ctx.broadcast({ type: 'poll.review.updated', payload: review } as unknown as ServerEvent);
}

/** Diff text for the wake prompt — every diffAttachment concatenated. Truncation already happened at propose time (workshop.ts's buildUnifiedDiff); this never re-truncates. */
function diffTextForPoll(poll: Poll): string | undefined {
  if (!poll.diffAttachments?.length) return undefined;
  return poll.diffAttachments.map((d) => `--- ${d.repoPath}${d.truncated ? ' (truncated)' : ''} ---\n${d.diff}`).join('\n\n');
}

interface WakeOptions {
  reviewId: string;
  seatId: string;
  slot: 1 | 2;
  family: string;
  poolSize: number;
  policyMode: 'mutations' | 'all';
  /** Set only for a T+4 substitute wake — points at the original review row it stands in for. */
  substituteForReviewId?: string;
  /** The OTHER slot's family at the time selection ran — carried through so a slot-2 substitute can still enforce "different family from slot 1" without re-reading slot 1's (possibly since-changed) live state. */
  otherSlotFamily: string;
}

/**
 * Wake one reviewer seat and, on settle, record the outcome (handleWakeSettle
 * below). Fire-and-forget from the caller's perspective — startPollReview
 * never awaits this; the underlying poll/action is already live and reviews
 * are purely additive (design doc: "reviews NEVER gate or extend a poll's
 * life").
 */
function wakeReviewerSeat(ctx: PollReviewsContext, tracker: PollReviewTracker, poll: Poll, opts: WakeOptions): void {
  const now = ctx.now ? ctx.now() : Date.now();
  const wakeTimeoutMs = ctx.wakeTimeoutMs ?? REVIEW_WAKE_TIMEOUT_MS;
  const room = findOrCreateReviewRoom(ctx, opts.seatId);

  insertPollReview(ctx.db, {
    id: opts.reviewId,
    pollId: poll.id,
    seatId: opts.seatId,
    family: opts.family,
    slot: opts.slot,
    poolSize: opts.poolSize,
    policyMode: opts.policyMode,
    wakeAt: now,
    status: 'pending',
    substituteFor: opts.substituteForReviewId,
  });
  persistDatabase(ctx.db, ctx.dataDir);
  broadcastReviewUpdated(ctx, loadPollReviewById(ctx.db, opts.reviewId));

  // buildReviewPrompt is a pure function of (poll question/detail/diff) alone
  // — it never receives the OTHER slot's seat id, family, or verdict, so
  // there is nothing about the other reviewer for THIS wake to leak by
  // construction (design doc F6 isolation), not by an after-the-fact filter.
  const prompt = buildReviewPrompt(poll.question, poll.detail, diffTextForPoll(poll));

  // B7: register with this wake's OWN message id up front — relay.ts's
  // commitAgentReply stamps that id as `replyTo` on the seat's reply, which
  // is what BridgeWaitRegistry.observe() now correlates against (see
  // bridge.ts's class doc comment).
  const bridgeMessageId = newBridgeMessageId();
  const cancel = ctx.waits.register(
    room.id,
    opts.seatId,
    wakeTimeoutMs,
    (result: BridgeWakeResult) => {
      tracker.clearPending(opts.reviewId, opts.seatId);
      void handleWakeSettle(ctx, tracker, poll, opts, result);
    },
    bridgeMessageId
  );
  tracker.trackPending(opts.reviewId, opts.seatId, cancel);

  const msg: Message = {
    id: bridgeMessageId,
    roomId: room.id,
    senderId: REVIEW_SENDER_ID,
    content: buildBridgeMessageContent(opts.seatId, prompt),
    mentions: [opts.seatId],
    createdAt: now,
  };
  insertMessage(ctx.db, msg);
  persistDatabase(ctx.db, ctx.dataDir);
  const list = ctx.messages.get(room.id) ?? [];
  list.push(msg);
  ctx.messages.set(room.id, list);
  ctx.broadcast({ type: 'message.new', payload: msg });

  // Delivery-only clone (never persisted), senderId 'human' — identical
  // reasoning to bridge.ts/escalateRoutes.ts: relay.ts's frozen
  // resolveRelayTargets only honors an explicit @mention from a
  // non-agent-looking sender for its specific-mentions branch.
  ctx.markBusy([opts.seatId]);
  relayMessageToAgents(ctx.relayDeps, room.id, { ...msg, senderId: 'human', mentions: [opts.seatId] });
}

/**
 * Wake settle: OK -> strictly parse + persist the verdict/findings (never
 * coerced to approve on a parse failure). Timeout -> mark timed-out and,
 * capped at ONE substitute per slot (never chained), spawn a substitute for
 * the SAME slot from the ORIGINAL propose-time candidate pool — this is the
 * one exception the design doc itself carves out of "never re-select from a
 * post-propose pool" (F5 is about not re-WIDENING the pool on a bare
 * disconnect; F7's T+4 substitute is a documented, capped, same-pool
 * exception). Runs IN PARALLEL with any still-pending original in the other
 * slot — nothing here waits on the other slot's own wait.
 */
async function handleWakeSettle(
  ctx: PollReviewsContext,
  tracker: PollReviewTracker,
  poll: Poll,
  opts: WakeOptions,
  result: BridgeWakeResult
): Promise<void> {
  const now = ctx.now ? ctx.now() : Date.now();

  if (result.kind === 'ok') {
    const parsed = parseVerdictBlock(result.reply.text);
    markPollReviewAttached(ctx.db, opts.reviewId, {
      attachAt: now,
      rawText: result.reply.text,
      parseOk: parsed.ok,
      verdict: parsed.ok ? parsed.parsed.verdict : undefined,
    });
    if (parsed.ok && parsed.parsed.findings.length > 0) {
      insertFindings(ctx.db, opts.reviewId, parsed.parsed.findings);
    }
    persistDatabase(ctx.db, ctx.dataDir);
    broadcastReviewUpdated(ctx, loadPollReviewById(ctx.db, opts.reviewId));
    ctx.postSystemLine(poll.roomId, `→ review: @${opts.seatId} attached — ${parsed.ok ? parsed.parsed.verdict : 'unparseable'}.`);
    return;
  }

  markPollReviewTimedOut(ctx.db, opts.reviewId, now);
  persistDatabase(ctx.db, ctx.dataDir);
  broadcastReviewUpdated(ctx, loadPollReviewById(ctx.db, opts.reviewId));
  ctx.postSystemLine(poll.roomId, `→ review: @${opts.seatId} did not reply within the wake window — reviewer timed out.`);

  if (opts.substituteForReviewId != null) return; // already a substitute — cap at one per slot, no chaining

  const lanes = loadLanes(ctx.projectRoot);
  const candidates = candidatesFromAgents(ctx.agents, isAttestedManifest);
  const lastSelected = lastSelectedAtBySeat(ctx.db);
  const substitution = selectSubstitute({
    proposerId: poll.requestedBy,
    candidates,
    lanePartnerOf: (seatId) => lanePartnerOf(lanes, seatId),
    lastSelectedAt: (seatId) => lastSelected.get(seatId) ?? -Infinity,
    slot: opts.slot,
    otherSlotFamily: opts.slot === 2 ? opts.otherSlotFamily : undefined,
    originalSeatId: opts.seatId,
  });
  if (!substitution.ok) {
    ctx.postSystemLine(poll.roomId, `→ review: no substitute available for slot ${opts.slot} — ${substitution.reason}`);
    return;
  }

  markPollReviewSubstituted(ctx.db, opts.reviewId);
  persistDatabase(ctx.db, ctx.dataDir);
  broadcastReviewUpdated(ctx, loadPollReviewById(ctx.db, opts.reviewId));

  const subId = randomUUID();
  ctx.postSystemLine(poll.roomId, `→ review: substituting @${substitution.candidate.seatId} for slot ${opts.slot} (parallel wake).`);
  wakeReviewerSeat(ctx, tracker, poll, {
    reviewId: subId,
    seatId: substitution.candidate.seatId,
    slot: opts.slot,
    family: substitution.candidate.family,
    poolSize: opts.poolSize,
    policyMode: opts.policyMode,
    substituteForReviewId: opts.reviewId,
    otherSlotFamily: opts.otherSlotFamily,
  });
}

function finalizeCardDeadline(ctx: PollReviewsContext, tracker: PollReviewTracker, poll: Poll): void {
  tracker.clearCardDeadlineTimer(poll.id);
  const reviews = loadReviewsForPoll(ctx.db, poll.id);
  const pendingRows = reviews.filter((r) => r.status === 'pending');
  if (pendingRows.length === 0) return;
  const now = ctx.now ? ctx.now() : Date.now();
  for (const r of pendingRows) {
    tracker.cancel(r.id);
    tracker.clearPending(r.id, r.seatId);
    markPollReviewTimedOut(ctx.db, r.id, now);
    broadcastReviewUpdated(ctx, loadPollReviewById(ctx.db, r.id));
  }
  persistDatabase(ctx.db, ctx.dataDir);
  const finalReviews = loadReviewsForPoll(ctx.db, poll.id);
  const attachedSlots = new Set(finalReviews.filter((r) => r.status === 'attached').map((r) => r.slot)).size;
  const totalSlots = new Set(finalReviews.map((r) => r.slot)).size;
  ctx.postSystemLine(
    poll.roomId,
    `→ review: card deadline reached — ${attachedSlots}/${totalSlots} reviewer${totalSlots === 1 ? '' : 's'} attached; remaining marked timed out.`
  );
}

// ============================================================================
// Hooks — called from pollsRoutes.ts / workshopRoutes.ts / index.ts's
// agent.disconnect WS handler. Each is a thin, fire-and-forget entry point.
// ============================================================================

/**
 * Covered-action entry point (design doc "Review execution" step 1): "the
 * action itself is unchanged" — this is called AFTER the poll already exists
 * and its own response already went out; a failed/absent selection here
 * NEVER unwinds or blocks the caller (fail-open, design doc: "reviews NEVER
 * gate or extend a poll's life").
 */
export function startPollReview(ctx: PollReviewsContext, tracker: PollReviewTracker, poll: Poll, actionType: CoveredActionType): void {
  const policy = ctx.getReviewPolicy();
  if (!isActionCovered(policy.mode, actionType)) return;

  const lanes = loadLanes(ctx.projectRoot);
  const candidates = candidatesFromAgents(ctx.agents, isAttestedManifest);
  const lastSelected = lastSelectedAtBySeat(ctx.db);

  const selection = selectReviewers({
    proposerId: poll.requestedBy,
    candidates,
    lanePartnerOf: (seatId) => lanePartnerOf(lanes, seatId),
    lastSelectedAt: (seatId) => lastSelected.get(seatId) ?? -Infinity,
  });

  if (!selection.ok) {
    ctx.postSystemLine(poll.roomId, `→ review: no reviewers assigned for "${poll.question}" — ${selection.reason} (fail-open: decide as usual).`);
    console.log(`[reviews] no selection poll=${poll.id} reason=${selection.reason}`);
    return;
  }

  const policyMode: 'mutations' | 'all' = policy.mode === 'all' ? 'all' : 'mutations';
  ctx.postSystemLine(
    poll.roomId,
    `→ review: assigned @${selection.slot1.seatId} (attested) + @${selection.slot2.seatId} (${selection.slot2.family}) — pool ${selection.poolSize}.`
  );
  console.log(`[reviews] selected poll=${poll.id} slot1=${selection.slot1.seatId} slot2=${selection.slot2.seatId} pool=${selection.poolSize}`);

  wakeReviewerSeat(ctx, tracker, poll, {
    reviewId: randomUUID(),
    seatId: selection.slot1.seatId,
    slot: 1,
    family: selection.slot1.family,
    poolSize: selection.poolSize,
    policyMode,
    otherSlotFamily: selection.slot2.family,
  });
  wakeReviewerSeat(ctx, tracker, poll, {
    reviewId: randomUUID(),
    seatId: selection.slot2.seatId,
    slot: 2,
    family: selection.slot2.family,
    poolSize: selection.poolSize,
    policyMode,
    otherSlotFamily: selection.slot1.family,
  });

  const cardDeadlineMs = ctx.cardDeadlineMs ?? REVIEW_CARD_DEADLINE_MS;
  const timer = setTimeout(() => finalizeCardDeadline(ctx, tracker, poll), cardDeadlineMs);
  tracker.setCardDeadlineTimer(poll.id, timer);
}

/**
 * Poll settled (decided OR expired) — design doc: "poll expiry cancels
 * pending reviews... reviews never extend or gate a poll's life." Cancels
 * the card-deadline timer and every still-pending wait for this poll
 * (best-effort — a wake already in flight on a seat's own turn cannot be
 * interrupted mid-generation, only its OBSERVATION is cancelled), marks any
 * still-pending review rows timed-out so the ledger has no rows stuck
 * 'pending' forever, and backfills the human decision onto every row (the
 * red-override log's join key).
 */
export function onPollSettled(ctx: PollReviewsContext, tracker: PollReviewTracker, poll: Poll): void {
  tracker.clearCardDeadlineTimer(poll.id);
  const reviews = loadReviewsForPoll(ctx.db, poll.id);
  if (reviews.length === 0) return;

  const now = ctx.now ? ctx.now() : Date.now();
  for (const r of reviews) {
    if (r.status !== 'pending') continue;
    tracker.cancel(r.id);
    tracker.clearPending(r.id, r.seatId);
    markPollReviewTimedOut(ctx.db, r.id, now);
  }
  if (poll.status === 'decided' && poll.decision) {
    backfillHumanDecision(ctx.db, poll.id, poll.decision.optionId, poll.decision.decidedAt);
  }
  persistDatabase(ctx.db, ctx.dataDir);
  for (const r of loadReviewsForPoll(ctx.db, poll.id)) broadcastReviewUpdated(ctx, r);
}

/**
 * Disconnect-mid-review (design doc F5, acceptance: "disconnect-mid-review =
 * timeout, logged, no re-selection"). Marks every review this seat currently
 * has 'pending' as timed-out IMMEDIATELY (rather than waiting out the full
 * 4-min wake window) and cancels the underlying wait — deliberately does
 * NOT spawn a substitute from this path (only the T+4 wake-timeout path
 * does that, capped at one, from handleWakeSettle above): re-selecting in
 * direct reaction to a disconnect is exactly the anti-gaming hole F5 closes
 * (a seat could disconnect the instant it's picked, hoping for a friendlier
 * re-roll). If a substitute is still warranted, the cancelled wait would
 * have timed out on its own shortly anyway — but since we cancel it here,
 * the caller (index.ts's agent.disconnect handler) is the only place a
 * disconnect-triggered review outcome is decided, and it decides "timed out,
 * nothing more."
 */
export function onSeatDisconnected(ctx: PollReviewsContext, tracker: PollReviewTracker, seatId: string): void {
  const reviewIds = tracker.pendingReviewIdsForSeat(seatId);
  if (reviewIds.length === 0) return;
  const now = ctx.now ? ctx.now() : Date.now();
  for (const reviewId of reviewIds) {
    tracker.cancel(reviewId);
    tracker.clearPending(reviewId, seatId);
    markPollReviewTimedOut(ctx.db, reviewId, now);
    persistDatabase(ctx.db, ctx.dataDir);
    const review = loadPollReviewById(ctx.db, reviewId);
    broadcastReviewUpdated(ctx, review);
    console.log(`[reviews] seat disconnected mid-review seat=${seatId} review=${reviewId} poll=${review?.pollId ?? '?'}`);
    const poll = review ? ctx.getPoll(review.pollId) : undefined;
    if (poll) ctx.postSystemLine(poll.roomId, `→ review: @${seatId} disconnected mid-review — reviewer went away, no re-selection.`);
  }
}

// ============================================================================
// REST routes
// ============================================================================

export interface PollReviewRouteContext extends PollReviewsContext {
  getPollsState: () => PollsState;
}

/**
 * GET/POST /api/review-policy (design doc "Config" knob) + per-finding
 * valid/invalid toggle + digest + reviews-by-poll read. Loopback trust for
 * every route EXCEPT the POST toggle, which additionally requires
 * `body.humanToken` to match — same "mutating human-op" gate as poll.decide
 * (design doc B2 acceptance list).
 */
export function registerPollReviewRoutes(fastify: FastifyInstance, ctx: PollReviewRouteContext): void {
  fastify.get('/api/review-policy', async () => ctx.getReviewPolicy());

  fastify.post<{ Body: Record<string, unknown> }>('/api/review-policy', async (req, reply) => {
    const body = req.body ?? {};
    if (!isValidHumanToken(ctx.humanToken, body.humanToken)) {
      reply.code(401);
      return { error: HUMAN_TOKEN_REQUIRED_ERROR };
    }
    const mode = body.mode;
    if (mode !== 'off' && mode !== 'mutations' && mode !== 'all') {
      reply.code(400);
      return { error: "mode must be 'off' | 'mutations' | 'all'." };
    }
    const state: ReviewPolicyState = { mode: mode as ReviewPolicyMode };
    ctx.setReviewPolicy(state);
    saveReviewPolicy(ctx.dataDir, state);
    ctx.broadcast({ type: 'review.policy.status', payload: state } as unknown as ServerEvent);
    console.log(`[reviews] policy mode -> ${state.mode}`);
    return state;
  });

  fastify.post<{ Params: { reviewId: string; idx: string }; Body: Record<string, unknown> }>(
    '/api/poll-reviews/:reviewId/findings/:idx',
    async (req, reply) => {
      const reviewId = req.params.reviewId;
      const idx = Number(req.params.idx);
      if (!Number.isInteger(idx) || idx < 0) {
        reply.code(400);
        return { error: 'idx must be a non-negative integer.' };
      }
      const body = req.body ?? {};
      const valid = body.valid === true ? true : body.valid === false ? false : body.valid === null ? null : undefined;
      if (valid === undefined) {
        reply.code(400);
        return { error: 'valid must be true, false, or null (unmark).' };
      }
      const existing = loadPollReviewById(ctx.db, reviewId);
      if (!existing) {
        reply.code(404);
        return { error: 'Review not found.' };
      }
      setFindingValidity(ctx.db, reviewId, idx, valid);
      persistDatabase(ctx.db, ctx.dataDir);
      const updated = loadPollReviewById(ctx.db, reviewId);
      broadcastReviewUpdated(ctx, updated);
      return updated;
    }
  );

  fastify.get('/api/poll-reviews/digest', async (): Promise<ReviewDigest> => computeReviewDigest(ctx.db));

  fastify.get<{ Querystring: { pollId?: string } }>('/api/poll-reviews', async (req) => {
    if (req.query.pollId) return loadReviewsForPoll(ctx.db, req.query.pollId);
    const pollIds = pollsForStateSync(ctx.getPollsState()).map((p) => p.id);
    return loadReviewsForPolls(ctx.db, pollIds);
  });
}

/** state.sync's additive `pollReviews` hydration slice — same windowing as pollsForStateSync (open polls + last 20 settled) so a fresh tab sees review state for exactly the polls it also sees. */
export function pollReviewsForStateSync(db: SqlDatabase, pollsState: PollsState): PollReview[] {
  const pollIds = pollsForStateSync(pollsState).map((p) => p.id);
  return loadReviewsForPolls(db, pollIds);
}
