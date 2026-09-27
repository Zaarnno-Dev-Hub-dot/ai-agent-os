/**
 * Per-agent chat relay: serialized send queue, session.events() consumer,
 * turn-cap enforcement, cost + typing side effects.
 */

import { randomUUID } from 'crypto';
import type {
  AgentEvent,
  AgentSession,
  AgentState,
  CostEvent,
  CostReport,
  Message,
  OutboundMessage,
  Room,
  ServerEvent,
} from '@agent-os/shared';
import type { SqlDatabase } from './db.js';
import { insertCostEvent, insertMessage, persistDatabase, saveRoom } from './db.js';
import { estimateCostUsd, modelTierFromBilling } from './cost.js';
import { copyAttachmentForAgent, getAttachment } from './files.js';
import {
  applyRoomTokenUsage,
  maybeResumeFromTokenPause,
  turnTokenBudgetBreach,
  turnTokenBudgetErrorEvent,
} from './budgets.js';
import { relayWindowMaxMessages } from './gatewayLocalConfig.js';
import { composeWindowedOutbound } from './relayWindow.js';
import { buildPinnedContextBlock, withPinnedContext } from './memory.js';

/**
 * CLI harnesses get a filesystem hand-off (copy into the agent's own
 * workspace, per docs/DESIGN-attachments.md); http/ws harnesses keep the
 * existing url field with no filesystem hand-off.
 */
const CLI_HARNESSES = new Set(['claude-code', 'grok-build']);

/**
 * Watchdog for an in-flight relay turn: if the agent session emits neither
 * message-complete nor error within this window (hung CLI process, wedged
 * stream), the turn is failed so the agent's queue can advance
 * (relay smoke review, finding 2).
 */
const TURN_WATCHDOG_MS = 8 * 60 * 1000;

export interface RoomRelayState {
  /** Consecutive agent-authored messages since the last human message. */
  agentTurnsSinceHuman: number;
  /** Turn cap hit — no auto relay to agents until human speaks. */
  paused: boolean;
  /**
   * Room token-budget state (docs/DESIGN-token-budgets.md). Mirrors the turn
   * cap's paused/resume shape but is tracked separately: gateway-local only,
   * not persisted (rebuilt from cost_events at boot — see db.ts
   * recomputeCostTotals). Owned/mutated by budgets.ts; enforcement sites
   * (commitAgentReply, recordUsage, relayMessageToAgents) just read it.
   */
  tokensUsed: number;
  /** Token budget hit — no auto relay to agents until a human message grants the one-time extension. */
  tokenPaused: boolean;
  /** The one-time +25% resume extension (docs spec) has already been granted for the current budget. */
  tokenExtensionUsed: boolean;
  /** Last percent (80 or 100) a budget.warning/exceeded was broadcast for, so we don't re-warn every turn. */
  lastWarnedPercent: number;
}

export interface RelayDeps {
  db: SqlDatabase;
  dataDir: string;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  roomRelay: Map<string, RoomRelayState>;
  globalCost: CostReport;
  broadcast: (event: ServerEvent) => void;
  agentDisplayName: (agentId: string) => string;
  /**
   * Vault memory layer v1 (docs/DESIGN-memory-read.md), plain dependency-
   * injection in the same style as agentDisplayName above — relay.ts has no
   * import of packages/gateway/src/memory.ts, it only shapes these two
   * accessors. Optional so every existing RelayDeps literal in tests keeps
   * compiling unchanged when it omits them (no pins configured -> no-op).
   */
  getMemoryPinsForRoom?: (roomId: string) => string[];
  getPinnedNote?: (path: string) => { title: string; markdown: string } | undefined;
}

type PendingJob = {
  roomId: string;
  outbound: OutboundMessage;
  settle: (ok: boolean, err?: Error) => void;
  /**
   * B7 (2026-07-09 design, landed 2026-07-21 per TOP-TIER-QUEUE.md's reframe
   * ruling): the id of the message that CAUSED this delivery (the `source`
   * relayMessageToAgents was called with) — stamped onto the agent's reply
   * as `replyTo` in commitAgentReply below, so a reply always names the
   * specific turn it answers. This is what unblocks bridge.ts's
   * BridgeWaitRegistry from correlating replies by anything other than raw
   * sender identity + single-flight.
   */
  triggerMessageId: string;
};

class AgentRelayWorker {
  private readonly queue: PendingJob[] = [];
  private draining = false;
  private current: PendingJob | null = null;
  /** Settles the in-flight turn (set per job in runOne, cleared by finish/fail). */
  private settleCurrent: ((ok: boolean, err?: Error) => void) | null = null;
  private buffer = '';
  private draftMessageId = '';
  private pendingUsage: { tokensIn: number; tokensOut: number } | null = null;
  private eventsStarted = false;

  constructor(
    private readonly agentId: string,
    private readonly session: AgentSession,
    private readonly deps: RelayDeps,
    private readonly trust: 'full' | 'verify-outputs'
  ) {}

  start() {
    if (this.eventsStarted) return;
    this.eventsStarted = true;
    void this.consumeEvents();
  }

  enqueue(roomId: string, outbound: OutboundMessage, triggerMessageId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        roomId,
        triggerMessageId,
        // Stamp roomId onto the outbound message itself (not just the job
        // wrapper) — this is the one choke point every relay delivery goes
        // through, so it's the only place that needs to know this job's
        // outbound message came from `roomId`. Adapters that don't care
        // simply ignore the field; grok-build reads it to decide full-auto
        // vs restricted tool posture (Fable ruling M-WM-1/B4-M3).
        outbound: { ...outbound, roomId },
        settle: (ok, err) => (ok ? resolve() : reject(err ?? new Error('relay job failed'))),
      });
      void this.drainQueue();
    });
  }

  private async drainQueue() {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        await this.runOne(job);
      } catch (e) {
        job.settle(false, e instanceof Error ? e : new Error(String(e)));
      }
    }
    this.draining = false;
  }

  private async runOne(job: PendingJob) {
    this.current = job;
    this.buffer = '';
    this.pendingUsage = null;
    this.draftMessageId = randomUUID();

    // The original job.settle (the enqueue caller's promise) must ALWAYS be
    // the one settled — the previous design overwrote it with an internal
    // promise's handlers, which (a) left callers hanging forever on success
    // and (b) crashed the whole gateway on a failed send: the internal
    // promise rejected with no awaiter (live crash 2026-07-04, grok-build
    // busy-race during the first two-agent relay smoke).
    const finished = new Promise<void>((resolve, reject) => {
      this.settleCurrent = (ok: boolean, err?: Error) => {
        if (ok) resolve();
        else reject(err ?? new Error('relay job failed'));
      };
    });

    // Watchdog: failJob rejects `finished`; the finally below then nulls
    // settleCurrent, so a late finishJob/failJob from a straggling event is a
    // no-op and the settle-exactly-once invariant above holds.
    const startedAt = Date.now();
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    try {
      await this.session.send(job.outbound);
      watchdog = setTimeout(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        this.failJob(
          new Error(
            `[relay] watchdog: agent ${this.agentId} emitted no message-complete or error after ${elapsedSec}s`
          )
        );
        // Failing the job frees the QUEUE, but the session's turn pump is
        // still wedged on the hung child — the next send() would block on it
        // forever. Interrupt kills the active child so the pump settles.
        void this.session.interrupt().catch((e) => {
          console.error(`[relay] watchdog interrupt of ${this.agentId} failed`, e);
        });
      }, TURN_WATCHDOG_MS);
      await finished;
      job.settle(true);
    } catch (e) {
      job.settle(false, e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.current = null;
      this.settleCurrent = null;
    }
  }

  private finishJob() {
    this.settleCurrent?.(true);
  }

  private failJob(err: Error) {
    this.settleCurrent?.(false, err);
  }

  private async consumeEvents() {
    try {
      for await (const ev of this.session.events()) {
        this.handleEvent(ev);
      }
    } catch (e) {
      console.error(`[relay] events loop ended for ${this.agentId}`, e);
    }
  }

  private handleEvent(ev: AgentEvent) {
    const job = this.current;
    if (!job) return;

    const messageId = this.draftMessageId;

    if (ev.type === 'token') {
      this.buffer += ev.delta;
      return;
    }

    if (ev.type === 'tool-start') {
      this.deps.broadcast({
        type: 'chat.typing',
        payload: { roomId: job.roomId, agentId: this.agentId, tool: ev.tool },
      });
      return;
    }

    if (ev.type === 'usage') {
      this.pendingUsage = { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut };
      return;
    }

    if (ev.type === 'error') {
      console.error(`[relay] agent ${this.agentId} error:`, ev.message);
      this.failJob(new Error(ev.message));
      return;
    }

    if (ev.type === 'message-complete') {
      void this.commitAgentReply(job.roomId, messageId, job.triggerMessageId);
      this.finishJob();
    }
  }

  private async commitAgentReply(roomId: string, messageId: string, triggerMessageId: string) {
    const content = this.buffer.trim();
    if (!content) return;

    const msg: Message = {
      id: messageId,
      roomId,
      senderId: this.agentId,
      content,
      createdAt: Date.now(),
      verifyBadge: this.trust === 'verify-outputs' ? 'verify-outputs' : 'verified',
      // B7 (TOP-TIER-QUEUE.md, 2026-07-09 design / 2026-07-21 landed): every
      // seat reply names the exact message that triggered it. Lets
      // resolveRelayTargets' pre-existing "Agent: fan-out... or replyTo
      // another agent" branch (dormant since 1117f50 — nothing ever produced
      // a replyTo on an agent message) finally fire, and gives bridge.ts's
      // BridgeWaitRegistry a precise correlation key instead of sender-
      // identity + single-flight.
      replyTo: triggerMessageId,
    };

    insertMessage(this.deps.db, msg);
    persistDatabase(this.deps.db, this.deps.dataDir);
    const list = this.deps.messages.get(roomId) ?? [];
    list.push(msg);
    this.deps.messages.set(roomId, list);
    this.deps.broadcast({ type: 'message.new', payload: msg });

    // Per-turn token guard (docs/DESIGN-token-budgets.md): breach does NOT
    // pause the room and does NOT block persistence of this reply — it only
    // suppresses THIS reply's onward agent-agent fan-out, so one agent's
    // blowup can't kill the room. Computed before recordUsage so the fan-out
    // decision below doesn't depend on room-budget side effects.
    let suppressFanout = false;
    if (this.pendingUsage) {
      const breach = turnTokenBudgetBreach(this.agentId, this.pendingUsage.tokensIn, this.pendingUsage.tokensOut);
      if (breach) {
        suppressFanout = true;
        this.deps.broadcast(
          turnTokenBudgetErrorEvent(this.deps.agentDisplayName(this.agentId), breach.tokens, breach.cap)
        );
      }
      this.recordUsage(roomId, this.pendingUsage.tokensIn, this.pendingUsage.tokensOut);
      this.pendingUsage = null;
    }

    const room = this.deps.rooms.get(roomId);
    if (!room) return;

    const rs = getRoomRelayState(this.deps.roomRelay, roomId);
    rs.agentTurnsSinceHuman += 1;
    if (rs.agentTurnsSinceHuman >= room.turnCap) {
      rs.paused = true;
      // Reuses budget.warning until shared types add turn-cap event (Fable-owned).
      this.deps.broadcast({
        type: 'budget.warning',
        payload: {
          roomId,
          percent: 100,
        },
      });
    }

    // Room-level pauses (turn cap OR token budget) both gate the fan-out;
    // relayMessageToAgents also re-checks tokenPaused itself (belt-and-
    // braces for callers other than this one, e.g. onRoomChatMessage).
    if (!rs.paused && !rs.tokenPaused && !suppressFanout) {
      relayMessageToAgents(this.deps, roomId, msg, this.agentId);
    }
  }

  private recordUsage(roomId: string, tokensIn: number, tokensOut: number) {
    const billing = this.deps.agents.get(this.agentId)?.manifest.billing;
    const tier = modelTierFromBilling(billing);
    const estimatedCostUsd = estimateCostUsd(tokensIn, tokensOut, billing);
    const timestamp = Date.now();

    insertCostEvent(this.deps.db, {
      agentId: this.agentId,
      roomId,
      modelTier: tier,
      tokensIn,
      tokensOut,
      estimatedCostUsd,
      timestamp,
      outcome: 'message-complete',
    });
    // persistDatabase removed here (review 2026-08-04 §4.1): insertCostEvent
    // is an append to the cost_events log, and db.ts's insertCostEvent now
    // marks the database dirty, so the 5 s flush tick writes this within one
    // tick. cost_events is the append-only source every in-memory tally is
    // recomputed from at boot (db.ts recomputeCostTotals), so the worst case
    // from batching it is losing <5 s of usage telemetry on a hard kill — not
    // a message, not a room. Two of the three full-database writes per agent
    // turn were here and at the end of this method.
    const gc = this.deps.globalCost;
    gc.tokensIn += tokensIn;
    gc.tokensOut += tokensOut;
    gc.estimatedCostUsd += estimatedCostUsd;
    const by = gc.byAgent[this.agentId] ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    by.tokensIn += tokensIn;
    by.tokensOut += tokensOut;
    by.costUsd += estimatedCostUsd;
    gc.byAgent[this.agentId] = by;

    const costEvent: CostEvent = {
      agentId: this.agentId,
      roomId,
      modelTier: tier,
      tokensIn,
      tokensOut,
      estimatedCostUsd,
      timestamp,
      outcome: 'message-complete',
    };
    this.deps.broadcast({ type: 'cost.event', payload: costEvent });

    // Room-wide token tally + 80%/100% budget thresholds (separate from the
    // turn-cap pause above — see RoomRelayState doc comment).
    applyRoomTokenUsage(this.deps, roomId, this.agentId, tokensIn, tokensOut, estimatedCostUsd);
    // persistDatabase removed here (review 2026-08-04 §4.1). NOTE: unlike the
    // insertCostEvent site above, applyRoomTokenUsage is not purely in-memory
    // — it calls saveRoom (budgets.ts) to persist room.costTracker. That is
    // still safe to batch, and precisely because saveRoom marks the database
    // dirty the write is owed to the next 5 s tick rather than dropped. It is
    // also derived state: recomputeCostTotals rebuilds every room tally from
    // cost_events at boot, so even a lost tick self-heals on restart.
  }
}

const workers = new Map<string, AgentRelayWorker>();

export function getRoomRelayState(
  roomRelay: Map<string, RoomRelayState>,
  roomId: string
): RoomRelayState {
  let s = roomRelay.get(roomId);
  if (!s) {
    s = {
      agentTurnsSinceHuman: 0,
      paused: false,
      tokensUsed: 0,
      tokenPaused: false,
      tokenExtensionUsed: false,
      lastWarnedPercent: 0,
    };
    roomRelay.set(roomId, s);
  }
  return s;
}

export function registerAgentRelay(
  agentId: string,
  session: AgentSession,
  deps: RelayDeps,
  trust: 'full' | 'verify-outputs'
) {
  const w = new AgentRelayWorker(agentId, session, deps, trust);
  workers.set(agentId, w);
  w.start();
}

export function unregisterAgentRelay(agentId: string) {
  workers.delete(agentId);
}

/** Map UI/display @aliases to canonical agent seat ids. */
const MENTION_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  grok: 'grok-build',
  chatgpt: 'codex',
  all: 'everyone',
};

function normalizeMentionId(raw: string): string {
  const lower = raw.toLowerCase();
  return MENTION_ALIASES[lower] ?? lower;
}

function verifiedAgentIdsInRoom(deps: RelayDeps, room: Room): string[] {
  const out: string[] = [];
  for (const memberId of room.memberIds) {
    if (memberId === 'human') continue;
    const st = deps.agents.get(memberId);
    if (st?.status === 'VERIFIED' && st.session) out.push(memberId);
  }
  return out;
}

function parseMentionsFromContent(deps: RelayDeps, room: Room, content: string): string[] {
  const known = new Set(verifiedAgentIdsInRoom(deps, room));
  known.add('everyone');
  const found = new Set<string>();
  // '#' is included so multi-instance seat ids (docs/DESIGN-multi-instance.md,
  // e.g. `claude-code#work`) are @-mentionable, not just bare manifestIds.
  const pattern = /@([a-z0-9_#-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const candidate = normalizeMentionId(match[1]);
    if (known.has(candidate)) found.add(candidate);
  }
  return Array.from(found);
}

function effectiveMentions(deps: RelayDeps, room: Room, msg: Message): string[] {
  const fromField = (msg.mentions ?? []).map(normalizeMentionId);
  const fromContent = parseMentionsFromContent(deps, room, msg.content);
  return Array.from(new Set([...fromField, ...fromContent]));
}

function senderOfMessage(deps: RelayDeps, roomId: string, messageId: string): string | undefined {
  const list = deps.messages.get(roomId) ?? [];
  return list.find((m) => m.id === messageId)?.senderId;
}

/**
 * Decide which VERIFIED agents should receive `source` via their relay queue.
 * Human: @everyone, specific @ids, or replyTo an agent — otherwise no delivery.
 * Agent: fan-out only when addressed (@everyone, @ids, or replyTo another agent).
 */
export function resolveRelayTargets(
  deps: RelayDeps,
  room: Room,
  source: Message,
  excludeAgentId?: string
): string[] {
  const verified = verifiedAgentIdsInRoom(deps, room);
  const verifiedSet = new Set(verified);
  const mentions = effectiveMentions(deps, room, source);
  const hasEveryone = mentions.includes('everyone');
  const specific = mentions.filter((m) => m !== 'everyone');

  const withoutExcluded = (ids: string[]) =>
    excludeAgentId ? ids.filter((id) => id !== excludeAgentId) : ids;

  if (source.senderId === 'human') {
    if (hasEveryone) return withoutExcluded(verified);
    if (specific.length > 0) {
      return withoutExcluded(specific.filter((id) => verifiedSet.has(id)));
    }
    if (source.replyTo) {
      const replied = senderOfMessage(deps, room.id, source.replyTo);
      if (replied && replied !== 'human' && verifiedSet.has(replied)) {
        return withoutExcluded([replied]);
      }
    }
    return [];
  }

  if (verifiedSet.has(source.senderId)) {
    if (hasEveryone) {
      return withoutExcluded(verified.filter((id) => id !== source.senderId));
    }
    if (specific.length > 0) {
      return withoutExcluded(
        specific.filter((id) => verifiedSet.has(id) && id !== source.senderId)
      );
    }
    if (source.replyTo) {
      const replied = senderOfMessage(deps, room.id, source.replyTo);
      if (
        replied &&
        replied !== 'human' &&
        verifiedSet.has(replied) &&
        replied !== source.senderId
      ) {
        return withoutExcluded([replied]);
      }
    }
    return [];
  }

  return [];
}

export function outboundFromMessage(msg: Message, deps: RelayDeps): OutboundMessage {
  const name =
    msg.senderId === 'human'
      ? 'You'
      : deps.agentDisplayName(msg.senderId);
  return {
    role: msg.senderId === 'human' ? 'user' : 'assistant',
    senderId: msg.senderId,
    senderName: name,
    content: msg.content,
    mentions: msg.mentions,
    replyTo: msg.replyTo,
  };
}

/**
 * Attachment hand-off per docs/DESIGN-attachments.md. Resolves each ref by id
 * via getAttachment() — server-authoritative; msg.attachments came off a
 * persisted Message, but the on-disk StoredAttachment (diskName) is only
 * available from the index. CLI harnesses (claude-code, grok-build) get a
 * copy in their own workspace and an appended text reference to the ABSOLUTE
 * PATH OF THE COPY (never the shared gateway store path). http/ws harnesses
 * keep the existing `attachments` field (url) with no filesystem hand-off.
 * Returns the base outbound unchanged when there's nothing to attach or the
 * target agent is unknown.
 */
function outboundForTarget(
  deps: RelayDeps,
  base: OutboundMessage,
  source: Message,
  agentId: string
): OutboundMessage {
  const refs = source.attachments;
  if (!refs || refs.length === 0) return base;

  const harness = deps.agents.get(agentId)?.manifest.harness;
  if (!harness) return base;

  if (!CLI_HARNESSES.has(harness)) {
    // Blank the store path: http/ws agents get url only. AttachmentRef.path
    // is required by the shared type, but a real value here would hand the
    // gateway's shared-store path to every http/ws agent the moment an
    // adapter starts forwarding attachments (the design's boundary rule
    // exists to prevent exactly that).
    return { ...base, attachments: refs.map((r) => ({ ...r, path: '' })) };
  }

  const lines: string[] = [];
  for (const ref of refs) {
    const stored = getAttachment(ref.id);
    if (!stored) continue;
    const copyPath = copyAttachmentForAgent(deps.dataDir, stored, agentId);
    if (!copyPath) continue; // copy failed — skip, never hand out a store/other-agent path
    lines.push(`[attachment: ${stored.filename} (${stored.mimeType}) — ${copyPath}]`);
  }
  if (lines.length === 0) return base;

  return { ...base, content: `${base.content}\n\n${lines.join('\n')}` };
}

/** Queue delivery to addressed VERIFIED agents (serialized per agent). */
export function relayMessageToAgents(
  deps: RelayDeps,
  roomId: string,
  source: Message,
  excludeAgentId?: string
) {
  const room = deps.rooms.get(roomId);
  if (!room) return;

  const rs = getRoomRelayState(deps.roomRelay, roomId);
  if (rs.paused || rs.tokenPaused) return;

  const outbound = outboundFromMessage(source, deps);
  const targets = resolveRelayTargets(deps, room, source, excludeAgentId);

  // FLAGGED FOR FABLE REVIEW (docs/DESIGN-memory-read.md): pinned-vault-note
  // prepend, computed once per room here (pins are room-scoped, so this is
  // identical for every target below) and applied to each target's outbound
  // content just before enqueue — the compose choke point both per-target
  // branches (resume-session passthrough vs. windowed) already converge on,
  // same spot outboundForTarget's attachment hand-off is applied. Deliberately
  // NOT inside AgentRelayWorker (queue/settle/watchdog machinery) — this is a
  // plain string prepend on the already-built OutboundMessage, using deps
  // accessors memory.ts's index.ts wiring supplies (getMemoryPinsForRoom /
  // getPinnedNote). Pin content is expected to already be redacted and capped
  // (memory.ts's buildPinnedContextBlock enforces both) — this call site does
  // not re-check either.
  const pinnedBlock = deps.getMemoryPinsForRoom && deps.getPinnedNote
    ? buildPinnedContextBlock({ [roomId]: deps.getMemoryPinsForRoom(roomId) }, roomId, deps.getPinnedNote)
    : '';

  for (const agentId of targets) {
    const worker = workers.get(agentId);
    if (!worker) continue;
    // Per-target history shaping (docs/DESIGN-token-budgets.md §3): agents
    // with native session persistence ('resume-session' — claude-code,
    // grok-build via --resume) carry their own memory of earlier turns, so
    // they get the existing single-message outbound unchanged. Agents
    // without it (hermes, openclaw) get a windowed context block instead of
    // relying on their own (often unbounded) server-side session growth.
    const hasResumeSession =
      deps.agents.get(agentId)?.manifest.capabilities.includes('resume-session') ?? false;
    const base = hasResumeSession
      ? outbound
      : composeWindowedOutbound(deps, room, source, relayWindowMaxMessages(), agentId);
    const forTarget = outboundForTarget(deps, base, source, agentId);
    const withPins = pinnedBlock
      ? { ...forTarget, content: withPinnedContext(forTarget.content, pinnedBlock) }
      : forTarget;
    void worker.enqueue(roomId, withPins, source.id).catch((e) => {
      console.error(`[relay] deliver to ${agentId} failed`, e);
      // Q8 (2026-07-14, Fable-approved frozen-zone exception): this is the
      // single funnel point for every relay delivery failure (in-band
      // AgentEvent 'error', TURN_WATCHDOG_MS timeout, and any raw
      // session.send() throw all reject worker.enqueue()'s promise here) —
      // previously console.error-only, so no WS client ever saw it. Reuses
      // the existing type:'error' ServerEvent shape (see
      // turnTokenBudgetErrorEvent in budgets.ts for the same pattern) with
      // room/agent attribution folded into the message text, since the
      // shared 'error' payload has no dedicated roomId/agentId fields.
      //
      // Q8b (2026-07-21, Fable-approved narrow amendment to Q8, same catch
      // block only): the raw e.message used to be embedded verbatim in this
      // broadcast, which meant any adapter/OS error text — frequently
      // containing absolute filesystem paths — went out over the WS wire to
      // every connected client. The full, unredacted detail still goes to
      // the console.error above (server-side log only); the broadcast now
      // gets only a stable short form: the error's class/name plus up to
      // ~80 chars of its message with path-like substrings ("C:\foo\bar",
      // "/etc/passwd/shadow", ...) redacted to "[path]".
      //
      // M11 (2026-07-21 review-panel finding, same Q8b catch-block-only
      // scope): PATH_LIKE alone only caught filesystem paths — everything
      // else (internal IP:port, bearer/session tokens, key=value secrets,
      // single-segment refs like "/etc") still reached every WS client
      // verbatim inside the 80-char window. Redact FIRST, then slice, same
      // discipline as PATH_LIKE, so a secret split across the truncation
      // boundary can't survive. errorName is also attacker-settable on a
      // custom Error subclass (`e.name`/`e.constructor.name`) and was
      // neither capped nor scrubbed — now stripped to a safe charset and
      // length-capped.
      const rawMessage = e instanceof Error ? e.message : String(e);
      const rawErrorName = e instanceof Error ? e.constructor?.name || e.name || 'Error' : 'Error';
      const errorName = rawErrorName.replace(/[^\w.-]/g, '_').slice(0, 40);
      // Windows drive paths, POSIX paths (multi- AND single-segment — the
      // single-segment alternative closes the "/etc", "/passwd" gap M11
      // flagged), in that order so the longer/more specific forms win.
      const PATH_LIKE = /[A-Za-z]:[\\/][^\s"'<>|]*|(?:[\\/][^\s"'<>|]+){2,}|[\\/][^\s"'<>|]+/g;
      // IPv4 (with optional :port) — e.g. "ECONNREFUSED 10.0.0.5:6379".
      const IP_PORT_LIKE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
      // "Bearer <token>" auth headers surfaced in fetch/HTTP error text.
      const BEARER_LIKE = /\bBearer\s+\S+/gi;
      // key=value / key: value pairs whose value looks like a token/secret
      // (8+ chars, no whitespace) — covers password=, apiKey=, connection
      // strings, and generic high-entropy values regardless of key name.
      const KEY_VALUE_SECRET = /\b[A-Za-z][A-Za-z0-9_-]{2,30}\s*[:=]\s*['"]?[A-Za-z0-9+/_.-]{8,}['"]?/g;
      const sanitizedMessage = rawMessage
        .replace(PATH_LIKE, '[path]')
        .replace(IP_PORT_LIKE, '[addr]')
        .replace(BEARER_LIKE, '[token]')
        .replace(KEY_VALUE_SECRET, '[redacted]')
        .slice(0, 80);
      deps.broadcast({
        type: 'error',
        payload: {
          code: 'relay.delivery-failed',
          message: `Delivery to ${deps.agentDisplayName(agentId)} in room "${room.name}" failed: ${errorName}: ${sanitizedMessage}`,
          recoverable: true,
        },
      });
    });
  }
}

/** After a human (or gateway) chat message is persisted. */
export function onRoomChatMessage(deps: RelayDeps, msg: Message) {
  const room = deps.rooms.get(msg.roomId);
  if (!room) return;

  const rs = getRoomRelayState(deps.roomRelay, msg.roomId);
  if (msg.senderId === 'human') {
    rs.agentTurnsSinceHuman = 0;
    rs.paused = false;
    // Token-pause resume is intentionally NOT symmetric with the turn-cap
    // reset above (docs/DESIGN-token-budgets.md: "resume grants +25%
    // headroom once, then pauses again — no infinite nagging"). See
    // budgets.ts maybeResumeFromTokenPause for the one-time-extension logic.
    maybeResumeFromTokenPause(deps, msg.roomId);
  }

  relayMessageToAgents(deps, msg.roomId, msg);
}

export function addAgentToRoom(
  deps: RelayDeps,
  roomId: string,
  agentId: string
): boolean {
  const room = deps.rooms.get(roomId);
  if (!room) return false;
  if (room.memberIds.includes(agentId)) return false;
  room.memberIds = [...room.memberIds, agentId];
  room.updatedAt = Date.now();
  saveRoom(deps.db, room);
  persistDatabase(deps.db, deps.dataDir);
  deps.broadcast({ type: 'room.updated', payload: room });
  return true;
}