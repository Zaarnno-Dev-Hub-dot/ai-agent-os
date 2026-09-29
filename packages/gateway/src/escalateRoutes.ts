/**
 * POST /api/escalate. REST,
 * loopback trust model — same convention as POST /api/bridge/wake and POST
 * /api/polls ("the gateway binds 127.0.0.1 and trusts local callers; this
 * endpoint invents no new auth system"). Pulled into its own module — same
 * split as bridge.ts/pollsRoutes.ts: this file owns the guard/decision logic
 * against an explicitly-threaded context (unit-testable against a throwaway
 * Fastify instance + fake deps, no full gateway boot required), index.ts
 * owns wiring it to the live maps/closures.
 *
 * Mechanics: (1) post the escalation as a system line into an
 * "Urgent" room (create-once by name — the room IS the audit log), (2)
 * unless suppressed by quiet hours, bridge-wake the hermes seat with a fixed
 * SMS-skill-triggering template and await its next turn — REUSING bridge.ts's
 * BridgeWaitRegistry/buildBridgeMessageContent/newBridgeMessageId (the exact
 * same "post a message addressed to one seat, deliver via relay.ts's
 * unmodified relayMessageToAgents, observe its next message.new reply" seam
 * registerBridgeRoute already uses — not a new mechanism), (3) record the
 * wake outcome as a second system line. No packages/shared or relay.ts edits:
 * this reuses relay.ts's exported relayMessageToAgents exactly like
 * pollsRoutes.ts's notifyPollSettled already does, and the escalation store
 * (escalations.ts) is additive-only, gateway-local JSON state.
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentState, Message, Room } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';
import { relayMessageToAgents } from './relay.js';
import { insertMessage, persistDatabase } from './db.js';
import { buildBridgeMessageContent, newBridgeMessageId, type BridgeWaitRegistry, type BridgeWakeResult } from './bridge.js';
import {
  finalizeEscalationOutcome,
  isQuietHours,
  quietHoursOptionsFromEnv,
  reserveEscalation,
  secretGuard,
  type EscalationRecord,
  type EscalationSeverity,
} from './escalations.js';

/** `Urgent` — the exact, reused-by-name room the escalate route finds-or-creates. */
export const URGENT_ROOM_NAME = 'Urgent';

/** The one seat this feature ever wakes — the original design is specifically "use Hermes as the go-between" (laptop Hermes has the live phone/SMS skill). */
export const ESCALATE_TARGET_SEAT_ID = 'hermes';

/** Non-agent sender for the wake message, same class as bridge.ts's BRIDGE_SENDER_ID / pollsRoutes.ts's POLL_SYSTEM_SENDER_ID — never registered in the `agents` map. */
export const ESCALATE_SENDER_ID = 'escalate-system';

/**
 * How long to wait for hermes's reply before recording the wake as
 * 'failed'. Deliberately much shorter than bridge.ts's own
 * DEFAULT_TIMEOUT_MS (570s, sized for open-ended coding turns) — an SMS
 * trigger + acknowledgement should be fast; a stuck hermes seat shouldn't
 * hold an urgent escalation's HTTP response open for 9.5 minutes.
 */
export const ESCALATE_WAKE_TIMEOUT_MS = 120_000;

/** SMS body cap from the original design's fixed template: "<body ≤240 chars>". */
export const SMS_BODY_MAX_LEN = 240;

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, Math.max(0, maxLen - 1))}…` : trimmed;
}

/**
 * Context the route needs from index.ts — the same live maps/closures every
 * other route/handler in index.ts already reads, threaded explicitly instead
 * of via module-scoped globals (bridge.ts's BridgeRouteContext / pollsRoutes.ts's
 * PollsRouteContext precedent).
 */
export interface EscalateRouteContext {
  relayDeps: RelayDeps;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  db: RelayDeps['db'];
  dataDir: string;
  defaultRoomTurnCap: number;
  broadcast: RelayDeps['broadcast'];
  markBusy: (agentIds: Iterable<string>) => void;
  /** Persisted, broadcast system-line helper — index.ts's own postSystemLine. */
  postSystemLine: (roomId: string, content: string) => void;
  /** Persist a room mutation + broadcast a fresh state.sync — same helper index.ts's other room.* handlers use. */
  persistRoomMutation: (room: Room) => void;
  /** The SAME BridgeWaitRegistry instance index.ts's broadcast() hook already observes message.new against for bridge.ts's own route — reused, not duplicated (its observe() is generic over any (roomId, seatId) pair). */
  waits: BridgeWaitRegistry;
  /** Injectable clock — tests only; production callers omit this (defaults to Date.now()). */
  now?: () => number;
  /** Injectable wake timeout — tests only; production callers omit this (defaults to ESCALATE_WAKE_TIMEOUT_MS). */
  wakeTimeoutMs?: number;
}

/** Find-or-create the "Urgent" room by exact name, same repair-membership spirit as bridge.ts's paperclipRoomName room. */
function findOrCreateUrgentRoom(ctx: EscalateRouteContext): Room {
  let room = Array.from(ctx.rooms.values()).find((r) => r.name === URGENT_ROOM_NAME && r.archivedAt == null);
  if (!room) {
    room = {
      id: randomUUID(),
      name: URGENT_ROOM_NAME,
      type: 'group',
      memberIds: [ESCALATE_TARGET_SEAT_ID],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCap: ctx.defaultRoomTurnCap,
    };
    ctx.persistRoomMutation(room);
  } else if (!room.memberIds.includes(ESCALATE_TARGET_SEAT_ID)) {
    room = { ...room, memberIds: [...room.memberIds, ESCALATE_TARGET_SEAT_ID], updatedAt: Date.now() };
    ctx.persistRoomMutation(room);
  }
  return room;
}

/**
 * Posts the fixed SMS-skill-triggering prompt addressed to hermes and awaits
 * its next reply in `roomId` — the exact same "persist+broadcast a message,
 * mark busy, deliver via relay.ts's unmodified relayMessageToAgents, observe
 * the next message.new via BridgeWaitRegistry" sequence as bridge.ts's
 * registerBridgeRoute, minus the idempotency-key replay machinery (not
 * needed here: escalate has its own, separate rate limiter, and each call
 * is a fresh escalation, never a replay of a prior one).
 */
function wakeHermes(ctx: EscalateRouteContext, roomId: string, prompt: string): Promise<BridgeWakeResult> {
  const timeoutMs = ctx.wakeTimeoutMs ?? ESCALATE_WAKE_TIMEOUT_MS;
  return new Promise((resolve) => {
    // B7: register with this wake's OWN message id up front — relay.ts's
    // commitAgentReply stamps that id as `replyTo` on hermes's reply, which
    // is what BridgeWaitRegistry.observe() now correlates against (see
    // bridge.ts's class doc comment).
    const bridgeMessageId = newBridgeMessageId();
    ctx.waits.register(roomId, ESCALATE_TARGET_SEAT_ID, timeoutMs, resolve, bridgeMessageId);

    const msg: Message = {
      id: bridgeMessageId,
      roomId,
      senderId: ESCALATE_SENDER_ID,
      // buildBridgeMessageContent neutralizes any OTHER @mentions embedded in
      // the prompt (a title/body a caller supplied) before prefixing the
      // real @hermes address — same mention-injection guard bridge.ts's own
      // route relies on (a stray "@grok-build" inside an escalation body
      // must never wake a bystander seat).
      content: buildBridgeMessageContent(ESCALATE_TARGET_SEAT_ID, prompt),
      mentions: [ESCALATE_TARGET_SEAT_ID],
      createdAt: Date.now(),
    };
    insertMessage(ctx.db, msg);
    persistDatabase(ctx.db, ctx.dataDir);
    const list = ctx.messages.get(roomId) ?? [];
    list.push(msg);
    ctx.messages.set(roomId, list);
    ctx.broadcast({ type: 'message.new', payload: msg });

    // Delivery-only clone (never persisted), senderId 'human' — identical
    // reasoning to bridge.ts/pollsRoutes.ts: relay.ts's frozen
    // resolveRelayTargets only honors an explicit @mention from a
    // non-agent-looking sender for its specific-mentions branch.
    ctx.markBusy([ESCALATE_TARGET_SEAT_ID]);
    relayMessageToAgents(ctx.relayDeps, roomId, { ...msg, senderId: 'human', mentions: [ESCALATE_TARGET_SEAT_ID] });
  });
}

export function registerEscalateRoute(fastify: FastifyInstance, ctx: EscalateRouteContext): void {
  fastify.post<{ Body: Record<string, unknown> }>('/api/escalate', async (req, reply) => {
    const now = ctx.now ? ctx.now() : Date.now();
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const bodyText = typeof body.body === 'string' ? body.body.trim() : '';
    const severity: EscalationSeverity | undefined =
      body.severity === 'critical' ? 'critical' : body.severity === 'high' ? 'high' : undefined;

    if (!title || !bodyText || !severity) {
      reply.code(400);
      return { error: "title, body, and severity ('high'|'critical') are required." };
    }

    // Secret guard. Checked BEFORE the rate limiter
    // and BEFORE anything is persisted or posted anywhere — a rejected
    // escalation leaves no trace of the offending content, and does not
    // consume any of the 3/day cap.
    const titleGuard = secretGuard(title);
    const bodyGuard = secretGuard(bodyText);
    const guardFailure = !titleGuard.ok ? titleGuard : !bodyGuard.ok ? bodyGuard : undefined;
    if (guardFailure) {
      reply.code(400);
      return { error: 'secret-detected', reason: guardFailure.reason };
    }

    // Reserve BEFORE the (up to ESCALATE_WAKE_TIMEOUT_MS-long) bridge-wake
    // await further down — reserveEscalation atomically loads the CURRENT
    // file, checks the rate limit against it, and persists this record's
    // slot before returning, so a concurrent caller's own reserve (queued
    // behind this one) always sees it counted. Doing the load+check+save
    // AFTER the await (the pre-fix shape) let every concurrent caller check
    // against the same stale pre-wake snapshot — see escalations.ts's
    // "Concurrency" section for the full bug writeup. smsOutcome starts as
    // 'pending' and is corrected by finalizeEscalationOutcome below in every
    // branch before the HTTP response is ever sent — a caller never
    // observes 'pending'.
    const record: EscalationRecord = {
      id: randomUUID(),
      ts: now,
      severity,
      title,
      bodyPreview: truncate(bodyText, 500),
      smsOutcome: 'pending',
    };
    const rateLimit = await reserveEscalation(ctx.dataDir, now, severity, record);
    if (!rateLimit.allowed) {
      reply.code(429);
      reply.header('Retry-After', String(Math.ceil(rateLimit.retryAfterMs / 1000)));
      return { error: 'rate-limited', reason: rateLimit.reason, retryAfterMs: rateLimit.retryAfterMs };
    }

    const quiet = isQuietHours(new Date(now), quietHoursOptionsFromEnv());
    const suppressSms = quiet && severity !== 'critical';

    const room = findOrCreateUrgentRoom(ctx);

    // (1) the escalation itself, as a system line — this always happens,
    // even when the SMS side is suppressed/fails: the room IS the audit log.
    ctx.postSystemLine(room.id, `⚠ ESCALATION [${severity}] ${title} — ${bodyText}`);

    let smsOutcome: EscalationRecord['smsOutcome'];
    if (suppressSms) {
      smsOutcome = 'skipped-quiet-hours';
      ctx.postSystemLine(
        room.id,
        '→ escalate: quiet hours (00:00–08:00 local) — queued to this room only, no SMS attempt (severity was \'high\'; \'critical\' always sends).'
      );
    } else {
      const seat = ctx.agents.get(ESCALATE_TARGET_SEAT_ID);
      if (!seat || seat.status !== 'VERIFIED') {
        smsOutcome = 'failed';
        ctx.postSystemLine(room.id, `→ escalate: the ${ESCALATE_TARGET_SEAT_ID} seat is not VERIFIED — could not wake it for SMS.`);
      } else {
        // Wave 7 M2 proved
        // hermes's *chat reply* to a bare wake is not evidence a real text
        // went out: twice now (Wave 6 smoke, Wave 7 M2 retest) it replied
        // "Acknowledged, standing by" with zero (or one wrong-guess) tool
        // calls — the wake carried no explicit tool imperative, so the model
        // had to infer "use your SMS skill" from a plain notification and
        // didn't reliably do it. Fix (defense in depth alongside the
        // hermes-side skill instruction): put the actual tool-call
        // imperative, with the CORRECT target, directly in the wake message
        // content itself — this is the text hermes demonstrably does read
        // (it quoted title/body verbatim both prior times). Target is
        // 'photon' (the connected Photon iMessage bridge — confirmed live
        // via hermes gateway.log's "[photon] connected" lines and
        // PHOTON_HOME_CHANNEL/PHOTON_PROJECT_ID/PHOTON_ALLOWED_USERS all
        // present in hermes's .env), NOT 'sms' — Wave 7 M2's own patch named
        // the wrong platform (Twilio SMS was never configured and isn't the
        // live carrier; Photon is).
        const escalationBody = `${title} — ${truncate(bodyText, SMS_BODY_MAX_LEN)}`;
        const smsTemplate =
          `[AgentOS URGENT] ${escalationBody} (see Urgent room). ` +
          `ACTION REQUIRED before you reply: call send_message(action='send', target='photon', message='${escalationBody}') now — ` +
          `target is 'photon' (the connected iMessage bridge), NOT 'sms'. Report the real tool outcome in your reply, not a bare acknowledgment.`;
        const result = await wakeHermes(ctx, room.id, smsTemplate);
        if (result.kind === 'ok') {
          smsOutcome = 'sent';
          ctx.postSystemLine(room.id, `→ escalate: ${ESCALATE_TARGET_SEAT_ID} replied — "${truncate(result.reply.text, 200)}"`);
        } else {
          smsOutcome = 'failed';
          ctx.postSystemLine(
            room.id,
            `→ escalate: ${ESCALATE_TARGET_SEAT_ID} did not reply within ${Math.round((ctx.wakeTimeoutMs ?? ESCALATE_WAKE_TIMEOUT_MS) / 1000)}s — SMS delivery unconfirmed.`
          );
        }
      }
    }

    // Finalize the reservation above with the real outcome — atomically
    // re-reads the current file rather than reusing any pre-await snapshot,
    // so this can never clobber another concurrent call's own reserve/
    // finalize (see escalations.ts's finalizeEscalationOutcome).
    await finalizeEscalationOutcome(ctx.dataDir, record.id, smsOutcome);

    reply.code(200);
    return { id: record.id, roomId: room.id, smsOutcome };
  });
}
