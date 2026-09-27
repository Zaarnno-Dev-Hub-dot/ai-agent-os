/**
 * Core type definitions for Agent OS
 * These types are shared across gateway, UI, and all adapters.
 *
 * Owner: Fable 5 (PRD §9). Do not modify without review — adapters and the
 * verifier are built against this exact surface.
 *
 * IMPORTANT: No painted status. Every ONLINE dot is earned via proof-of-life.
 */

// ============================================================================
// Transport Flavors
// ============================================================================

export type TransportFlavor =
  | 'http-openai'    // OpenAI-compatible REST + SSE (Hermes)
  | 'acp'            // Agent Client Protocol (Grok Build, Claude Code alt)
  | 'cli-stream'     // Spawn CLI, parse stream-json (Claude Code, Grok Build alt)
  | 'ws';            // WebSocket client or inbound server (OpenClaw, homebrew)

// ============================================================================
// Adapter Contract — the onboarding story. One folder in packages/adapters/
// implements AgentAdapter; the gateway never speaks to a harness any other way.
// ============================================================================

export interface AgentAdapter {
  /** Static descriptor. Loaded by the registry before any connection. */
  readonly manifest: AdapterManifest;
  /**
   * Establish or attach to a REAL authenticated session. Must reject with a
   * diagnosable AdapterError (auth-missing | binary-not-found | endpoint-down |
   * handshake-failed) — never resolve with a session that cannot do real work.
   */
  connect(config: AdapterConfig): Promise<AgentSession>;
}

export type AdapterErrorCode =
  | 'auth-missing'
  | 'binary-not-found'
  | 'endpoint-down'
  | 'handshake-failed';

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
    /** Human-readable remediation shown in the Add Agent wizard (no-CLI rule: must be clickable/fixable from UI) */
    public readonly remedy?: string
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface AdapterManifest {
  /** Unique identifier, e.g., 'hermes', 'claude-code', 'grok-build', 'openclaw' */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Which harness this adapter connects to */
  harness: 'hermes' | 'claude-code' | 'grok-build' | 'openclaw' | 'homebrew';
  /** Transport flavor for this adapter */
  flavor: TransportFlavor;
  /** Avatar emoji or icon identifier */
  avatar: string;
  /** Color for UI theming (hex) */
  color: string;
  /** Declared capabilities — the verifier probes these for real */
  capabilities: string[];
  /**
   * Identity expectations checked by the identity-echo challenge.
   * modelPattern is a RegExp source tested against the session-reported model id
   * (e.g. hermes: '^hermes', claude-code: '^(claude|sonnet|opus|haiku)',
   * grok-build: '^grok'). An invalid or non-matching pattern fails CLOSED.
   */
  identity: {
    modelPattern: string;
    /** Optional RegExp source for the reported account/subscription id */
    accountPattern?: string;
  };
  /** Trust level for output verification (grok-build ships 'verify-outputs') */
  trust: 'full' | 'verify-outputs';
  /**
   * How this agent's usage is billed — budgets bind on TOKENS for every kind;
   * USD is a display-only estimate computed from the declared rates and shown
   * only for 'api' agents (see docs/DESIGN-token-budgets.md). Optional until
   * Phase 3 wires the meters; adapters should declare it as they touch their
   * manifests. Absent ⇒ treated as 'subscription' (token bar, no dollar line).
   */
  billing?: {
    kind: 'subscription' | 'api' | 'local';
    /** USD per million input tokens — only meaningful when kind === 'api'. */
    usdPerMTokIn?: number;
    /** USD per million output tokens — only meaningful when kind === 'api'. */
    usdPerMTokOut?: number;
  };
  /** Default port for auto-detection (if applicable) */
  defaultPort?: number;
  /** CLI command name for PATH detection (if applicable) */
  cliCommand?: string;
  /** Version of the manifest schema */
  manifestVersion: 1;
}

export interface AdapterConfig {
  /**
   * Transport-specific configuration. May contain secrets (API keys, tokens):
   * never log it, never send it to the UI, persist only via redactConfig().
   */
  transport: Record<string, unknown>;
  /** Optional session ID for continuity */
  sessionId?: string;
  /** Workspace path the agent can actually read/write — required for nonce challenges */
  workspace?: string;
}

/** Keys whose values are replaced before config is persisted or synced. */
export const SECRET_CONFIG_KEYS = ['key', 'token', 'secret', 'password', 'bearer', 'apikey', 'api_key'] as const;

export function redactConfig(config: AdapterConfig): AdapterConfig {
  const transport: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.transport)) {
    transport[k] = SECRET_CONFIG_KEYS.some((s) => k.toLowerCase().includes(s)) ? '«redacted»' : v;
  }
  return { ...config, transport };
}

// ============================================================================
// Agent Session & Events
// ============================================================================

export interface AgentSession {
  send(msg: OutboundMessage): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  /** Answer a proof-of-life challenge. See Challenge: the nonce is NEVER in the payload. */
  prove(challenge: Challenge): Promise<ChallengeResponse>;
  /**
   * Cheap liveness check. Does NOT report AgentStatus — the verifier owns status.
   * Gateway-polled by proofOfLife.ts's sweepOnce() every 10 minutes (SWEEP_INTERVAL_MS) — NOT every
   * 20s: `heartbeatIntervalMs: 20_000` exists as a config value (agents.ts, index.ts) but is never
   * wired to a timer anywhere in this codebase (R4 finding, 2026-08-01 — checked, zero setInterval
   * call sites reference it). Corrected here since this docstring was the source of that assumption.
   */
  health(): Promise<HealthReport>;
  /**
   * G2b (2026-08-01, docs/Wave-Backlog/2026-08-01-burn/G2B-AUTH-CONTRACT.md, Amendment "A-adapter";
   * R4 revision): optional current-task verb, gateway-pulled on its own ~30s timer
   * (proofOfLife.ts's sweepActivityOnce/startActivitySweep) — separate from health's 10-minute sweep,
   * since a verb sampled every 10 minutes would miss nearly every real turn.
   * Identity is the session object being polled — there is no client-supplied agentId anywhere on
   * this path, so spoofing another seat's activity is structurally impossible. Adapters derive the
   * verb from dispatch/tool state they already track; absent = the UI falls back to board/last-said.
   * (The original design considered a client-postable `status.update` WS message on the human-only
   * browser `clients` map — agents never hold a session there, so that path was dead on arrival;
   * see the same contract doc's "architecture blocker" section.)
   *
   * A method, not a plain property: matches health() one line above (also a poll, also optional to
   * implement), and keeps the door open for an adapter to do real work computing its own verb later
   * (e.g. reading tool-call state) without a later breaking signature change.
   */
  activity?(): Promise<AgentActivity | undefined>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/** Current task verb for a seat, gateway-pulled via AgentSession.activity(). See its doc comment. */
export interface AgentActivity {
  verb: string;
  at?: number;
  intensity?: number;
}

export interface OutboundMessage {
  role: 'user' | 'assistant' | 'system';
  /**
   * Who authored this message ('human' or an agent id). Required: in multi-party
   * rooms the receiving session must know who is speaking — adapters prefix or
   * structure this per-harness so agents can attribute turns.
   */
  senderId: string;
  /** Display name matching senderId, for harnesses that render plain transcripts */
  senderName?: string;
  content: string; // CommonMark
  attachments?: AttachmentRef[];
  mentions?: string[]; // agent IDs
  replyTo?: string; // message ID for threading
  /**
   * Room this turn is being delivered in. Stamped by the gateway relay
   * (relay.ts's AgentRelayWorker.enqueue) — the ONE place per-agent chat
   * jobs are built — so an adapter session (which may be shared across
   * several rooms an agent sits in) can make room-scoped decisions inside
   * send(), e.g. grok-build's full-auto room allowlist (Fable ruling
   * M-WM-1/B4-M3, 2026-07-21). Optional so every existing OutboundMessage
   * literal elsewhere (tests, other call sites) keeps compiling unchanged.
   */
  roomId?: string;
}

export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string; // local filesystem path
  url?: string; // for adapters that need URLs (e.g., Hermes image_url)
}

export type AgentEvent =
  | { type: 'token'; delta: string; messageId: string }
  | { type: 'tool-start'; tool: string; args: Record<string, unknown>; messageId: string }
  | { type: 'tool-end'; tool: string; result: unknown; messageId: string }
  | { type: 'thinking'; summary: string; messageId: string }
  | { type: 'message-complete'; messageId: string }
  | { type: 'error'; code: string; message: string; recoverable: boolean; messageId?: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number; messageId?: string };

// ============================================================================
// Proof-of-Life Protocol
// ============================================================================

export type AgentStatus =
  | 'REGISTERED'    // Manifest loaded, not yet connecting
  | 'CONNECTING'    // connect() in progress
  | 'CHALLENGED'    // Proof-of-life challenge issued
  | 'VERIFIED'      // All challenges passed
  | 'STALE'         // Missed heartbeats; must re-challenge before VERIFIED again
  | 'OFFLINE'       // Graceful disconnect
  | 'FAILED';       // Placeholder/impostor detected — denied all rooms

export type ChallengeType = 'identity-echo' | 'nonce-file' | 'capability-probe';

/**
 * Discriminated challenge payloads. SECURITY INVARIANT: the nonce-file
 * challenge carries only the PATH of the nonce file. The nonce value itself
 * never leaves the verifier — an agent that cannot read the file cannot pass.
 */
export type Challenge =
  | { type: 'identity-echo'; challengeId: string; timestamp: number; timeoutMs: number }
  | { type: 'nonce-file'; challengeId: string; timestamp: number; timeoutMs: number; noncePath: string }
  | { type: 'capability-probe'; challengeId: string; timestamp: number; timeoutMs: number; capability: string };

export interface ChallengeResponse {
  challengeId: string;
  type: ChallengeType;
  success: boolean;
  data?: {
    /** nonce-file: the exact nonce string read from disk */
    nonce?: string;
    /** identity-echo: model id reported from inside the session */
    modelId?: string;
    /** identity-echo: account/subscription identity */
    accountId?: string;
    /** capability-probe: which capability + truncated evidence */
    capability?: string;
    result?: string;
    /** Free text an agent returned instead of structured data (fuel for the generic-response detector) */
    text?: string;
  };
  error?: string;
  latencyMs: number;
}

export interface HealthReport {
  /** Session answered the liveness ping */
  ok: boolean;
  latencyMs: number;
  modelId: string;
  sessionAgeMs: number;
}

// ============================================================================
// Room & Message Model (Chat System)
// ============================================================================

export interface Room {
  id: string;
  name: string;
  type: 'dm' | 'group' | 'agent-agent';
  memberIds: string[]; // agent IDs + 'human'
  createdAt: number;
  updatedAt: number;
  /**
   * Soft-archive timestamp. Archived rooms are hidden from the sidebar and
   * excluded from state.sync; the row and its messages are retained in the DB.
   * Un-archive is out of scope for Phase 3 Milestone A. Absent = active.
   */
  archivedAt?: number;
  turnCap: number; // consecutive agent turns without human input; default 12
  budgetCap?: { tokens: number; costUsd: number };
  costTracker?: CostReport;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string; // agent ID or 'human'
  content: string; // CommonMark
  attachments?: AttachmentRef[];
  mentions?: string[];
  replyTo?: string;
  createdAt: number;
  updatedAt?: number;
  deletedAt?: number;
  editHistory?: MessageEdit[];
  reactions?: Reaction[];
  verifyBadge?: 'verified' | 'verify-outputs'; // from manifest.trust
}

export interface MessageEdit {
  previousContent: string;
  editedAt: number;
}

export interface Reaction {
  emoji: string;
  userIds: string[]; // agent IDs + 'human'
}

export interface CostReport {
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  byAgent: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
}

// ============================================================================
// Gateway State (Single Source of Truth)
// ============================================================================

/**
 * Internal, gateway-only state. Holds the live session handle and unredacted
 * config — NEVER serialize this to the wire. UI gets AgentSummary.
 */
export interface AgentState {
  manifest: AdapterManifest;
  config: AdapterConfig;
  status: AgentStatus;
  statusReason?: string;
  session?: AgentSession;
  lastHeartbeat: number;
  health?: HealthReport;
  /** G2b Amendment "A-adapter" — gateway-pulled, see AgentSession.activity(). */
  activity?: AgentActivity;
  assignedRooms: string[];
  currentRoomId?: string;
  challengeHistory: ChallengeResponse[];
}

/** Wire-safe projection of AgentState for the UI. No session, no secrets. */
export interface AgentSummary {
  id: string;
  displayName: string;
  harness: AdapterManifest['harness'];
  flavor: TransportFlavor;
  avatar: string;
  color: string;
  trust: AdapterManifest['trust'];
  status: AgentStatus;
  statusReason?: string;
  lastHeartbeat: number;
  health?: HealthReport;
  activity?: AgentActivity;
  assignedRooms: string[];
  lastChallenge?: Pick<ChallengeResponse, 'type' | 'success' | 'latencyMs' | 'error'> & { at: number };
}

export function toAgentSummary(id: string, s: AgentState): AgentSummary {
  const last = s.challengeHistory[s.challengeHistory.length - 1];
  return {
    id,
    displayName: s.manifest.displayName,
    harness: s.manifest.harness,
    flavor: s.manifest.flavor,
    avatar: s.manifest.avatar,
    color: s.manifest.color,
    trust: s.manifest.trust,
    status: s.status,
    statusReason: s.statusReason,
    lastHeartbeat: s.lastHeartbeat,
    health: s.health,
    activity: s.activity,
    assignedRooms: s.assignedRooms,
    lastChallenge: last
      ? { type: last.type, success: last.success, latencyMs: last.latencyMs, error: last.error, at: Date.now() }
      : undefined,
  };
}

export interface GatewayState {
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  globalCost: CostReport;
  config: GatewayConfig;
}

export interface GatewayConfig {
  port: number; // 4110
  dataDir: string; // <project>/data — resolve relative to repo root, do not hardcode absolute paths
  heartbeatIntervalMs: number; // 20000
  staleThresholdMissed: number; // 2
  defaultRoomTurnCap: number; // 12
  proofOfLifeIntervalHours: number; // 24
}

// ============================================================================
// Database Schema (SQLite — driver-agnostic DDL; persistence is NOT optional:
// write on every mutation, read state back at boot)
// ============================================================================

export const DB_SCHEMA = `
-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('dm','group','agent-agent')),
  member_ids TEXT NOT NULL, -- JSON array
  turn_cap INTEGER NOT NULL DEFAULT 12,
  budget_tokens INTEGER,
  budget_cost_usd REAL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Migration for databases created before archived_at existed. applySchema runs
-- every statement inside try/catch, so the duplicate-column error this throws
-- on already-migrated (and fresh) databases is swallowed — idempotent DDL.
ALTER TABLE rooms ADD COLUMN archived_at INTEGER;

-- Messages (FTS4 external-content for search — the sql.js WASM build only
-- compiles FTS3/FTS4, so fts5 DDL fails with "no such module")
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT, -- JSON array
  mentions TEXT, -- JSON array
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  deleted_at INTEGER,
  edit_history TEXT, -- JSON array
  reactions TEXT -- JSON array
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts4(
  content, sender_id, room_id,
  content='messages'
);

CREATE TRIGGER IF NOT EXISTS messages_bd BEFORE DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE docid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_bu BEFORE UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE docid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(docid, content, sender_id, room_id)
  VALUES (new.rowid, new.content, new.sender_id, new.room_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(docid, content, sender_id, room_id)
  VALUES (new.rowid, new.content, new.sender_id, new.room_id);
END;

-- Agent registry (config stored REDACTED via redactConfig — never raw)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL, -- JSON
  config TEXT NOT NULL, -- JSON, secrets redacted
  status TEXT NOT NULL CHECK (status IN ('REGISTERED','CONNECTING','CHALLENGED','VERIFIED','STALE','OFFLINE','FAILED')),
  last_heartbeat INTEGER,
  health TEXT, -- JSON
  challenge_history TEXT -- JSON array
);

-- Cost events (append-only)
CREATE TABLE IF NOT EXISTS cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  room_id TEXT,
  model_tier TEXT NOT NULL, -- 'high' | 'mid' | 'low' | 'local'
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  task_id TEXT,
  outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_room ON cost_events(room_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_ts ON cost_events(timestamp);
`;

// ============================================================================
// Event Schema (WebSocket envelopes, versioned)
// ============================================================================

export type ClientEvent =
  | { type: 'chat.send'; payload: { roomId: string; message: OutboundMessage } }
  | { type: 'chat.edit'; payload: { messageId: string; content: string } }
  | { type: 'chat.delete'; payload: { messageId: string } }
  | { type: 'chat.react'; payload: { messageId: string; emoji: string } }
  | { type: 'room.create'; payload: { name: string; type: Room['type']; memberIds: string[] } }
  | { type: 'room.rename'; payload: { roomId: string; name: string } }
  | { type: 'room.archive'; payload: { roomId: string } }
  | { type: 'room.members'; payload: { roomId: string; memberIds: string[] } } // full replacement
  | { type: 'room.join'; payload: { roomId: string } }
  | { type: 'room.leave'; payload: { roomId: string } }
  | { type: 'room.set-budget'; payload: { roomId: string; tokens: number; costUsd: number } }
  | {
      type: 'agent.connect';
      /**
       * instanceId enables multiple seats of the SAME harness (multiple
       * subscriptions): seat id = manifestId when absent/'main', else
       * `${manifestId}#${instanceId}` (docs/DESIGN-multi-instance.md).
       * Slug rule [a-z0-9-]{1,16}; gateway validates. instanceLabel is the
       * display name for the seat's card.
       */
      payload: { manifestId: string; instanceId?: string; instanceLabel?: string; config: AdapterConfig };
    }
  | { type: 'agent.disconnect'; payload: { agentId: string } }
  | { type: 'agent.prove'; payload: { agentId: string } }
  | { type: 'kanban.create-task'; payload: { roomId: string; title: string; assigneeId?: string } }
  | { type: 'kanban.move'; payload: { taskId: string; column: KanbanColumn } }
  | { type: 'memory.pin'; payload: { messageId: string; vaultPath: string } }
  /** Set a seat's pinned model where the adapter supports it (claude-code, grok-build). Takes effect next turn. */
  | { type: 'agent.set-model'; payload: { agentId: string; model: string } }
  /** Room autoroute: un-addressed human messages go to the router instead of nobody (docs/DESIGN-router.md). */
  | { type: 'room.autoroute'; payload: { roomId: string; enabled: boolean } }
  /** Vault memory layer v1 (docs/DESIGN-memory-read.md) — read-only over the Obsidian vault. */
  | { type: 'memory.search'; payload: { query: string } }
  | { type: 'memory.get'; payload: { path: string } }
  | { type: 'memory.pin-note'; payload: { roomId: string; path: string } }
  | { type: 'memory.unpin-note'; payload: { roomId: string; path: string } };

export type ServerEvent =
  | { type: 'state.sync'; payload: { agents: AgentSummary[]; rooms: Room[]; activeRoomId?: string } }
  | { type: 'agent.status'; payload: { agentId: string; status: AgentStatus; reason?: string; health?: HealthReport; activity?: AgentActivity } }
  | { type: 'room.created'; payload: Room }
  | { type: 'room.updated'; payload: Room }
  | { type: 'message.new'; payload: Message }
  | { type: 'message.updated'; payload: Message }
  | { type: 'message.deleted'; payload: { messageId: string; roomId: string } }
  | { type: 'message.reaction'; payload: { messageId: string; emoji: string; userId: string } }
  | { type: 'chat.typing'; payload: { roomId: string; agentId: string; tool?: string } }
  | { type: 'cost.event'; payload: CostEvent }
  | { type: 'budget.warning'; payload: { roomId: string; percent: number } }
  | { type: 'budget.exceeded'; payload: { roomId: string } }
  /** Memory layer v1 responses (docs/DESIGN-memory-read.md). */
  | { type: 'memory.results'; payload: { query: string; items: Array<{ path: string; title: string; summary?: string; mtime: number }> } }
  | { type: 'memory.note'; payload: { path: string; title: string; markdown: string; pinnedInRooms: string[] } }
  /** One line per routed decision, for the routing log UI (docs/DESIGN-router.md). */
  | { type: 'router.routed'; payload: { roomId: string; messageId: string; cls: string; chosen: string; tried: string[] } }
  | { type: 'kanban.task-created'; payload: KanbanTask }
  | { type: 'kanban.task-moved'; payload: { taskId: string; column: KanbanColumn } }
  | { type: 'proof.challenge'; payload: { agentId: string; challengeType: ChallengeType; challengeId: string } }
  | { type: 'error'; payload: { code: string; message: string; recoverable: boolean } };

/** Every WS frame in both directions: `{ v: 1, timestamp, correlationId? } & (ClientEvent | ServerEvent)` */
export type ClientEnvelope = { v: 1; timestamp: number; correlationId?: string } & ClientEvent;
export type ServerEnvelope = { v: 1; timestamp: number; correlationId?: string } & ServerEvent;

export type KanbanColumn = 'TRIAGE' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';

export interface KanbanTask {
  id: string;
  roomId: string;
  title: string;
  column: KanbanColumn;
  assigneeId?: string;
  createdAt: number;
  updatedAt: number;
  messageId?: string; // linked dispatch message
}

export interface CostEvent {
  agentId: string;
  roomId?: string;
  modelTier: 'high' | 'mid' | 'low' | 'local';
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  timestamp: number;
  taskId?: string;
  outcome: string;
}

// ============================================================================
// Two-Reviewer Policy v1.1 (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md).
// ADDITIVE ONLY — the one named exception to this file's frozen-zone rule
// (BUILDER_PROTOCOL.md / the wave 7 dispatch): these two types, nothing else
// edited above. Everything else about the feature — the poll_reviews/
// poll_review_findings persistence, selection/timeout/parsing logic, the
// gateway routes, the review-room wiring — lives OUTSIDE this frozen module
// (packages/gateway), same "gateway-local extension of a frozen shared
// surface" shape as Poll/PollAttachment/etc. already use in polls.ts. These
// two types exist here (not there) only because the UI package needs a
// shared import for its review-chip component props, per the M3 dispatch.
// ============================================================================

/**
 * Strict verdict literal — the fenced ```verdict block's `verdict` field
 * must be EXACTLY one of these three strings (case-sensitive, no synonyms).
 * Anything else fails to parse and renders `unparseable`, never coerced to
 * 'approve' (design doc F/B3).
 */
export type ReviewVerdict = 'approve' | 'concerns' | 'reject';

/**
 * One reviewer's slot on a covered poll under the two-reviewer policy.
 * Wire-safe shape: broadcast to the UI as a gateway-local extension event
 * (`poll.review.updated` — cast at the two endpoints, same idiom as
 * `poll.updated`; see packages/gateway/src/pollReviews.ts) and persisted
 * (denormalized back into this shape on read) in the poll_reviews +
 * poll_review_findings SQL tables (packages/gateway/src/pollReviewsDb.ts —
 * DB_SCHEMA above is frozen, so those tables are gateway-local DDL applied
 * separately at boot, not an edit to DB_SCHEMA).
 */
export interface PollReview {
  id: string;
  pollId: string;
  /** The reviewer seat id (agents map key — may be `manifestId#instanceId`). */
  seatId: string;
  /** manifest.harness at selection time — the "family" the design doc's exclusion/diversity rules key off. */
  family: string;
  /** 1 = attested tool-less reviewer; 2 = verified full-harness reviewer, different family from slot 1. */
  slot: 1 | 2;
  /** Size of the eligible reviewer pool at propose-time snapshot (F4 pool-degeneracy instrumentation). */
  poolSizeAtSelection: number;
  /** review_policy mode in effect when this review was created ('mutations' | 'all') — 'off' never creates reviews. */
  policyMode: 'mutations' | 'all';
  wakeAt: number;
  attachAt?: number;
  /** Set once this slot has timed out (4-min wake timeout) — independent of whether a substitute was spawned. */
  timeoutAt?: number;
  status: 'pending' | 'attached' | 'timed-out' | 'substituted';
  /** The reviewer's raw reply text, present once a reply arrives — whether or not it parsed. Rendered expandable for `unparseable` chips. */
  rawText?: string;
  /** True ONLY for a strictly-parsed verdict block. False (with verdict/findings undefined) for every malformed variant — never coerced to approve. */
  parseOk: boolean;
  verdict?: ReviewVerdict;
  findings?: string[];
  /** Per-finding human ground truth, index-aligned with `findings`. Undefined entries are unmarked; true/false set via the chip's per-finding valid/invalid toggle (the true-catch/precision ledger's only source of truth). */
  findingValid?: Array<boolean | undefined>;
  /** Set when this review record was spawned as the T+4 parallel substitute for a still-pending original — points at that original review's id. */
  substituteForReviewId?: string;
}
