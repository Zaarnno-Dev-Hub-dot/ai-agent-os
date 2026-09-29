/**
 * Paperclip bridge wake:
 * "post as seat + await that seat's next turn" gateway seam. Pure, testable
 * module — the HTTP route + wiring into relay.ts's exported functions lives
 * in index.ts (same split as loop.ts/router.ts: this file owns state +
 * decision logic, index.ts owns the Fastify route and the broadcast()
 * observation hook).
 *
 * Reuses the SAME broadcast/observation seam loop-lite's driver already uses
 * (a `message.new` branch inside index.ts's existing broadcast() wrapper) —
 * not a new listener infrastructure, and no relay.ts internals. Delivery to
 * the seat still goes through relay.ts's own exported, unmodified
 * relayMessageToAgents, so per-turn budget/cost enforcement (commitAgentReply/
 * recordUsage) applies exactly as it does for any other relay turn.
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentState, Message, Room } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';
import { relayMessageToAgents } from './relay.js';
import { insertMessage, persistDatabase } from './db.js';
import type { LoopsConfig } from './loop.js';

/** Bridge sender id — a non-agent/system sender, same class as 'system' (postSystemLine), never registered in the `agents` map. */
export const BRIDGE_SENDER_ID = 'paperclip-bridge';

export const DEFAULT_TIMEOUT_MS = 570_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Clamp a caller-supplied timeoutMs into (0, MAX_TIMEOUT_MS], defaulting when absent/invalid. */
export function resolveTimeoutMs(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TIMEOUT_MS);
}

export interface BridgeReply {
  messageId: string;
  text: string;
  senderId: string;
  ts: number;
  /**
   * B7: the id of the message this
   * reply answers, now stamped by relay.ts's commitAgentReply on every seat
   * reply. This is the correlation key observe() matches waits on —
   * undefined only for replies from a build predating this change (never
   * matches any wait, same as before).
   */
  replyTo?: string;
}

export type BridgeWakeResult =
  | { kind: 'ok'; reply: BridgeReply; roomId: string }
  | { kind: 'timeout'; roomId: string };

/**
 * One in-flight or completed wake call, keyed by idempotencyKey.
 * `resultPromise` is what a replay-while-in-flight attaches to; `result` is
 * populated once settled so a replay-after-completion can return it directly
 * without re-registering an observer.
 */
interface IdempotencyEntry {
  resultPromise: Promise<BridgeWakeResult>;
  result?: BridgeWakeResult;
  createdAt: number;
}

/**
 * Process-lifetime-only idempotency store: an in-memory Map, FIFO-evicted at
 * N=200. NOT persisted — a gateway restart forgets every in-flight/completed
 * key, same as every other in-memory-only piece of relay state (busySeats,
 * roomRelay before boot rehydration). Callers that need replay-safety across
 * a restart must supply a fresh idempotencyKey after one.
 */
export class BridgeIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  get(key: string): IdempotencyEntry | undefined {
    return this.entries.get(key);
  }

  /** Register a new in-flight entry. Evicts the oldest entry (insertion order) if at capacity. */
  start(key: string, resultPromise: Promise<BridgeWakeResult>): IdempotencyEntry {
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    const entry: IdempotencyEntry = { resultPromise, createdAt: Date.now() };
    this.entries.set(key, entry);
    return entry;
  }

  /** Mark an entry's result once the wait settles, so future replays after completion don't need to re-attach. */
  settle(key: string, result: BridgeWakeResult): void {
    const entry = this.entries.get(key);
    if (entry) entry.result = result;
  }

  size(): number {
    return this.entries.size;
  }
}

/** One pending long-poll wait for a specific bridge wake, correlated by the triggering message's id. */
interface PendingWait {
  roomId: string;
  seatId: string;
  /** The bridge message's own id (the `source.id` relayMessageToAgents was called with) — the correlation key. */
  triggerMessageId: string;
  resolve: (result: BridgeWakeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Registry of in-flight waits, observed via index.ts's broadcast() hook. A
 * `message.new` whose `replyTo` matches a pending wait's triggering message
 * id resolves it — this is the "await that seat's next turn" half of the
 * seam. Mention-gating itself (waking ONLY that seat) is enforced at POST
 * time by relayMessageToAgents' own mention resolution (see index.ts's
 * wiring); this registry only observes the REPLY side.
 *
 * B7: correlation is now by `replyTo`, not sender-identity +
 * single-flight. relay.ts's commitAgentReply stamps `replyTo` = the id of
 * the message that triggered a seat's turn on EVERY reply, so the bridge
 * message's own id (passed into register() as `triggerMessageId`) is exactly
 * what a genuine answer to THIS wake carries back. This closes the two
 * residual holes the old sender-identity contract had (wave6 verify /
 * fix/bridge-wake-single-flight @ 21e9dcc):
 *   1. a seat reply triggered by a NON-bridge mention in the same room
 *      during the wait window has `replyTo` pointing at THAT mention, never
 *      at this wait's triggerMessageId — it no longer resolves this wait.
 *   2. a late reply landing after this wait already timed out — even if a
 *      NEW wake for the same seat+room started in the interim — carries the
 *      OLD triggerMessageId, which cannot match the new wait's (a fresh
 *      bridge message id per wake); it resolves nothing, exactly as if no
 *      wait were pending, rather than mis-resolving the new one.
 * Because correlation no longer depends on "at most one wait per seat+room",
 * the single-flight 409 guard (`hasPending`, formerly enforced by the route)
 * is REMOVED: multiple concurrent wakes to the same (roomId, seatId) each
 * register with their own distinct triggerMessageId and settle independently
 * off whichever reply actually names them.
 */
export class BridgeWaitRegistry {
  private readonly waits = new Set<PendingWait>();

  /** Register a wait; resolves via observe() on a reply whose replyTo names `triggerMessageId`, or via the returned cancel's timeout path. */
  register(
    roomId: string,
    seatId: string,
    timeoutMs: number,
    onSettle: (result: BridgeWakeResult) => void,
    triggerMessageId: string
  ): () => void {
    const wait: PendingWait = {
      roomId,
      seatId,
      triggerMessageId,
      resolve: onSettle,
      timer: setTimeout(() => {
        this.waits.delete(wait);
        onSettle({ kind: 'timeout', roomId });
      }, timeoutMs),
    };
    this.waits.add(wait);
    return () => {
      clearTimeout(wait.timer);
      this.waits.delete(wait);
    };
  }

  /**
   * Called from index.ts's broadcast() for every message.new. Resolves (and
   * removes) the pending wait whose triggerMessageId matches this reply's
   * `replyTo` (also checked against room+seat as a belt-and-braces integrity
   * check — see class doc comment) — stops observing immediately (no
   * dangling listeners past the first matching reply). A reply with no
   * `replyTo` (pre-B7 build, or a message that never went through
   * commitAgentReply) cannot match anything and is correctly ignored.
   */
  observe(roomId: string, senderId: string, reply: BridgeReply): void {
    if (!reply.replyTo) return;
    for (const wait of this.waits) {
      if (wait.triggerMessageId === reply.replyTo && wait.roomId === roomId && wait.seatId === senderId) {
        clearTimeout(wait.timer);
        this.waits.delete(wait);
        wait.resolve({ kind: 'ok', reply, roomId });
        return;
      }
    }
  }

  /** True when at least one wait is pending for this (roomId, seatId). Diagnostic only post-B7 — no longer gates the route (single-flight removed). */
  hasPending(roomId: string, seatId: string): boolean {
    for (const wait of this.waits) {
      if (wait.roomId === roomId && wait.seatId === seatId) return true;
    }
    return false;
  }

  /** Count of active waits — exposed for tests (mention-gating: a second seat's reply must not resolve anyone's wait). */
  pendingCount(): number {
    return this.waits.size;
  }
}

/** `Paperclip — <seatId>` — the exact, reused-by-name room the bridge finds-or-creates per seat. */
export function paperclipRoomName(seatId: string): string {
  return `Paperclip — ${seatId}`;
}

/**
 * Mirror of relay.ts's mention scanning (parseMentionsFromContent pattern +
 * MENTION_ALIASES) — relay.ts is frozen this wave, so the constants are
 * duplicated here. KEEP IN SYNC with relay.ts:397/425; the mention-injection
 * regression test in bridge.test.ts exercises the real relay parser end-to-end
 * and will catch drift.
 */
const PROMPT_MENTION_PATTERN = /@([a-z0-9_#-]+)/gi;
const PROMPT_MENTION_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  grok: 'grok-build',
  chatgpt: 'codex',
  all: 'everyone',
};

/**
 * Neutralize every @mention in the caller-supplied prompt that does not
 * resolve to the TARGET seat, by inserting a zero-width space (U+200B)
 * between '@' and the id — invisible in the UI and harmless to the seat's
 * LLM, but no longer a match for relay.ts's content-based mention scanner.
 * Without this, a prompt like "coordinate with @grok-build" would wake the
 * bystander seat too (prompt-injection / mention-gating bypass — review
 * finding, wave3/f2a). Neutralization is unconditional (not limited to
 * currently-verified seats): aliases, @everyone/@all, and seats that verify
 * later are all covered.
 */
export function sanitizePromptMentions(prompt: string, targetSeatId: string): string {
  const target = targetSeatId.toLowerCase();
  return prompt.replace(PROMPT_MENTION_PATTERN, (full: string, id: string) => {
    const normalized = PROMPT_MENTION_ALIASES[id.toLowerCase()] ?? id.toLowerCase();
    return normalized === target ? full : `@\u200b${id}`;
  });
}

/** Build the persisted+broadcast bridge message: content is prefixed with an explicit @<seatId> mention so relay.ts's own mention resolution (via the delivery clone index.ts builds) wakes only that seat. The prompt body is mention-sanitized first — only the bridge's own prefix (and redundant @target mentions) survive as live mentions. */
export function buildBridgeMessageContent(seatId: string, prompt: string): string {
  return `@${seatId} ${sanitizePromptMentions(prompt, seatId)}`;
}

export function newBridgeMessageId(): string {
  return randomUUID();
}

/**
 * Context the route needs from index.ts — the same live maps/closures every
 * other route/handler in index.ts already reads, threaded explicitly instead
 * of via module-scoped globals so the route is unit-testable against a
 * throwaway Fastify instance + fake deps (no full gateway boot required).
 */
export interface BridgeRouteContext {
  relayDeps: RelayDeps;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  db: RelayDeps['db'];
  dataDir: string;
  defaultRoomTurnCap: number;
  loopsConfig: LoopsConfig;
  idempotency: BridgeIdempotencyStore;
  waits: BridgeWaitRegistry;
  broadcast: RelayDeps['broadcast'];
  /** Same busySeats bookkeeping every other relay-triggering route/handler in index.ts updates. */
  markBusy: (agentIds: Iterable<string>) => void;
  /** Persist a room mutation + broadcast a fresh state.sync — same helper index.ts's other room.* handlers use. */
  persistRoomMutation: (room: Room) => void;
}

/**
 * Register `POST /api/bridge/wake` on an existing Fastify instance. See the module doc
 * comment for why delivery uses relayMessageToAgents (not onRoomChatMessage)
 * and why the delivery-only clone below uses senderId: 'human'.
 */
export function registerBridgeRoute(fastify: FastifyInstance, ctx: BridgeRouteContext): void {
  fastify.post<{ Body: Record<string, unknown> }>('/api/bridge/wake', async (req, reply) => {
    const body = req.body ?? {};
    const seatId = typeof body.seatId === 'string' ? body.seatId : undefined;
    const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    const requestedRoomId = typeof body.roomId === 'string' ? body.roomId : undefined;
    const timeoutMs = resolveTimeoutMs(body.timeoutMs);

    if (!seatId || !prompt || !idempotencyKey) {
      reply.code(400);
      return { error: 'seatId, prompt, and idempotencyKey are required.' };
    }

    // Idempotency: a replay while in-flight attaches to the SAME wait; a
    // replay after completion returns the stored result. Process-lifetime
    // only (doc comment above) — never persisted across a restart.
    const existing = ctx.idempotency.get(idempotencyKey);
    if (existing) {
      const result = existing.result ?? (await existing.resultPromise);
      return sendBridgeResult(reply, result);
    }

    const seat = ctx.agents.get(seatId);
    if (!seat || seat.status !== 'VERIFIED') {
      reply.code(404);
      return { error: 'seat_unverified' };
    }

    let room = requestedRoomId ? ctx.rooms.get(requestedRoomId) : undefined;
    if (requestedRoomId) {
      if (!room || room.archivedAt != null) {
        reply.code(400);
        return { error: 'Room not found.' };
      }
      if (!room.memberIds.includes(seatId)) {
        reply.code(400);
        return { error: `${seatId} is not a member of room ${requestedRoomId}.` };
      }
    } else {
      // Find-or-create by exact name, reused on later wakes (contract: "Paperclip — <seatId>").
      const wantedName = paperclipRoomName(seatId);
      room = Array.from(ctx.rooms.values()).find((r) => r.name === wantedName && r.archivedAt == null);
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
        // Reused-by-name room that somehow lost the seat — restore membership
        // rather than fail; same repair spirit as room.members full-replacement.
        room = { ...room, memberIds: [...room.memberIds, seatId], updatedAt: Date.now() };
        ctx.persistRoomMutation(room);
      }
    }
    const roomId = room.id;

    // Room guards (contract): an active loop on this room rejects the wake
    // outright rather than interleaving with loop-lite's own turn-taking.
    const loop = ctx.loopsConfig[roomId];
    if (loop?.active) {
      reply.code(409);
      return { error: 'Room has an active loop.' };
    }

    // B7 (2026-07-21, single-flight removed — see BridgeWaitRegistry's class
    // doc comment): concurrent wakes to the same (roomId, seatId) are no
    // longer rejected. Each gets its own bridge message id up front, used
    // BOTH as this wait's correlation key AND as the persisted message's own
    // id, so the eventual reply (whose replyTo relay.ts's commitAgentReply
    // stamps to this exact id) can only settle THIS wait. A replay of the
    // SAME wake (same idempotencyKey) still attaches via the idempotency
    // check above and never reaches this point.
    const bridgeMessageId = newBridgeMessageId();
    const waitPromise = new Promise<BridgeWakeResult>((resolve) => {
      ctx.waits.register(roomId, seatId, timeoutMs, resolve, bridgeMessageId);
    });
    ctx.idempotency.start(idempotencyKey, waitPromise);
    void waitPromise.then((result) => ctx.idempotency.settle(idempotencyKey, result));

    // Persist + broadcast the bridge message with its honest sender id — same
    // insert/broadcast shape chat.send/postSystemLine already use.
    const msg: Message = {
      id: bridgeMessageId,
      roomId,
      senderId: BRIDGE_SENDER_ID,
      content: buildBridgeMessageContent(seatId, prompt),
      mentions: [seatId],
      createdAt: Date.now(),
    };
    insertMessage(ctx.db, msg);
    persistDatabase(ctx.db, ctx.dataDir);
    const list = ctx.messages.get(roomId) ?? [];
    list.push(msg);
    ctx.messages.set(roomId, list);
    ctx.broadcast({ type: 'message.new', payload: msg });

    // Deliver to ONLY the addressed seat: a delivery-only clone (never
    // persisted) with senderId: 'human' so relay.ts's frozen resolveRelayTargets
    // honors the explicit @seatId mention — see the module doc comment for why
    // this is safe reuse, not a relay.ts edit. A second seat in the room is
    // never included: resolveRelayTargets' specific-mentions branch only
    // returns ids that are BOTH mentioned AND verified-in-room.
    ctx.markBusy([seatId]);
    relayMessageToAgents(ctx.relayDeps, roomId, { ...msg, senderId: 'human', mentions: [seatId] });

    const result = await waitPromise;
    return sendBridgeResult(reply, result);
  });
}

function sendBridgeResult(
  reply: { code: (n: number) => unknown },
  res: BridgeWakeResult
): { timedOut: true; roomId: string } | { reply: BridgeReply; roomId: string } {
  if (res.kind === 'timeout') {
    reply.code(408);
    return { timedOut: true, roomId: res.roomId };
  }
  return { reply: res.reply, roomId: res.roomId };
}
