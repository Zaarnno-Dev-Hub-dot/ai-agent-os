/**
 * Agent OS Gateway — Fastify + WebSocket + SQLite (sql.js, local WASM).
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { SqlDatabase } from './db.js';
import {
  AgentState,
  AttachmentRef,
  ClientEnvelope,
  CostReport,
  GatewayConfig,
  Message,
  Room,
  toAgentSummary,
  type AdapterConfig,
  type AgentStatus,
  type ServerEvent,
} from '@agent-os/shared';
import {
  applyMessageIndexes,
  flushDatabaseIfDirty,
  insertMessage,
  loadAllMessages,
  loadMessagesForRoom,
  loadRooms,
  openDatabase,
  persistDatabase,
  recomputeCostTotals,
  saveRoom,
  updateMessageContent,
  softDeleteMessage,
  updateMessageReactions,
} from './db.js';
import {
  connectAgent,
  disconnectAgent,
  deriveSeatId,
  isValidInstanceId,
  knownManifestIds,
  manifestSource,
  recordSeatReply,
  seatLastReplyAt,
} from './agents.js';
import { startProofOfLifeSweep, startActivitySweep } from './proofOfLife.js';
import { EphemeralPresenceRegistry } from './ephemeral.js';
import { registerEphemeralRoutes } from './ephemeralRoutes.js';
import { createBatchedRunner } from './roomPersistBatch.js';
import { isAttestedManifest } from './attestedVerifier.js';
import { isAllowedModel } from './modelVocab.js';
import { resolveHermesAdapterConfig } from '@agent-os/adapters-hermes';
import type { RelayDeps, RoomRelayState } from './relay.js';
import { getRoomRelayState, onRoomChatMessage, relayMessageToAgents, resolveRelayTargets } from './relay.js';
import { applyNewRoomBudget } from './budgets.js';
import { ARCHIVED_ROOMS_WINDOW, archivedRoomsForStateSync, archivedRoomsPage } from './roomWindow.js';
import {
  activePresetOf,
  appendRouterLog,
  classify,
  ensureRouterConfig,
  hasRouterMention,
  pick,
  type RouterConfig,
} from './router.js';
import {
  applyLoopAction,
  decideNext,
  ensureLoopsConfig,
  saveLoopsConfig,
  startLoop,
  stopLoop,
  type LoopsConfig,
} from './loop.js';
import { BridgeIdempotencyStore, BridgeWaitRegistry, registerBridgeRoute } from './bridge.js';
import { registerEscalateRoute } from './escalateRoutes.js';
import { registerFleetWakeRoute, type WakeOutcome } from './fleetWakeRoutes.js';
import { loadSavedAgents, removeSavedAgent, saveSavedAgents, upsertSavedAgent, type SavedAgent } from './savedAgents.js';
import { findPoll, loadPolls, pollsForStateSync, savePolls, type PollsState } from './polls.js';
import {
  broadcastPollUpdated,
  handlePollDecide,
  handlePollDefer,
  handlePollInfoRequested,
  registerPollsRoute,
  sweepAndSettlePolls,
  type PollsRouteContext,
} from './pollsRoutes.js';
import { registerWorkshopRoute, type WorkshopRouteContext } from './workshopRoutes.js';
import { mintHumanToken, isValidHumanToken, HUMAN_TOKEN_REQUIRED_ERROR } from './humanAuth.js';
import { loadReviewPolicy, type ReviewPolicyState } from './reviewPolicy.js';
import {
  PollReviewTracker,
  applyPollReviewsSchema,
  onPollSettled as onPollReviewsSettled,
  onSeatDisconnected as onReviewSeatDisconnected,
  pollReviewsForStateSync,
  registerPollReviewRoutes,
  startPollReview,
  type PollReviewRouteContext,
} from './pollReviews.js';
import { registerDossiersRoute } from './dossiersRoutes.js';
import { dossiersDir } from './dossiers.js';
import {
  DEFAULT_PAPERCLIP_BASE_URL,
  ensurePaperclipConfig,
  findApprovalsRoom,
  APPROVALS_ROOM_NAME,
  runPaperclipPollOnce,
} from './paperclip.js';
import {
  cleanupAgentAttachmentCopies,
  getAttachment,
  isInlineSafeContentType,
  readAttachmentBuffer,
  reindexAttachmentsFromDisk,
  reindexAttachmentsFromMessages,
  sanitizeHeaderFilename,
  storeAttachment,
} from './files.js';
import {
  MemoryIndex,
  loadPins,
  pinNote,
  resolveVaultPath,
  roomsPinning,
  savePins,
  unpinNote,
  type MemoryPins,
} from './memory.js';
import {
  createProject,
  deleteProject,
  loadProjects,
  renameProject,
  saveProjects,
  setRoomProject,
  type ProjectsState,
} from './projects.js';
import { loadDockApps } from './dockApps.js';
import { roomError, sendEnvelope, sendSerializedEnvelope, serializeEnvelope } from './wsEnvelope.js';
import { buildRoomCreatedEvent } from './roomEvents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..', '..');

// Port override (2026-08-02, ephemeral presence dev/test harness): the live
// gateway on 4110 must never be restarted to verify this feature (the operator is
// using it, 790 rooms, 8 seats) — AGENT_OS_GATEWAY_PORT lets a SEPARATE test
// instance boot on a different port with byte-identical code. Unset (the
// live gateway's normal launch) falls back to the same 4110 default as
// before this existed, so this is additive-only for every existing caller.
const PORT_ENV_OVERRIDE = Number(process.env.AGENT_OS_GATEWAY_PORT);
const resolvedPort = Number.isFinite(PORT_ENV_OVERRIDE) && PORT_ENV_OVERRIDE > 0 ? PORT_ENV_OVERRIDE : 4110;

// dataDir override, same reasoning/precedent as the port override just
// above: a second gateway instance on a different port must NOT read/write
// the live gateway's data/gateway.db, data/*.json, or data/workspaces — two
// processes touching the same sql.js file concurrently is a corruption risk,
// not just a port collision. Unset falls back to the exact same path as
// before this existed.
const DATA_DIR_ENV_OVERRIDE = process.env.AGENT_OS_GATEWAY_DATA_DIR;
const resolvedDataDir =
  DATA_DIR_ENV_OVERRIDE && DATA_DIR_ENV_OVERRIDE.trim() ? DATA_DIR_ENV_OVERRIDE.trim() : join(projectRoot, 'data');

const config: GatewayConfig = {
  port: resolvedPort,
  dataDir: resolvedDataDir,
  heartbeatIntervalMs: 20000,
  staleThresholdMissed: 2,
  defaultRoomTurnCap: 12,
  proofOfLifeIntervalHours: 24,
};

const workspaceRoot = join(config.dataDir, 'workspaces');

/**
 * Browser pages from ANY origin can open WebSockets and (with a permissive CORS
 * reflect) call the HTTP API on 127.0.0.1 — a malicious page in the operator's browser
 * could otherwise puppet the whole agent fleet. Only the gateway's own origin,
 * the Vite dev server, and a companion static server (:4120, read-only tiles
 * that render /api/state) may talk to us; non-browser clients (no Origin header)
 * are not a drive-by vector and pass through.
 *
 * Mobile / reverse-tunnel (2026-08-01): when data/allow-tunnel-origins exists
 * (or AGENT_OS_ALLOW_TUNNEL_ORIGINS=1), also accept https://*.trycloudflare.com
 * so a Cloudflare quick tunnel can reach the dash from a phone without binding
 * the gateway off loopback. Flag file is opt-in and removed by Stop-Mobile-Dash.
 */
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4120',
  'http://localhost:4120',
]);

function tunnelOriginsEnabled(): boolean {
  if (process.env.AGENT_OS_ALLOW_TUNNEL_ORIGINS === '1') return true;
  try {
    return existsSync(join(config.dataDir, 'allow-tunnel-origins'));
  } catch {
    return false;
  }
}

function isAllowedBrowserOrigin(origin: string | undefined | null): boolean {
  if (origin == null || origin === '') return true; // non-browser
  if (ALLOWED_ORIGINS.has(origin)) return true;
  const extra = process.env.AGENT_OS_EXTRA_ORIGINS ?? '';
  for (const o of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (o === origin) return true;
  }
  if (tunnelOriginsEnabled()) {
    try {
      const u = new URL(origin);
      if (
        u.protocol === 'https:' &&
        (u.hostname.endsWith('.trycloudflare.com') || u.hostname.endsWith('.cfargotunnel.com'))
      ) {
        return true;
      }
    } catch {
      /* ignore bad Origin */
    }
  }
  return false;
}

const db: SqlDatabase = await openDatabase(config.dataDir);

/**
 * Two-Reviewer Policy ledger tables. `DB_SCHEMA` (packages/shared) is frozen — poll_reviews
 * + poll_review_findings are applied as a SEPARATE, gateway-local DDL pass
 * right after the base schema, same idempotent-per-statement contract as
 * db.ts's own applySchema.
 */
applyPollReviewsSchema(db);

/**
 * Hot-path index for `messages` (review 2026-08-04 §4.5). Same gateway-local
 * DDL mechanism as applyPollReviewsSchema directly above, for the same reason
 * (packages/shared's DB_SCHEMA is frozen). `messages` had no index on
 * room_id, so every filtered read was a full scan — measured 2,331 ms at
 * 150k rows. Idempotent; see db.ts for why the column order is
 * (room_id, created_at).
 */
applyMessageIndexes(db);

/**
 * humanToken: minted once
 * per gateway process, delivered ONLY via the served index.html (see
 * servedIndexHtml() below) — never over a fetchable /api/* route. Required
 * by poll.decide / agent.disconnect / the review_policy toggle route. See
 * humanAuth.ts's module doc for the honest limits this does and doesn't
 * cover.
 */
const humanToken = mintHumanToken();

const agents = new Map<string, AgentState>();
const rooms = new Map<string, Room>();
const messages = loadAllMessages(db);

// Ephemeral presence registry (2026-08-02, TEMP-agent "on duty" surface,
// ephemeral.ts): entirely separate in-memory store from `agents` above —
// never read or written by connectAgent/disconnectAgent, never persisted.
// See ephemeral.ts's module doc comment for why the seat/`agents` shape is
// wrong for a ~10-20s temp worker.
const ephemeralPresence = new EphemeralPresenceRegistry();
const roomRelay = new Map<string, RoomRelayState>();
const globalCost: CostReport = {
  tokensIn: 0,
  tokensOut: 0,
  estimatedCostUsd: 0,
  byAgent: {},
};

/**
 * The Router: gateway-local state layered beside
 * the frozen shared types, same pattern as room.rollover above.
 *
 * liveConfigs holds the EXACT AdapterConfig object reference handed to
 * adapter.connect() (and therefore held internally by the session class,
 * e.g. ClaudeCodeSession/GrokBuildSession's `private readonly config`) —
 * NOT agents.get(id).config, which is a REDACTED COPY made by connectAgent
 * for safe storage/display (see agents.ts, redactConfig). Mutating THIS map
 * entry's transport.model in place is what makes agent.set-model reach the
 * session: spawnClaudeTurn/spawnGrokTurn both read config.transport fresh on
 * every call, so the next turn's spawn picks it up with no reconnect.
 */
const liveConfigs = new Map<string, AdapterConfig>();

/** Agents saved from the dashboard's Add agent panel — see savedAgents.ts. */
let savedAgents: SavedAgent[] = loadSavedAgents(config.dataDir);

/**
 * Room autoroute toggle state. Room has no field
 * for this (packages/shared is frozen) — persisted gateway-locally, same
 * shape-of-problem as router.json. Default OFF for every room, including a
 * freshly rolled-over Quad (spec: "Default OFF (the Lobby stays explicit)").
 */
const autorouteFilePath = join(config.dataDir, 'autoroute.json');
function loadAutorouteRooms(): Set<string> {
  if (!existsSync(autorouteFilePath)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(autorouteFilePath, 'utf8')) as { roomIds?: unknown };
    return new Set(Array.isArray(parsed.roomIds) ? parsed.roomIds.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveAutorouteRooms(): void {
  writeFileSync(autorouteFilePath, JSON.stringify({ roomIds: Array.from(autorouteRooms) }, null, 2), 'utf8');
}
const autorouteRooms = loadAutorouteRooms();

/**
 * Projects layer (Phase 3 Milestone E, slimmed — see projects.ts's doc
 * comment). Room has no projectId field (packages/shared is frozen) —
 * persisted gateway-locally to data/projects.json, same shape-of-problem as
 * autoroute.json. Reassigned (not mutated in place) on every change, same
 * atomicity as the file it mirrors.
 */
let projectsState: ProjectsState = loadProjects(config.dataDir);

/** `data/router.json`, created with defaults on boot if absent (ensureRouterConfig). */
const routerConfig: RouterConfig = ensureRouterConfig(config.dataDir);

/**
 * Loop-lite: `data/loops.json`,
 * created with `{}` on boot if absent (ensureLoopsConfig) — same gateway-
 * local-config idiom as router.json above. Keyed by roomId; at most one
 * ACTIVE loop per room (enforced by loop.ts's startLoop).
 */
const loopsConfig: LoopsConfig = ensureLoopsConfig(config.dataDir);

/**
 * Paperclip bridge wake:
 * process-lifetime-only state (see bridge.ts doc comments) — an in-memory
 * idempotency store and a registry of in-flight long-poll waits, both reset
 * on every gateway restart, same as busySeats/roomRelay before boot
 * rehydration above.
 */
const bridgeIdempotency = new BridgeIdempotencyStore();
const bridgeWaits = new BridgeWaitRegistry();

/**
 * Polls/Approvals rail: `data/polls.json`,
 * load-at-boot/save-on-mutation — same gateway-local-config idiom as
 * projects.json/autoroute.json above. Reassigned (not mutated in place) on
 * every change, same atomicity as every other `let ...State` in this file.
 */
let pollsState: PollsState = loadPolls(config.dataDir);

/**
 * Two-Reviewer Policy: `data/review-policy.json`, same load-at-boot/save-on-mutation
 * idiom as router.json/loops.json above. Default `mutations`. `tracker`
 * bundles the feature's only additional mutable bookkeeping (pending-wait
 * cancel functions + the per-poll card-deadline timer) — process-lifetime
 * only, same class as bridgeIdempotency/bridgeWaits above.
 */
let reviewPolicyState: ReviewPolicyState = loadReviewPolicy(config.dataDir);
const pollReviewTracker = new PollReviewTracker();

/** `data/paperclip.json`, boot-created with the seed company if absent (ensurePaperclipConfig — same idiom as ensureLoopsConfig). */
const paperclipConfig = ensurePaperclipConfig(config.dataDir);
const paperclipBaseUrl = process.env.PAPERCLIP_BASE_URL ?? DEFAULT_PAPERCLIP_BASE_URL;

/**
 * Free/local-only seat enforcement (mission spec: "never claude-code by
 * default"). Read literally, that means excluding EVERY subscription seat,
 * not just claude-code specifically — grok-build and openclaw are ALSO
 * kind:'subscription' today (see packages/adapters/*\/src/manifest.ts) and
 * would be excluded under this same check. Only kind:'local' (hermes today)
 * is a loop-eligible seat; there is no opt-in override in this build — a
 * seat's manifest is the only source of truth, so a future adapter cannot be
 * silently exempted by an id-based denylist that gets stale.
 */
function isLoopEligibleSeat(agentId: string): boolean {
  return agents.get(agentId)?.manifest.billing?.kind === 'local';
}

/**
 * Seats currently mid-turn (docs spec: candidates must be "not busy"). relay.ts's
 * per-agent worker queue is the real source of truth for in-flight turns but is
 * private to relay.ts (frozen, no exported "is this agent busy" query) — the
 * proxy available from OUTSIDE relay.ts is index.ts's own broadcast() call:
 * every relayMessageToAgents(...) call here hands a message to a known set of
 * agent ids (markBusy), and a SUCCESSFUL turn's completion always shows up as
 * a message.new broadcast with senderId = that agent (clearBusy, wired into
 * the broadcast() wrapper below).
 *
 * That happy-path clear is NOT lossless, though: a turn that errors
 * (AgentRelayWorker.handleEvent's 'error' branch, or the watchdog) never
 * reaches commitAgentReply, so it never broadcasts message.new — clearBusy
 * would never fire and a single failed turn would wedge that seat "busy"
 * forever, which is worse for the router than not tracking busy at all. The
 * map stores a timestamp instead of a bare membership flag so effectiveBusy()
 * can expire an entry after ROUTER_BUSY_MAX_MS — the same ceiling relay.ts's
 * OWN TURN_WATCHDOG_MS uses for "how long can one turn possibly still be
 * running", so a stuck flag self-heals no later than relay.ts's own watchdog
 * would have freed the real worker queue anyway.
 */
const ROUTER_BUSY_MAX_MS = 8 * 60 * 1000; // matches relay.ts's TURN_WATCHDOG_MS
const busySeats = new Map<string, number>();
function markBusy(agentIds: Iterable<string>): void {
  const now = Date.now();
  for (const id of agentIds) busySeats.set(id, now);
}
function clearBusy(agentId: string): void {
  busySeats.delete(agentId);
}
/** Busy set as router.ts's pure pick()/isSeatEligible() expect it — plain data, expiry resolved here, not baked into router.ts's API. */
function effectiveBusySeats(): Set<string> {
  const now = Date.now();
  const live = new Set<string>();
  for (const [id, at] of busySeats) {
    if (now - at < ROUTER_BUSY_MAX_MS) live.add(id);
  }
  return live;
}

for (const room of loadRooms(db)) {
  rooms.set(room.id, room);
}

/**
 * Vault memory layer v1: boot index + 60s
 * re-index timer, and per-room pin persistence. The
 * gateway only ever READS from the vault via MemoryIndex (readFileSync/
 * statSync/readdirSync) — never writes.
 */
const memoryIndex = new MemoryIndex();
memoryIndex.start();
let memoryPins: MemoryPins = loadPins(config.dataDir);

/**
 * Studio Dock registry: `data/dock-apps.json`
 * loaded once at boot — no editor UI in v1, the json file IS the interface, a
 * gateway restart picks up edits. loadDockApps() already drops malformed or
 * non-loopback entries (logged); see dockApps.ts.
 */
const dockApps = loadDockApps(config.dataDir);

/**
 * Boot rehydration: room token tallies,
 * room.costTracker, and globalCost.byAgent are all in-memory-only — recompute
 * them from the append-only cost_events log so budgets and cost meters
 * survive a gateway restart. Runs once here, before the WS server accepts any
 * connections, so no live cost.event can race the rehydration.
 */
const costTotals = recomputeCostTotals(db);
for (const [roomId, report] of costTotals.byRoom) {
  const room = rooms.get(roomId);
  if (!room) continue;
  room.costTracker = report;
  const rs: RoomRelayState = {
    agentTurnsSinceHuman: 0,
    paused: false,
    tokensUsed: report.tokensIn + report.tokensOut,
    tokenPaused: false,
    tokenExtensionUsed: false,
    lastWarnedPercent: 0,
  };
  // Re-derive pause/warned state at the room's PERSISTED cap (budgetCap.tokens
  // — the extension flag always starts unearned after a restart, matching a
  // fresh room.set-budget: docs spec ties the +25% grant to a live resume,
  // not to whatever was in flight when the gateway last stopped).
  const cap = room.budgetCap?.tokens;
  if (cap != null && cap > 0) {
    if (rs.tokensUsed >= cap) rs.tokenPaused = true;
    else if (rs.tokensUsed / cap >= 0.8) rs.lastWarnedPercent = 80;
  }
  roomRelay.set(roomId, rs);
}
for (const [agentId, totals] of costTotals.byAgent) {
  globalCost.byAgent[agentId] = totals;
}
globalCost.tokensIn = costTotals.global.tokensIn;
globalCost.tokensOut = costTotals.global.tokensOut;
globalCost.estimatedCostUsd = costTotals.global.estimatedCostUsd;

if (rooms.size === 0) {
  const quad: Room = {
    id: randomUUID(),
    name: 'Lobby',
    type: 'group',
    memberIds: ['human'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: config.defaultRoomTurnCap,
  };
  rooms.set(quad.id, quad);
  saveRoom(db, quad);
  persistDatabase(db, config.dataDir);
}

/**
 * the Lobby is the protected default room: rename/archive are rejected for it.
 * It is identified by the row the gateway itself creates — the oldest ACTIVE
 * room named 'Lobby' (loadRooms orders by created_at) — never by client
 * input. Rebindable (`let`): daily rollover
 * archives the current Quad under a dated name and rebinds this to the fresh
 * room, so protection and defaultActiveRoomId follow the NEW Quad. The name
 * 'Lobby' is reserved (validRoomName), so the active-room-by-name lookup
 * here is unambiguous.
 */
let quadRoomId = Array.from(rooms.values()).find(
  (r) => r.name === 'Lobby' && r.archivedAt == null
)?.id;

let defaultActiveRoomId =
  quadRoomId ?? Array.from(rooms.values()).find((r) => r.archivedAt == null)?.id;

/** Local calendar day (YYYY-MM-DD) of a timestamp — rollover is a LOCAL-day concept. */
function localDayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** True when the Lobby has messages and the newest is from a previous local day. */
function quadIsStale(): boolean {
  if (!quadRoomId) return false;
  const list = messages.get(quadRoomId) ?? [];
  const last = list[list.length - 1];
  return last != null && localDayKey(last.createdAt) !== localDayKey(Date.now());
}

/**
 * Quad daily rollover: archive the current
 * Quad as `Quad — YYYY-MM-DD` (local date of its LAST message — a Monday
 * rollover of Friday's chatter labels it Friday), start a fresh 'Lobby'
 * with the same members and turn cap, and rebind quadRoomId so protection
 * and defaultActiveRoomId follow the fresh room, not the archived daily.
 * Returns the fresh Quad's id, or null without side effects when there is
 * no active Quad or it has no messages — an empty Quad never rolls, so no
 * empty archived shells.
 */
function rolloverQuad(): string | null {
  if (!quadRoomId) return null;
  const quad = rooms.get(quadRoomId);
  if (!quad || quad.archivedAt != null) return null;
  const quadMessages = messages.get(quad.id) ?? [];
  const last = quadMessages[quadMessages.length - 1];
  if (!last) return null;

  const now = Date.now();
  const archived: Room = {
    ...quad,
    name: `Quad — ${localDayKey(last.createdAt)}`,
    archivedAt: now,
    updatedAt: now,
  };
  rooms.set(archived.id, archived);
  saveRoom(db, archived);

  const fresh: Room = {
    id: randomUUID(),
    name: 'Lobby',
    type: 'group',
    memberIds: [...quad.memberIds],
    createdAt: now,
    updatedAt: now,
    turnCap: quad.turnCap,
  };
  rooms.set(fresh.id, fresh);
  saveRoom(db, fresh);
  persistDatabase(db, config.dataDir);

  // The subtle bit (design note step 3): rebind AFTER both rows are written —
  // from here on, the Lobby protections and the default room point at the
  // fresh Quad, and the archived daily is plain history.
  quadRoomId = fresh.id;
  if (defaultActiveRoomId == null || defaultActiveRoomId === quad.id) {
    defaultActiveRoomId = fresh.id;
  }

  // Same lifecycle rule as room.archive: per-agent attachment copies live
  // only for the room's lifetime, and the daily's lifetime just ended.
  const attachmentIds = quadMessages.flatMap((m) => m.attachments?.map((a) => a.id) ?? []);
  cleanupAgentAttachmentCopies(config.dataDir, attachmentIds);

  broadcast(buildStateSync());
  return fresh.id;
}

function buildStateSync(): ServerEvent {
  const agentSummaries = Array.from(agents.entries()).map(([id, s]) => {
    const summary = toAgentSummary(id, s);
    // Agent source (owner-directed, right-hand agent info
    // panel): AgentSummary has no field for this (packages/shared frozen) —
    // additive per-agent key, same cast idiom as verificationBadge below.
    // Always present (every manifest declares a default; connectAgent
    // resolves any per-seat override once, at connect time — see
    // agents.ts's resolveAgentSource/manifestSource).
    const withSource = { ...summary, source: manifestSource(s.manifest) };
    // Last-reply surfacing: ISO timestamp of this seat's last successful
    // room message, written by broadcast()'s message.new handler above.
    // AgentSummary has no field for this (packages/shared frozen) — same
    // additive-key cast idiom as `source` just above. Undefined (omitted
    // from the JSON, same as any other undefined-valued key) when the seat's
    // current connection has never produced a room message — tools/tiles
    // read absence as "no reply yet this connection", not "unknown".
    const withReply = { ...withSource, lastReplyAt: seatLastReplyAt(s) };
    // Verification-tier badge:
    // AgentSummary has no field for this (packages/shared frozen) — additive
    // per-agent key, same cast idiom as the payload-level additive fields
    // below (polls/projects/dockApps). "Status vocabulary unchanged" per the
    // the original design — status stays VERIFIED; this is purely a display hint the
    // UI uses to render ATTESTED instead of VERIFIED for these seats.
    return isAttestedManifest(s.manifest) ? { ...withReply, verificationBadge: 'ATTESTED' } : withReply;
  });
  return {
    type: 'state.sync',
    payload: {
      agents: agentSummaries,
      // Soft-archived rooms stay in the map/DB but never reach clients.
      rooms: Array.from(rooms.values()).filter((r) => r.archivedAt == null),
      activeRoomId: defaultActiveRoomId,
      // Projects layer (Milestone E, slimmed): additive fields on the same
      // state.sync payload rather than a separate endpoint, so every open
      // tab self-heals for archived rooms + project groupings the same way
      // it already does for everything else (one broadcast, one refresh) —
      // ServerEvent has no dedicated fields for these (packages/shared is
      // frozen), so the whole return value is cast at the two endpoints that
      // read the extra keys (here and gatewayStore.ts's state.sync case),
      // same pattern as room.autoroute.status elsewhere in this file.
      // WINDOWED (review 2026-08-04 §4.2): the 50 most recently updated
      // archived rooms, not all 886 of them. This field was 283.4 KB of a
      // 330.1 KB payload — 86% — re-serialized per client on every broadcast
      // including an unconditional 60 s tick. Same treatment `polls` above
      // already gets (open + last 20); older rows page in from
      // GET /api/rooms/archived?before=. See roomWindow.ts for why the
      // ascending order is preserved rather than flipped to newest-first.
      archivedRooms: archivedRoomsForStateSync(rooms.values()),
      projects: projectsState.projects,
      projectAssignments: projectsState.assignments,
      // Polls/Approvals rail (Wave 4): open polls (any room) + last 20
      // decided/expired, same additive-field-on-state.sync pattern as the
      // projects fields above — ServerEvent has no dedicated field for this
      // either, so the whole return value stays cast at the two endpoints
      // that read it (here and gatewayStore.ts's state.sync case).
      polls: pollsForStateSync(pollsState),
      // Two-Reviewer Policy:
      // review rows for exactly the polls above (open + last 20 settled —
      // pollReviewsForStateSync reuses pollsForStateSync's own windowing) +
      // the current policy mode, same additive-field cast idiom as polls
      // above. No dedicated ServerEvent field (shared frozen); read at the
      // same two endpoints (here and gatewayStore.ts's state.sync case).
      pollReviews: pollReviewsForStateSync(db, pollsState),
      reviewPolicy: reviewPolicyState,
      // Studio Dock registry: static per-boot
      // list, same additive-field cast idiom as polls/projects above. No
      // dedicated ServerEvent field (shared frozen); read at the same two
      // endpoints.
      dockApps,
      // Agent Dossiers: "dossiersDir config unset (default) = feature hidden
      // entirely" — a boolean flag, not the path itself (the dossiers
      // directory location is a server-local filesystem detail with no
      // reason to reach the client), so InspectPanel can skip rendering the
      // Dossier tab at all rather than rendering it and 404ing on open.
      dossiersEnabled: dossiersDir() != null,
      // TEMP-agent "on duty" presence (2026-08-02): additive field, same
      // cast-at-the-endpoint idiom as verificationBadge/polls/dockApps above
      // — ServerEvent has no dedicated field for this (packages/shared
      // frozen). ephemeralPresence.list() already filters out anything past
      // its expiresAt, so a client that hasn't refreshed in a while never
      // sees a stale ghost entry between sweeps.
      ephemeral: ephemeralPresence.list(),
      // Seat ids of agents saved from the Add agent panel (ids only — the
      // saved transport config can hold API keys and never leaves the gateway).
      savedAgentIds: savedAgents.map((s) => s.seatId),
    },
  } as unknown as ServerEvent;
}

const clients = new Set<WebSocket>();

/** Server->client readback for a room's loop state, typed at the two endpoints (room.rollover/room.autoroute.status precedent) since ServerEvent has no dedicated type for this. */
function broadcastLoopStatus(roomId: string): void {
  const loop = loopsConfig[roomId];
  broadcast({
    type: 'loop.status',
    payload: loop
      ? {
          roomId,
          active: loop.active,
          round: loop.round,
          maxRounds: loop.maxRounds,
          phase: loop.phase,
          builderSeat: loop.builderSeat,
          judgeSeat: loop.judgeSeat,
        }
      : { roomId, active: false },
  } as unknown as ServerEvent);
}

/**
 * Loop-lite driver (Wave 2). Called from broadcast() below whenever a
 * message.new fires for the seat whose turn it currently is in an ACTIVE
 * loop for that room — the SAME observation seam the Router's busySeats
 * tracking already uses (see broadcast()'s doc comment), not a new listener
 * infrastructure and not an edit to relay.ts.
 *
 * Coexistence with turn-cap/token-budget pauses (risk flagged by the scout):
 * relayMessageToAgents silently no-ops when the room is paused/tokenPaused,
 * which would desync the loop's round counter from what actually got
 * delivered. Guarded here by checking getRoomRelayState BEFORE advancing —
 * if paused, the loop's phase/round are left untouched (no action applied,
 * no relay call made) so the NEXT message.new (once a human message clears
 * the pause) re-evaluates from the same, still-correct state.
 */
function handleLoopTurn(roomId: string, msg: Message): void {
  const loop = loopsConfig[roomId];
  if (!loop?.active) return;

  const room = rooms.get(roomId);
  if (!room || room.archivedAt != null) {
    stopLoop(loopsConfig, roomId);
    saveLoopsConfig(config.dataDir, loopsConfig);
    broadcastLoopStatus(roomId);
    return;
  }

  const action = decideNext(loop, msg.senderId, msg.content);
  if (action.kind === 'noop') return;

  const rs = getRoomRelayState(roomRelay, roomId);
  if (rs.paused || rs.tokenPaused) {
    // Do not advance/persist — see doc comment above. The loop will retry
    // decideNext on the next message.new once a human message resumes the
    // room, at which point this same action (or whatever the state is by
    // then) is recomputed fresh.
    return;
  }

  applyLoopAction(loop, action);
  saveLoopsConfig(config.dataDir, loopsConfig);

  if (action.kind === 'stop-approved') {
    postSystemLine(roomId, `→ loop: @${loop.judgeSeat} approved after round ${loop.round} — stopped.`);
    broadcastLoopStatus(roomId);
    return;
  }
  if (action.kind === 'stop-max-rounds') {
    postSystemLine(roomId, `→ loop: reached maxRounds (${loop.maxRounds}) without approval — stopped.`);
    broadcastLoopStatus(roomId);
    return;
  }

  // advance-to-judge / advance-to-builder: address the OTHER seat, exactly
  // the Router's own call shape — a mentions-patched clone of the message
  // that just landed, delivered via relay.ts's unmodified, exported
  // relayMessageToAgents. This is the loop's addressing mechanism; it never
  // parses the speaker's own message for an @-redirect.
  const nextSeat = action.kind === 'advance-to-judge' ? loop.judgeSeat : loop.builderSeat;
  if (!isLoopEligibleSeat(nextSeat) || !room.memberIds.includes(nextSeat)) {
    postSystemLine(roomId, `→ loop: @${nextSeat} is no longer eligible (offline/removed) — stopped.`);
    stopLoop(loopsConfig, roomId);
    saveLoopsConfig(config.dataDir, loopsConfig);
    broadcastLoopStatus(roomId);
    return;
  }
  postSystemLine(
    roomId,
    `→ loop round ${loop.round + 1}/${loop.maxRounds}: @${nextSeat}'s turn (${action.kind === 'advance-to-judge' ? 'review' : 'revise'}).`
  );
  markBusy([nextSeat]);
  relayMessageToAgents(relayDeps, roomId, { ...msg, mentions: [nextSeat] });
  broadcastLoopStatus(roomId);
}

function broadcast(event: ServerEvent) {
  // Router busy-tracking: a message.new authored by a
  // known agent is that agent's turn completing — relay.ts's commitAgentReply
  // is the only place this fires, and it fires exactly once per turn, so this
  // is a lossless clear point for the busySeats markBusy above set at enqueue
  // time. Not observing relay.ts internals — this reads the SAME broadcast
  // every client already receives.
  if (event.type === 'message.new' && agents.has(event.payload.senderId)) {
    clearBusy(event.payload.senderId);
    // lastReplyAt surfacing (2026-07-28, router-side last-reply surfacing):
    // the SAME lossless one-shot-per-turn observation point as the busySeats
    // clear above — commitAgentReply has already called insertMessage by the
    // time this fires, so this is a persisted, successful room message, not
    // a delivery attempt. event.payload.createdAt (not Date.now()) so the
    // stamp reflects when the message was actually authored.
    const seatState = agents.get(event.payload.senderId);
    if (seatState) recordSeatReply(seatState, event.payload.createdAt);
  }
  // Loop-lite (Wave 2): the SAME message.new broadcast is the driver's only
  // observation point (see handleLoopTurn's doc comment). Runs after the
  // busySeats clear above so a freshly-cleared seat is available if the
  // driver's own relayMessageToAgents call below immediately marks it busy
  // again for the next turn.
  if (event.type === 'message.new' && event.payload.senderId !== 'human') {
    handleLoopTurn(event.payload.roomId, event.payload);
  }
  // Paperclip bridge wake (F2a): the SAME message.new broadcast is the
  // long-poll's only observation point (see BridgeWaitRegistry.observe's doc
  // comment) — not a new listener, not relay.ts internals, same seam
  // loop-lite's driver already uses above.
  if (event.type === 'message.new') {
    const msg = event.payload;
    bridgeWaits.observe(msg.roomId, msg.senderId, {
      messageId: msg.id,
      text: msg.content,
      senderId: msg.senderId,
      ts: msg.createdAt,
      replyTo: msg.replyTo,
    });
  }
  // Serialize ONCE for the whole fan-out, not once per client (review
  // 2026-08-04 §4.3): sendEnvelope used to JSON.stringify the full payload
  // for every socket, making a broadcast O(clients x payload) of
  // serialization instead of O(clients) of socket writes. state.sync is the
  // hot case and every open tab, tile and phone multiplies it.
  const serialized = serializeEnvelope(event);
  for (const ws of clients) {
    sendSerializedEnvelope(ws, serialized);
  }
}

const relayDeps: RelayDeps = {
  db,
  dataDir: config.dataDir,
  agents,
  rooms,
  messages,
  roomRelay,
  globalCost,
  broadcast,
  agentDisplayName: (agentId) => agents.get(agentId)?.manifest.displayName ?? agentId,
  // Vault memory layer v1 pinned-context wiring
  // for relay.ts's compose-layer prepend (see relayMessageToAgents' FLAGGED
  // comment). `memoryPins` is reassigned (not mutated) on every pin/unpin —
  // these closures read the module-scoped `let` binding, so they always see
  // the current pin set without relayDeps itself needing to be rebuilt.
  getMemoryPinsForRoom: (roomId) => memoryPins[roomId] ?? [],
  getPinnedNote: (path) => memoryIndex.get(path),
};

// Auto-rollover at boot: a Quad whose newest
// message is from a previous local day is yesterday's daily — roll it now,
// before the WS server accepts any client, so the first state.sync already
// shows the fresh Quad. (broadcast is a no-op here: no clients yet.)
if (quadIsStale()) rolloverQuad();

/**
 * Post a persisted, broadcast system-line message into the room — same
 * insert/broadcast shape the chat.send handler already uses for a human
 * message, just with senderId: 'system' (no such sender existed before the
 * router; MessageBubble's existing human/agent fallback renders it as plain
 * text, which is correct — inventing new UI chrome for one sender is exactly
 * the over-build the "no painted status" rule warns against).
 */
function postSystemLine(roomId: string, content: string): void {
  const line: Message = {
    id: randomUUID(),
    roomId,
    senderId: 'system',
    content,
    createdAt: Date.now(),
  };
  insertMessage(db, line);
  persistDatabase(db, config.dataDir);
  const list = messages.get(roomId) ?? [];
  list.push(line);
  messages.set(roomId, list);
  broadcast({ type: 'message.new', payload: line });
}

/**
 * Two-Reviewer Policy wiring:
 * the SAME live maps/closures every other route/handler in this file reads,
 * threaded explicitly (pollReviews.ts precedent: bridge.ts/pollsRoutes.ts).
 * Reuses `bridgeWaits` — the SAME BridgeWaitRegistry instance bridge.ts's own
 * route and escalateRoutes.ts already observe message.new against below (its
 * observe() is generic over any (roomId, seatId) pair).
 */
const pollReviewsCtx: PollReviewRouteContext = {
  relayDeps,
  agents,
  rooms,
  messages,
  db,
  dataDir: config.dataDir,
  projectRoot,
  defaultRoomTurnCap: config.defaultRoomTurnCap,
  broadcast,
  markBusy,
  persistRoomMutation,
  postSystemLine,
  waits: bridgeWaits,
  getReviewPolicy: () => reviewPolicyState,
  setReviewPolicy: (state) => {
    reviewPolicyState = state;
  },
  getPoll: (pollId) => findPoll(pollsState, pollId),
  humanToken,
  getPollsState: () => pollsState,
};

/**
 * Polls/Approvals rail wiring:
 * decide/create/settle/sweep logic lives in pollsRoutes.ts (pure/testable
 * against a fake context, same split as bridge.ts) — this context object is
 * the SAME live maps/closures every other route/handler in this file reads,
 * threaded explicitly so pollsRoutes.ts never touches index.ts's module-
 * scoped state directly.
 */
const pollsRouteCtx: PollsRouteContext = {
  relayDeps,
  agents,
  rooms,
  messages,
  db,
  dataDir: config.dataDir,
  projectRoot,
  paperclipBaseUrl,
  getPollsState: () => pollsState,
  setPollsState: (state) => {
    pollsState = state;
  },
  broadcast,
  markBusy,
  broadcastStateSync: () => broadcast(buildStateSync()),
  postSystemLine,
  humanToken,
  // Two-Reviewer Policy (Wave 7 M3): every poll that settles (manual decide
  // OR expiry sweep) cancels/finalizes its pending reviews and backfills the
  // human decision onto the ledger — see pollReviews.ts's onPollSettled doc
  // comment. notifyPollSettled already wraps this call in its own try/catch.
  onPollSettled: (poll) => onPollReviewsSettled(pollReviewsCtx, pollReviewTracker, poll),
};

sweepAndSettlePolls(pollsRouteCtx); // boot rehydrate — a poll that expired while the gateway was down settles now, before any client connects.
setInterval(() => sweepAndSettlePolls(pollsRouteCtx), 30_000);

/**
 * Paperclip bridge-in poller: 60s interval over every
 * configured company, isolated per paperclip.ts's own doc comments — a
 * down/unreachable Paperclip must never affect the gateway (verified by the
 * paperclip.test.ts isolation test). find-or-create the human-only
 * "Approvals" room via the SAME persistRoomMutation helper every other
 * room-creating call site in this file uses, so a fresh room shows up in
 * state.sync exactly like any other.
 *
 * 2026-07-28: the room heal runs at the TOP of every poll cycle inside
 * runPaperclipPollOnce — boot call below + 60s interval re-ensure the room
 * even when Paperclip is down or unconfigured (decoupled after the
 * 2026-07-23 silent room loss; see paperclip.ts module doc comment).
 */
function findOrCreateApprovalsRoom(): Room {
  const existing = findApprovalsRoom(rooms);
  if (existing) return existing;
  const room: Room = {
    id: randomUUID(),
    name: APPROVALS_ROOM_NAME,
    type: 'group',
    memberIds: [], // human-only room, no agent members (design doc §4)
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: config.defaultRoomTurnCap,
  };
  persistRoomMutation(room);
  return room;
}
function runPaperclipPollTick(): void {
  void runPaperclipPollOnce({
    dataDir: config.dataDir,
    baseUrl: paperclipBaseUrl,
    config: paperclipConfig,
    rooms,
    findOrCreateApprovalsRoom,
    getPollsState: () => pollsState,
    setPollsState: (state) => {
      pollsState = state;
      savePolls(config.dataDir, pollsState);
    },
    onPollCreated: (poll) => broadcastPollUpdated(pollsRouteCtx, poll),
  }).then(() => broadcast(buildStateSync()));
}

/**
 * The Router. Called from the
 * chat.send handler BEFORE relayMessageToAgents(...) is reached — router.ts's
 * classify()/pick() decide, this function carries out the decision using
 * relay.ts's OWN exported, unmodified relayMessageToAgents (targeted via a
 * mentions-patched clone of `msg`, never relay.ts internals).
 *
 * Two independent triggers, per the original design:
 *   1. `@router <msg>` anywhere in the content — always routes, in any room,
 *      regardless of autoroute. "router is one more alias target."
 *   2. Room autoroute is ON and the message is otherwise UN-ADDRESSED (the
 *      normal resolveRelayTargets(...) resolves to nobody) — routes instead
 *      of reaching nobody. An already-addressed message (an explicit
 *      @mention or a reply-to-agent) is left alone even in an autoroute room.
 *
 * Returns true when it handled the message (routed, or failed loud with a
 * visible error) — the caller must NOT also run the normal relay path in
 * that case. Returns false when neither trigger applies, so the caller
 * proceeds with plain onRoomChatMessage as before.
 */
function routeAndRelay(ws: WebSocket, room: Room, msg: Message, normalTargets: string[]): boolean {
  // "@router @grok-build fix this" defers to the human's EXPLICIT seat — the
  // router only routes when it is the sole addressee (adversarial-review
  // finding, 7/7: a co-mentioned seat should win over the router's pick).
  const routerMentioned = hasRouterMention(msg.content) && normalTargets.length === 0;
  const autorouteApplies =
    !routerMentioned && msg.senderId === 'human' && normalTargets.length === 0 && autorouteRooms.has(room.id);
  if (!routerMentioned && !autorouteApplies) return false;

  const preset = activePresetOf(routerConfig);
  if (!preset) {
    roomError(ws, 'router', 'No router preset configured.');
    return true;
  }

  const cls = classify(msg.content);
  const result = pick(cls, preset, agents, room.memberIds, effectiveBusySeats());

  appendRouterLog(config.dataDir, {
    ts: Date.now(),
    roomId: room.id,
    cls,
    chosen: result.chosen,
    candidatesTried: result.tried,
  });

  if (!result.chosen) {
    // Fail loud (docs spec) — a visible room message, never a silent drop.
    postSystemLine(
      room.id,
      `→ router: no free seat for this message (class: ${cls}; tried: ${result.tried.join(', ') || 'none configured'}).`
    );
    return true;
  }

  broadcast({
    type: 'router.routed',
    payload: { roomId: room.id, messageId: msg.id, cls, chosen: result.chosen, tried: result.tried },
  });
  postSystemLine(room.id, `→ routed to @${result.chosen} (${cls})`);

  // Deliver the ORIGINAL message content to exactly the chosen seat: relay.ts's
  // resolveRelayTargets (frozen, unmodified) picks a human sender's specific
  // mentions when present, so a mentions-patched in-memory clone routes
  // relayMessageToAgents to precisely this one seat — the persisted message
  // the human sees keeps their own literal text (e.g. "@router ...").
  markBusy([result.chosen]);
  relayMessageToAgents(relayDeps, room.id, { ...msg, mentions: [result.chosen] });
  return true;
}

/**
 * Room-name rule: trimmed, 1..60 chars. Returns the
 * trimmed name, or null after broadcasting an error. Payloads come off the
 * wire, so the runtime type is checked too — never trust the client.
 */
function validRoomName(ws: WebSocket, code: string, raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 60) {
    roomError(ws, code, 'Room name must be 1–60 characters after trimming.');
    return null;
  }
  // Reserved: the Lobby is identified by this exact name at boot (quadRoomId),
  // and daily rollover keeps recreating it. A client-created twin would make
  // the boot binding ambiguous — protection could land on the wrong room.
  if (name === 'Lobby') {
    roomError(ws, code, "'Lobby' is reserved for the default room.");
    return null;
  }
  return name;
}

/**
 * memberIds are filtered to KNOWN agents in any status — an OFFLINE member
 * simply receives no relay until verified (relay filters to VERIFIED itself).
 * The human seat is implicitly a member of every room and is never stored.
 */
function sanitizeMemberIds(raw: unknown): string[] {
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  return Array.from(new Set(ids)).filter((id) => agents.has(id));
}

/**
 * Every room mutation: persist via db helpers, then broadcast a fresh
 * state.sync. The expensive parts (full-DB disk write, full-state
 * broadcast) are coalesced across any calls that land in the same
 * event-loop turn — see roomPersistBatch.ts's header comment for the full
 * root-cause writeup. `rooms.set`/`saveRoom` stay synchronous on every call, so
 * this is not a correctness-visible change for a single mutation — only a
 * burst of them.
 */
const triggerRoomPersist = createBatchedRunner(() => {
  persistDatabase(db, config.dataDir);
  broadcast(buildStateSync());
});
function persistRoomMutation(room: Room) {
  rooms.set(room.id, room);
  saveRoom(db, room);
  triggerRoomPersist();
}

// Start the Paperclip poll only now: its room heal calls persistRoomMutation,
// which needs triggerRoomPersist (a const defined just above) to be initialized.
runPaperclipPollTick(); // boot rehydrate — first sync doesn't wait a full 60s.
setInterval(runPaperclipPollTick, 60_000);

interface ConnectSeatRequest {
  manifestId: string;
  instanceId?: string;
  instanceLabel?: string;
  config: AdapterConfig;
}

/**
 * Connect + verify one seat and broadcast the result. Shared by the
 * agent.connect WebSocket event, startup reconnect of saved agents, and the
 * Wake fleet button. Throws on a malformed request (bad instanceId, invalid
 * modelPattern); a seat that connects but fails verification resolves with
 * status FAILED and a statusReason instead.
 */
async function connectSeat(request: ConnectSeatRequest): Promise<{ agentId: string; status: AgentStatus; statusReason?: string }> {
  const { manifestId, instanceId, instanceLabel, config: adapterConfig } = request;
  // Validate before deriving anything from it — a malformed instanceId is
  // rejected here rather than handed to connectAgent after a workspace path
  // has already been resolved from the bad slug.
  if (instanceId && instanceId !== 'main' && !isValidInstanceId(instanceId)) {
    throw new Error(`Invalid instanceId "${instanceId}": must match [a-z0-9-]{1,16} (no '#').`);
  }
  const seatId = deriveSeatId(manifestId, instanceId);
  let cfg: AdapterConfig = {
    ...adapterConfig,
    workspace: adapterConfig.workspace ?? join(workspaceRoot, seatId),
  };
  if (manifestId === 'hermes') {
    cfg = await resolveHermesAdapterConfig(cfg);
  }
  // connectAgent returns the EXISTING status for an already-connected seat
  // without calling adapter.connect(cfg) again, so only record cfg as the
  // live config when the session identity actually changed.
  const sessionBeforeConnect = agents.get(seatId)?.session;
  const connecting = connectAgent(
    manifestId,
    cfg,
    agents,
    workspaceRoot,
    defaultActiveRoomId ? { deps: relayDeps, defaultRoomId: defaultActiveRoomId } : undefined,
    { instanceId, instanceLabel }
  );
  // connectAgent registers the seat as CONNECTING before its first await, so
  // this sync shows the new agent in the list right away rather than only
  // once the (possibly minute-long) proof-of-life check has finished.
  broadcast(buildStateSync());
  const { agentId, status, statusReason } = await connecting;
  if (agents.get(agentId)?.session !== sessionBeforeConnect) {
    liveConfigs.set(agentId, cfg);
  }
  broadcast({
    type: 'agent.status',
    payload: { agentId, status, reason: statusReason, health: agents.get(agentId)?.health },
  });
  broadcast(buildStateSync());
  return { agentId, status, statusReason };
}

/** Reconnect every saved agent that is not already VERIFIED, one at a time (CLI harnesses racing each other can lose the nonce-file challenge). */
async function reconnectSavedAgents(): Promise<WakeOutcome[]> {
  const outcomes: WakeOutcome[] = [];
  for (const saved of savedAgents) {
    const live = agents.get(saved.seatId);
    if (live?.session && live.status === 'VERIFIED') {
      outcomes.push({ id: saved.seatId, status: 'VERIFIED' });
      continue;
    }
    try {
      const result = await connectSeat(saved);
      outcomes.push({ id: result.agentId, status: result.status, reason: result.statusReason });
    } catch (e) {
      outcomes.push({ id: saved.seatId, status: 'FAILED', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

async function handleClientEvent(ws: WebSocket, envelope: ClientEnvelope) {
  // room.rollover is handled before the switch:
  // packages/shared is frozen, so this event is typed
  // at its two endpoints (here and the UI sender) instead of the shared
  // ClientEvent union — identical wire shape, and server-validated to the
  // CURRENT Quad only, so a forged/stale roomId can never roll another room.
  if ((envelope as { type: string }).type === 'room.rollover') {
    const payload = (envelope as unknown as { payload?: { roomId?: unknown } }).payload;
    if (typeof payload?.roomId !== 'string' || payload.roomId !== quadRoomId) {
      roomError(ws, 'room.rollover', 'Only the current Quad can be rolled over.');
      return;
    }
    if (!rolloverQuad()) {
      roomError(ws, 'room.rollover', 'the Lobby has no messages yet — nothing to roll over.');
    }
    return;
  }
  // poll.decide is handled before
  // the switch too — packages/shared is frozen, so this is typed identically
  // at the two endpoints (here and the UI sender) instead of extending
  // ClientEvent, same idiom as room.rollover above.
  if ((envelope as { type: string }).type === 'poll.decide') {
    const payload = (envelope as unknown as {
      payload?: { pollId?: unknown; optionId?: unknown; note?: unknown; humanToken?: unknown };
    }).payload;
    const pollId = payload?.pollId;
    const optionId = payload?.optionId;
    const note = typeof payload?.note === 'string' ? payload.note : undefined;
    if (typeof pollId !== 'string' || typeof optionId !== 'string') {
      roomError(ws, 'poll.decide', 'poll.decide requires pollId and optionId (strings).');
      return;
    }
    // Human-seats-only: every connection accepted by THIS
    // WebSocketServer IS a human browser tab — agents in this gateway
    // connect via their own adapter.connect() sessions (agents.ts) and never
    // hold an entry in `clients`, so there is no "agent connection" among
    // `clients` to distinguish/reject. Documented honestly per the design
    // doc's own fallback instruction, rather than adding a check against a
    // distinction this codebase's architecture does not have.
    //
    // humanToken: the
    // REAL gate — a raw non-browser WS client that merely passes the Origin
    // check above is not, by itself, evidence of a human hand on the mouse.
    // handlePollDecide checks payload.humanToken against the boot-minted
    // token (delivered only via the served index.html) BEFORE touching
    // poll state; a missing/wrong token fails the same way any other
    // rejected decide does (roomError to the offending client only).
    const result = handlePollDecide(pollsRouteCtx, pollId, optionId, 'human', note, payload?.humanToken);
    if (!result.ok) {
      roomError(ws, 'poll.decide', result.error);
    }
    return;
  }
  // poll.defer / poll.info-requested — same endpoint-typed-cast idiom as poll.decide/
  // room.rollover above (packages/shared frozen; two-endpoint precedent is
  // here + the UI sender). Both are human-seats-only for the same reason
  // poll.decide is: every connection this WebSocketServer accepts IS a human
  // browser tab.
  if ((envelope as { type: string }).type === 'poll.defer') {
    const payload = (envelope as unknown as { payload?: { pollId?: unknown; note?: unknown } }).payload;
    const pollId = payload?.pollId;
    const note = typeof payload?.note === 'string' ? payload.note : undefined;
    if (typeof pollId !== 'string') {
      roomError(ws, 'poll.defer', 'poll.defer requires pollId (string).');
      return;
    }
    const result = handlePollDefer(pollsRouteCtx, pollId, 'human', note);
    if (!result.ok) {
      roomError(ws, 'poll.defer', result.error);
    }
    return;
  }
  if ((envelope as { type: string }).type === 'poll.info-requested') {
    const payload = (envelope as unknown as { payload?: { pollId?: unknown; note?: unknown } }).payload;
    const pollId = payload?.pollId;
    const note = typeof payload?.note === 'string' ? payload.note : undefined;
    if (typeof pollId !== 'string') {
      roomError(ws, 'poll.info-requested', 'poll.info-requested requires pollId (string).');
      return;
    }
    const result = handlePollInfoRequested(pollsRouteCtx, pollId, 'human', note);
    if (!result.ok) {
      roomError(ws, 'poll.info-requested', result.error);
    }
    return;
  }
  // Projects layer (Milestone E, slimmed — see projects.ts doc comment):
  // five more gateway-local extensions of the frozen shared ClientEvent
  // union, same endpoint-typed-cast idiom as room.rollover above. All five
  // share one persist-then-broadcast tail, so they're handled together here
  // rather than five separate top-level `if` blocks.
  {
    const rawType = (envelope as { type: string }).type;
    const isProjectEvent =
      rawType === 'project.create' ||
      rawType === 'project.rename' ||
      rawType === 'project.delete' ||
      rawType === 'room.set-project' ||
      rawType === 'room.unarchive';
    if (isProjectEvent) {
      const payload = (envelope as unknown as { payload?: Record<string, unknown> }).payload ?? {};
      let mutated = false;
      switch (rawType) {
        case 'project.create': {
          const result = createProject(projectsState, payload.name);
          if (!result.ok) {
            roomError(ws, 'project.create', result.error);
            break;
          }
          projectsState = result.state;
          mutated = true;
          break;
        }
        case 'project.rename': {
          if (typeof payload.projectId !== 'string') {
            roomError(ws, 'project.rename', 'Missing projectId.');
            break;
          }
          const result = renameProject(projectsState, payload.projectId, payload.name);
          if (!result.ok) {
            roomError(ws, 'project.rename', result.error);
            break;
          }
          projectsState = result.state;
          mutated = true;
          break;
        }
        case 'project.delete': {
          if (typeof payload.projectId !== 'string') {
            roomError(ws, 'project.delete', 'Missing projectId.');
            break;
          }
          const result = deleteProject(projectsState, payload.projectId);
          if (!result.ok) {
            roomError(ws, 'project.delete', result.error);
            break;
          }
          projectsState = result.state;
          mutated = true;
          break;
        }
        case 'room.set-project': {
          const { roomId, projectId } = payload;
          if (typeof roomId !== 'string' || !rooms.has(roomId)) {
            roomError(ws, 'room.set-project', 'Room not found.');
            break;
          }
          if (projectId !== null && typeof projectId !== 'string') {
            roomError(ws, 'room.set-project', 'projectId must be a string or null.');
            break;
          }
          const result = setRoomProject(projectsState, roomId, projectId);
          if (!result.ok) {
            roomError(ws, 'room.set-project', result.error);
            break;
          }
          projectsState = result.state;
          mutated = true;
          break;
        }
        case 'room.unarchive': {
          const { roomId } = payload;
          const room = typeof roomId === 'string' ? rooms.get(roomId) : undefined;
          if (!room || room.archivedAt == null) {
            roomError(ws, 'room.unarchive', 'Room not found or not archived.');
            break;
          }
          // Belt-and-suspenders (risk flagged in the scout report): rollover
          // never names an archived daily literally 'Lobby', so this is
          // unreachable under the current naming scheme — but un-archive
          // must never be the path that lets a second live room claim the
          // reserved name if that scheme ever regresses.
          if (room.name === 'Lobby') {
            roomError(ws, 'room.unarchive', "'Lobby' cannot be restored via un-archive.");
            break;
          }
          // Clearing archivedAt already makes buildStateSync's filter include
          // this room for free, and persistRoomMutation already broadcasts a
          // fresh state.sync — no extra broadcast needed here.
          persistRoomMutation({ ...room, archivedAt: undefined, updatedAt: Date.now() });
          return;
        }
        default:
          break;
      }
      if (mutated) {
        saveProjects(config.dataDir, projectsState);
        broadcast(buildStateSync());
      }
      return;
    }
  }
  // loop.start / loop.stop are
  // handled before the switch too — same reason as room.rollover above:
  // packages/shared is frozen, so these are typed identically at the two
  // endpoints (here and the UI sender) instead of extending ClientEvent.
  if ((envelope as { type: string }).type === 'loop.start') {
    const payload = (envelope as unknown as {
      payload?: { roomId?: unknown; builderSeat?: unknown; judgeSeat?: unknown; maxRounds?: unknown };
    }).payload;
    const roomId = payload?.roomId;
    const builderSeat = payload?.builderSeat;
    const judgeSeat = payload?.judgeSeat;
    const maxRounds = payload?.maxRounds;
    if (typeof roomId !== 'string' || typeof builderSeat !== 'string' || typeof judgeSeat !== 'string' || typeof maxRounds !== 'number') {
      roomError(ws, 'loop.start', 'loop.start requires roomId, builderSeat, judgeSeat (strings) and maxRounds (number).');
      return;
    }
    const room = rooms.get(roomId);
    if (!room || room.archivedAt != null) {
      roomError(ws, 'loop.start', 'Room not found.');
      return;
    }
    // Server-validated (never trust the client dropdown): both seats must be
    // CURRENT room members and loop-eligible (VERIFIED + free/local billing
    // per isLoopEligibleSeat — mission spec "never claude-code by default").
    for (const seat of [builderSeat, judgeSeat]) {
      if (!room.memberIds.includes(seat)) {
        roomError(ws, 'loop.start', `${seat} is not a member of this room.`);
        return;
      }
      const state = agents.get(seat);
      if (!state || state.status !== 'VERIFIED' || !state.session) {
        roomError(ws, 'loop.start', `${seat} is not VERIFIED and connected.`);
        return;
      }
      if (!isLoopEligibleSeat(seat)) {
        roomError(ws, 'loop.start', `${seat} is not a free/local seat — loop-lite only runs on kind:'local' billing (never claude-code by default).`);
        return;
      }
    }
    const result = startLoop(loopsConfig, roomId, builderSeat, judgeSeat, maxRounds);
    if (!result.ok) {
      roomError(ws, 'loop.start', result.error?.message ?? 'Could not start loop.');
      return;
    }
    saveLoopsConfig(config.dataDir, loopsConfig);
    postSystemLine(roomId, `→ loop started: @${builderSeat} (builder) ⇄ @${judgeSeat} (judge), max ${maxRounds} rounds.`);
    markBusy([builderSeat]);
    broadcastLoopStatus(roomId);
    return;
  }
  if ((envelope as { type: string }).type === 'loop.stop') {
    const payload = (envelope as unknown as { payload?: { roomId?: unknown } }).payload;
    const roomId = payload?.roomId;
    if (typeof roomId !== 'string') {
      roomError(ws, 'loop.stop', 'loop.stop requires a roomId.');
      return;
    }
    const stopped = stopLoop(loopsConfig, roomId);
    if (stopped) {
      saveLoopsConfig(config.dataDir, loopsConfig);
      const loop = loopsConfig[roomId];
      postSystemLine(roomId, `→ loop stopped manually after round ${loop?.round ?? 0}.`);
    }
    broadcastLoopStatus(roomId);
    return;
  }
  switch (envelope.type) {
    case 'chat.send': {
      const { message } = envelope.payload;
      let roomId = envelope.payload.roomId;
      if (!rooms.has(roomId)) return;
      // Auto-rollover on the first human message of a new local day: roll
      // first, then deliver this message into the FRESH Quad (design note) —
      // it becomes the new daily's first message instead of extending
      // yesterday's.
      if (roomId === quadRoomId && quadIsStale()) {
        roomId = rolloverQuad() ?? roomId;
      }
      // The WS is the human seat, same as chat.react below: never trust a
      // client-claimed senderId — a spoofed agent id would poison the verified-
      // identity record the whole product stands on. Attachments are resolved
      // by id from the server-side index; client-sent path/mimeType are
      // discarded (a crafted path would be handed to agents as a file to read).
      const resolvedAttachments = message.attachments
        ?.map((a) => getAttachment(a.id))
        .filter((a): a is NonNullable<typeof a> => a != null)
        .map(({ diskName: _diskName, ...ref }): AttachmentRef => ({
          ...ref,
          url: `/api/files/${ref.id}`,
        }));
      const msg: Message = {
        id: randomUUID(),
        roomId,
        senderId: 'human',
        content: message.content,
        attachments: resolvedAttachments,
        mentions: message.mentions,
        replyTo: message.replyTo,
        createdAt: Date.now(),
      };
      insertMessage(db, msg);
      persistDatabase(db, config.dataDir);
      const list = messages.get(roomId) ?? [];
      list.push(msg);
      messages.set(roomId, list);
      broadcast({ type: 'message.new', payload: msg });
      // ROUTER WIRING:
      // @router alias resolution happens BEFORE relay targeting, same spot
      // relay.ts's own mention-gating would otherwise be the only resolver.
      // routeAndRelay reads what the NORMAL fan-out would have delivered to
      // (resolveRelayTargets — exported, read-only, relay.ts untouched) to
      // decide whether @router or room-autoroute applies; when neither does,
      // it returns false and onRoomChatMessage runs exactly as before.
      {
        const room = rooms.get(roomId);
        const normalTargets = room ? resolveRelayTargets(relayDeps, room, msg) : [];
        const routed = room ? routeAndRelay(ws, room, msg, normalTargets) : false;
        if (!routed) {
          markBusy(normalTargets);
          onRoomChatMessage(relayDeps, msg);
        }
      }
      break;
    }
    case 'chat.edit': {
      const { messageId, content } = envelope.payload;
      for (const [roomId, list] of messages) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) continue;
        const existing = list[idx];
        // Edit is human-seat only, own-messages only — agent output is an
        // append-only record (the UI enforces this too; the gateway must not
        // rely on that).
        if (existing.senderId !== 'human') return;
        const updated: Message = {
          ...existing,
          content,
          updatedAt: Date.now(),
          editHistory: [
            ...(existing.editHistory ?? []),
            { previousContent: existing.content, editedAt: Date.now() },
          ],
        };
        list[idx] = updated;
        messages.set(roomId, [...list]);
        updateMessageContent(db, updated);
        persistDatabase(db, config.dataDir);
        broadcast({ type: 'message.updated', payload: updated });
        break;
      }
      break;
    }
    case 'chat.delete': {
      const { messageId } = envelope.payload;
      for (const [roomId, list] of messages) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) continue;
        if (list[idx].senderId !== 'human') return;
        const deletedAt = Date.now();
        softDeleteMessage(db, messageId, deletedAt);
        persistDatabase(db, config.dataDir);
        const updated = [...list];
        updated.splice(idx, 1);
        messages.set(roomId, updated);
        broadcast({ type: 'message.deleted', payload: { messageId, roomId } });
        break;
      }
      break;
    }
    case 'chat.react': {
      const { messageId, emoji } = envelope.payload;
      const reactorId = 'human'; // UI-originated reactions are always from the human seat
      for (const [roomId, list] of messages) {
        const idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) continue;
        const existing = list[idx];
        const reactions = (existing.reactions ?? []).map((r) => ({ ...r, userIds: [...r.userIds] }));
        const ri = reactions.findIndex((r) => r.emoji === emoji);
        if (ri >= 0) {
          const already = reactions[ri].userIds.includes(reactorId);
          reactions[ri].userIds = already
            ? reactions[ri].userIds.filter((u) => u !== reactorId)
            : [...reactions[ri].userIds, reactorId];
          if (reactions[ri].userIds.length === 0) reactions.splice(ri, 1);
        } else {
          reactions.push({ emoji, userIds: [reactorId] });
        }
        const updated: Message = { ...existing, reactions };
        list[idx] = updated;
        messages.set(roomId, [...list]);
        updateMessageReactions(db, messageId, reactions);
        persistDatabase(db, config.dataDir);
        broadcast({ type: 'message.updated', payload: updated });
        broadcast({ type: 'message.reaction', payload: { messageId, emoji, userId: reactorId } });
        break;
      }
      break;
    }
    case 'room.create': {
      const name = validRoomName(ws, 'room.create', envelope.payload.name);
      if (!name) break;
      // Milestone A creates group rooms only — the
      // client-declared type is not trusted.
      const room: Room = {
        id: randomUUID(),
        name,
        type: 'group',
        memberIds: sanitizeMemberIds(envelope.payload.memberIds),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turnCap: config.defaultRoomTurnCap,
      };
      persistRoomMutation(room);
      // persistRoomMutation already broadcasts a fresh state.sync (existing
      // convention for every room mutation); additionally emit the discrete
      // room.created event the shared ServerEvent union declares, same
      // broadcast-after-persist convention as room.set-budget's room.updated
      // below. Without this, any client/script waiting on room.created to
      // learn the new room's id hangs forever — exactly what caused a live
      // incident.
      broadcast(buildRoomCreatedEvent(room));
      break;
    }
    case 'room.rename': {
      const room = rooms.get(envelope.payload.roomId);
      if (!room || room.archivedAt != null) {
        roomError(ws, 'room.rename', 'Room not found.');
        break;
      }
      if (room.id === quadRoomId) {
        roomError(ws, 'room.rename', 'the Lobby is the default room and cannot be renamed.');
        break;
      }
      const name = validRoomName(ws, 'room.rename', envelope.payload.name);
      if (!name) break;
      persistRoomMutation({ ...room, name, updatedAt: Date.now() });
      break;
    }
    case 'room.archive': {
      const room = rooms.get(envelope.payload.roomId);
      if (!room || room.archivedAt != null) {
        roomError(ws, 'room.archive', 'Room not found.');
        break;
      }
      if (room.id === quadRoomId) {
        roomError(ws, 'room.archive', 'the Lobby is the default room and cannot be archived.');
        break;
      }
      // Soft archive: the row and its messages stay in the DB; the room just
      // stops appearing in state.sync. Un-archive is out of scope for
      // Milestone A — deliberately not built.
      if (defaultActiveRoomId === room.id && quadRoomId) {
        defaultActiveRoomId = quadRoomId;
      }
      persistRoomMutation({ ...room, archivedAt: Date.now(), updatedAt: Date.now() });
      // Per-agent attachment copies are only cleaned at archive time (never
      // earlier — re-reads must keep working for the room's lifetime).
      const roomMessages = messages.get(room.id) ?? [];
      const attachmentIds = roomMessages.flatMap((m) => m.attachments?.map((a) => a.id) ?? []);
      cleanupAgentAttachmentCopies(config.dataDir, attachmentIds);
      break;
    }
    case 'room.members': {
      const room = rooms.get(envelope.payload.roomId);
      if (!room || room.archivedAt != null) {
        roomError(ws, 'room.members', 'Room not found.');
        break;
      }
      // Full replacement per the contract. Sent by the sidebar room menu
      // ("Members…") and available for tooling-driven membership edits.
      persistRoomMutation({
        ...room,
        memberIds: sanitizeMemberIds(envelope.payload.memberIds),
        updatedAt: Date.now(),
      });
      break;
    }
    case 'room.join': {
      const room = rooms.get(envelope.payload.roomId);
      if (!room || room.archivedAt != null) break; // stale/forged id — keep current
      defaultActiveRoomId = room.id;
      broadcast(buildStateSync());
      break;
    }
    case 'room.set-budget': {
      const { roomId, tokens, costUsd } = envelope.payload;
      const room = rooms.get(roomId);
      if (!room || room.archivedAt != null) {
        roomError(ws, 'room.set-budget', 'Room not found.');
        break;
      }
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
        roomError(ws, 'room.set-budget', 'Budget tokens must be a non-negative number.');
        break;
      }
      const safeCostUsd = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 0;
      // If the new cap now exceeds current usage, clear the token-pause state
      // and reset the extension flag (docs spec) — a fresh budget is a fresh
      // start, not an implicit extension-consumption.
      applyNewRoomBudget(relayDeps, roomId, tokens);
      const updated: Room = { ...room, budgetCap: { tokens, costUsd: safeCostUsd }, updatedAt: Date.now() };
      persistRoomMutation(updated);
      // persistRoomMutation already broadcasts a fresh state.sync (existing
      // convention for every other room.* mutation above); room.set-budget's
      // spec additionally calls for the discrete room.updated event, which
      // some future single-room subscriber may prefer over a full resync.
      broadcast({ type: 'room.updated', payload: updated });
      break;
    }
    case 'room.autoroute': {
      //  — gateway-local toggle (Room has no field
      // for this; packages/shared is frozen). Persisted to data/autoroute.json
      // so the setting survives a restart, same as every other room setting.
      const { roomId, enabled } = envelope.payload;
      const room = rooms.get(roomId);
      if (!room || room.archivedAt != null) {
        roomError(ws, 'room.autoroute', 'Room not found.');
        break;
      }
      if (enabled) autorouteRooms.add(roomId);
      else autorouteRooms.delete(roomId);
      saveAutorouteRooms();
      // Server->client readback, typed at the two endpoints (identical
      // pattern to room.rollover above) since ServerEvent has no dedicated
      // type for this — Sidebar.tsx casts the same way back.
      broadcast({
        type: 'room.autoroute.status',
        payload: { roomId, enabled },
      } as unknown as ServerEvent);
      break;
    }
    case 'agent.connect': {
      try {
        // `remember` rides along as an additive field on the frozen payload
        // (same permissive-cast idiom as humanToken below): when set and the
        // seat verifies, it is saved and reconnected on every gateway start.
        const remember = (envelope as unknown as { payload?: { remember?: unknown } }).payload?.remember === true;
        const request = envelope.payload;
        const result = await connectSeat(request);
        if (remember && result.status === 'VERIFIED') {
          savedAgents = upsertSavedAgent(savedAgents, {
            seatId: result.agentId,
            manifestId: request.manifestId,
            instanceId: request.instanceId,
            instanceLabel: request.instanceLabel,
            config: request.config,
            savedAt: Date.now(),
          });
          saveSavedAgents(config.dataDir, savedAgents);
          broadcast(buildStateSync());
        }
      } catch (e) {
        // Per-request connect failure — only the offending client hears it.
        roomError(ws, 'agent.connect', e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'agent.disconnect': {
      // Graceful teardown of a live seat. This
      // is the ONLY clean, programmatic way to stop a one-off/throwaway seat:
      // nothing polls health to reap a seat whose adapter process merely died,
      // so an abandoned seat would otherwise stay VERIFIED forever. Unlike
      // room.rollover/loop.* above, agent.disconnect IS in the frozen shared
      // ClientEvent union, so envelope.payload is typed here with no cast.
      // disconnectAgent unregisters the relay worker, disposes the session, and
      // flips status to OFFLINE; broadcast the same agent.status + state.sync
      // pair every other lifecycle transition (agent.connect) already sends.
      const { agentId } = envelope.payload;
      // humanToken:
      // agent.disconnect's payload shape is frozen at `{ agentId: string }`
      // (packages/shared) — the token rides along as an ADDITIVE field on
      // the same wire object, read via a permissive cast at this one
      // endpoint (same "extra field on an existing frozen envelope shape"
      // idiom this file already uses for state.sync's additive keys), not a
      // ClientEvent union edit. Checked BEFORE disconnectAgent runs.
      const disconnectHumanToken = (envelope as unknown as { payload?: { humanToken?: unknown } }).payload?.humanToken;
      if (!isValidHumanToken(humanToken, disconnectHumanToken)) {
        roomError(ws, 'agent.disconnect', HUMAN_TOKEN_REQUIRED_ERROR);
        break;
      }
      const forget = (envelope as unknown as { payload?: { forget?: unknown } }).payload?.forget === true;
      if (forget) {
        // "Remove" in the Add agent panel: forget the saved entry, tear down a
        // live session if there is one, and drop the seat from the roster.
        savedAgents = removeSavedAgent(savedAgents, agentId);
        saveSavedAgents(config.dataDir, savedAgents);
        if (agents.get(agentId)?.session) await disconnectAgent(agentId, agents);
        agents.delete(agentId);
        liveConfigs.delete(agentId);
        for (const room of rooms.values()) {
          if (room.memberIds.includes(agentId)) {
            persistRoomMutation({ ...room, memberIds: room.memberIds.filter((m) => m !== agentId), updatedAt: Date.now() });
          }
        }
        onReviewSeatDisconnected(pollReviewsCtx, pollReviewTracker, agentId);
        broadcast({ type: 'agent.status', payload: { agentId, status: 'OFFLINE' } });
        broadcast(buildStateSync());
        break;
      }
      const result = await disconnectAgent(agentId, agents);
      if (!result.ok) {
        roomError(ws, 'agent.disconnect', result.error ?? `Cannot disconnect agent: ${agentId}`);
        break;
      }
      liveConfigs.delete(agentId);
      // Two-Reviewer Policy: a reviewer seat
      // disconnecting mid-review times its pending review(s) out immediately
      // and logs it — never re-selects (see pollReviews.ts's
      // onSeatDisconnected doc comment for why this is deliberately NOT the
      // same path as the T+4 wake-timeout substitute).
      onReviewSeatDisconnected(pollReviewsCtx, pollReviewTracker, agentId);
      broadcast({
        type: 'agent.status',
        payload: { agentId: result.agentId, status: result.status! },
      });
      broadcast(buildStateSync());
      break;
    }
    case 'agent.set-model': {
      //  Only seats whose adapter reads
      // transport.model support this (claude-code, grok-build — manifest
      // cliCommand is the same signal the UI's model picker gates on).
      // hermes/openclaw have no writable model field: rather than silently
      // accepting a no-op mutation (a painted-status hole), reject loud.
      const { agentId, model } = envelope.payload;
      const state = agents.get(agentId);
      const liveConfig = liveConfigs.get(agentId);
      if (!state || !liveConfig) {
        roomError(ws, 'agent.set-model', `Unknown or disconnected agent: ${agentId}`);
        break;
      }
      if (!state.manifest.cliCommand) {
        roomError(
          ws,
          'agent.set-model',
          `${state.manifest.displayName} has no configurable model (fixed-model harness).`
        );
        break;
      }
      if (typeof model !== 'string' || model.trim().length === 0) {
        roomError(ws, 'agent.set-model', 'Model must be a non-empty string.');
        break;
      }
      // Server-side vocabulary allowlist (./modelVocab.ts) — the UI dropdown
      // is NOT a security boundary (adversarial-review finding, 7/7: a raw WS
      // frame could otherwise inject arbitrary CLI args via the model
      // string, e.g. '--dangerous-flag' becoming a literal child-process
      // flag). Checked by MANIFEST id, not seat id — every seat of a harness
      // (main or #instance, e.g. grok-build#fast) shares its manifest's model
      // list.
      const requested = model.trim();
      if (!isAllowedModel(state.manifest.id, requested)) {
        roomError(
          ws,
          'agent.set-model',
          `Model '${requested}' is not in ${state.manifest.displayName}'s allowed vocabulary.`
        );
        break;
      }
      // Mutate the LIVE config's transport in place — spawnClaudeTurn /
      // spawnGrokTurn both call transportOf(config) fresh on every turn, so
      // this takes effect on the agent's NEXT send() with no reconnect.
      liveConfig.transport = { ...liveConfig.transport, model: requested };
      broadcast({
        type: 'agent.status',
        payload: { agentId, status: state.status, health: state.health },
      });
      break;
    }
    case 'memory.search': {
      // Payload is off the wire — never trust its shape.
      const query = typeof envelope.payload?.query === 'string' ? envelope.payload.query : '';
      const items = memoryIndex.search(query).map((n) => ({
        path: n.path,
        title: n.title,
        summary: n.summary,
        mtime: n.mtime,
      }));
      broadcast({ type: 'memory.results', payload: { query, items } });
      break;
    }
    case 'memory.get': {
      const rawPath = envelope.payload?.path;
      // SECURITY: path traversal guard. resolveVaultPath
      // is the ONLY thing standing between a client-supplied string and an
      // arbitrary filesystem read — reject anything it can't prove stays inside
      // the vault root, and reject BEFORE ever asking the index for the note
      // (the index itself only ever serves already-indexed, already-allowlisted
      // paths, but this check fails closed even if that ever changes).
      if (typeof rawPath !== 'string' || resolveVaultPath(memoryIndex.getVaultRoot(), rawPath) == null) {
        roomError(ws, 'memory.get', 'Invalid or out-of-vault path.');
        break;
      }
      const note = memoryIndex.get(rawPath);
      if (!note) {
        roomError(ws, 'memory.get', 'Note not found.');
        break;
      }
      broadcast({
        type: 'memory.note',
        payload: {
          path: note.path,
          title: note.title,
          markdown: note.markdown,
          pinnedInRooms: roomsPinning(memoryPins, note.path),
        },
      });
      break;
    }
    case 'memory.pin-note': {
      const { roomId, path } = envelope.payload ?? {};
      if (typeof roomId !== 'string' || typeof path !== 'string' || !rooms.has(roomId)) {
        roomError(ws, 'memory.pin-note', 'Unknown room or invalid note path.');
        break;
      }
      // A path must resolve to a real, currently-indexed (i.e. governance-
      // allowed, non-PII) note before it can be pinned — otherwise a client
      // could pin an out-of-vault or excluded path that later gets prepended
      // verbatim into an agent's outbound context. One lookup, reused for the
      // validity check and the post-pin broadcast below.
      const note = memoryIndex.get(path);
      if (!note) {
        roomError(ws, 'memory.pin-note', 'Note not found or not pinnable.');
        break;
      }
      memoryPins = pinNote(memoryPins, roomId, path);
      savePins(config.dataDir, memoryPins);
      broadcast({
        type: 'memory.note',
        payload: {
          path: note.path,
          title: note.title,
          markdown: note.markdown,
          pinnedInRooms: roomsPinning(memoryPins, note.path),
        },
      });
      break;
    }
    case 'memory.unpin-note': {
      const { roomId, path } = envelope.payload ?? {};
      if (typeof roomId !== 'string' || typeof path !== 'string') {
        roomError(ws, 'memory.unpin-note', 'Invalid room or note path.');
        break;
      }
      memoryPins = unpinNote(memoryPins, roomId, path);
      savePins(config.dataDir, memoryPins);
      const note = memoryIndex.get(path);
      if (note) {
        broadcast({
          type: 'memory.note',
          payload: {
            path: note.path,
            title: note.title,
            markdown: note.markdown,
            pinnedInRooms: roomsPinning(memoryPins, note.path),
          },
        });
      }
      break;
    }
    default:
      break;
  }
}

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: (origin, cb) => cb(null, isAllowedBrowserOrigin(origin)),
  credentials: true,
});
await fastify.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

const uiDist = join(projectRoot, 'packages', 'ui', 'dist');
await fastify.register(fastifyStatic, {
  root: uiDist,
  prefix: '/',
});

/**
 * humanToken delivery:
 * "injects it into the served index.html only". An explicit `GET /` handler
 * registered on the SAME Fastify instance takes precedence over
 * @fastify/static's wildcard file-serving for an EXACT `/` request
 * (find-my-way, Fastify's router, prioritizes a static/exact path segment
 * over a parametric/wildcard one regardless of registration order) — so
 * every other asset (JS/CSS/images) still serves untouched via the plugin
 * above; only the top-level page gets the injected `<script>`. Cached after
 * the first read (index.html is a boot-time build artifact, never rewritten
 * while the gateway runs). Honest limit stated in the original design: this is
 * NOT a route that hides the token from a determined local script — a
 * `curl http://127.0.0.1:4110/` reads it right out of the HTML just like a
 * browser would. It only means a caller has to know to look here, rather
 * than the token being handed to literally anyone who opens a WebSocket.
 */
let cachedIndexHtml: string | undefined;
function servedIndexHtml(): string | undefined {
  const indexPath = join(uiDist, 'index.html');
  if (!existsSync(indexPath)) return undefined;
  if (cachedIndexHtml == null) {
    const raw = readFileSync(indexPath, 'utf8');
    const inject = `<script>window.__AGENT_OS_HUMAN_TOKEN__=${JSON.stringify(humanToken)};</script>`;
    cachedIndexHtml = raw.includes('</head>') ? raw.replace('</head>', `${inject}</head>`) : `${inject}${raw}`;
  }
  return cachedIndexHtml;
}
fastify.get('/', async (_req, reply) => {
  const html = servedIndexHtml();
  if (html == null) {
    reply.code(404);
    return { error: 'UI not built (packages/ui/dist/index.html missing) — run `npm run build:ui`.' };
  }
  reply.type('text/html').send(html);
});

fastify.get('/health', async () => ({
  status: 'ok',
  agents: agents.size,
  rooms: rooms.size,
}));

fastify.get('/api/state', async () => {
  const sync = buildStateSync();
  return {
    ...sync.payload,
    globalCost,
  };
});

/**
 * Memory Galaxy: the Wave-1 vault index
 * (memory.ts) already applies every governance exclusion at index time — an
 * excluded/PII note is never in `this.notes`, so it can never be a node OR a
 * resolved link target here. REST, loopback trust model — same convention as
 * every other /api/* route in this file (no new auth system).
 */
fastify.get('/api/memory/graph', async () => memoryIndex.getGraph());

/**
 * Archived-room paging (review 2026-08-04 §4.2) — the other half of windowing
 * `archivedRooms` out of state.sync. state.sync carries the newest 50; this
 * serves everything older, so nothing became unreachable when the broadcast
 * stopped shipping all 886 of them.
 *
 * `before` is an exclusive updatedAt cursor and `limit` defaults to the same
 * window size, matching the /api/rooms/:roomId/messages?before= route
 * directly below. REST, loopback trust model, same convention as every other
 * /api/* route in this file.
 *
 * Registered BEFORE the parameterised room routes for readability only —
 * '/api/rooms/archived' and '/api/rooms/:roomId/messages' are distinct paths
 * (the latter has a /messages suffix), so there is no shadowing either way.
 */
fastify.get<{ Querystring: { before?: string; limit?: string } }>(
  '/api/rooms/archived',
  async (req) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : ARCHIVED_ROOMS_WINDOW;
    return archivedRoomsPage(
      rooms.values(),
      Number.isFinite(before) ? before : undefined,
      Number.isFinite(limit) ? limit : ARCHIVED_ROOMS_WINDOW
    );
  }
);

fastify.get<{ Params: { roomId: string }; Querystring: { before?: string; limit?: string } }>(
  '/api/rooms/:roomId/messages',
  async (req) => {
    const roomId = req.params.roomId;
    if (!messages.has(roomId)) {
      messages.set(roomId, loadMessagesForRoom(db, roomId));
    }
    const all = messages.get(roomId) ?? [];
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    if (before == null) {
      // Most recent page (or everything, if the room is small) — same behavior as before
      // pagination existed, so the default (no query params) call stays backward compatible.
      return all.slice(-limit);
    }

    const older = all.filter((m) => m.createdAt < before);
    return older.slice(-limit);
  }
);

// Rehydrate the attachment index from persisted messages so /api/files/:id works
// for files uploaded before this boot.
for (const list of messages.values()) {
  for (const m of list) {
    if (m.attachments?.length) reindexAttachmentsFromMessages(m.attachments);
  }
}
// Then sweep <dataDir>/files for uploads that were never sent in a message
// (upload-then-cancel) — the message-based pass above can't see those, so
// they'd otherwise stay unreachable via GET /api/files/:id for this boot's
// entire life even though the bytes are still on disk.
const orphanedAttachmentsReindexed = reindexAttachmentsFromDisk(config.dataDir);
if (orphanedAttachmentsReindexed > 0) {
  console.log(
    `[files] reindexed ${orphanedAttachmentsReindexed} orphaned attachment(s) from disk on boot`
  );
}

fastify.post('/api/files', async (req, reply) => {
  const data = await req.file();
  if (!data) {
    reply.code(400);
    return { error: 'No file in request' };
  }
  const buffer = await data.toBuffer();
  const stored = storeAttachment(config.dataDir, data.filename, data.mimetype, buffer);
  const attachment: AttachmentRef = {
    id: stored.id,
    filename: stored.filename,
    mimeType: stored.mimeType,
    size: stored.size,
    path: stored.path,
    url: `/api/files/${stored.id}`,
  };
  return attachment;
});

fastify.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
  const attachment = getAttachment(req.params.id);
  if (!attachment) {
    reply.code(404);
    return { error: 'Attachment not found' };
  }
  const buffer = readAttachmentBuffer(config.dataDir, attachment);
  const safeFilename = sanitizeHeaderFilename(attachment.filename);

  // SECURITY: the upload mimetype is client-supplied and never trusted beyond an
  // exact allowlist match. Anything not on the allowlist (including image/svg+xml
  // and text/html, which browsers will parse/execute) is forced to download as an
  // opaque octet-stream rather than rendered inline from the gateway origin.
  reply.header('X-Content-Type-Options', 'nosniff');
  if (isInlineSafeContentType(attachment.mimeType)) {
    const contentType =
      attachment.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : attachment.mimeType;
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="${safeFilename}"`);
  } else {
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeFilename}"`);
    reply.header('Content-Security-Policy', 'sandbox');
  }
  return reply.send(buffer);
});

/**
 * Paperclip bridge wake:
 * "post as seat + await that seat's next turn" gateway seam. REST, not WS —
 * loopback-only per the existing convention (the gateway binds 127.0.0.1 and
 * trusts local callers; this endpoint invents no new auth system, matching
 * every other /api/* route here). Route + decision logic live in bridge.ts
 * (pure/testable, same split as loop.ts) — see registerBridgeRoute's and the
 * module's doc comments for why delivery uses relayMessageToAgents (not
 * onRoomChatMessage) and why the delivery-only clone uses senderId: 'human'.
 */
registerBridgeRoute(fastify, {
  relayDeps,
  agents,
  rooms,
  messages,
  db,
  dataDir: config.dataDir,
  defaultRoomTurnCap: config.defaultRoomTurnCap,
  loopsConfig,
  idempotency: bridgeIdempotency,
  waits: bridgeWaits,
  broadcast,
  markBusy,
  persistRoomMutation,
});

/**
 * POST /api/polls. REST,
 * loopback trust model — same convention as POST /api/bridge/wake. Route +
 * validation logic live in pollsRoutes.ts (pure/testable, same split as
 * bridge.ts). Agents, scripts, and — indirectly, via polls.ts's createPoll
 * called in-process — the Paperclip poller all use this one shape.
 */
registerPollsRoute(fastify, pollsRouteCtx);

/**
 * POST /api/escalate. REST,
 * loopback trust model — same convention as POST /api/bridge/wake and POST
 * /api/polls above. Route + guard/decision logic live in escalateRoutes.ts
 * (pure/testable, same split as bridge.ts/pollsRoutes.ts) — reuses the SAME
 * bridgeWaits registry bridge.ts's own route observes via the message.new
 * broadcast hook above (BridgeWaitRegistry.observe is generic over any
 * (roomId, seatId) pair, so no second observer needed here).
 */
registerEscalateRoute(fastify, {
  relayDeps,
  agents,
  rooms,
  messages,
  db,
  dataDir: config.dataDir,
  defaultRoomTurnCap: config.defaultRoomTurnCap,
  broadcast,
  markBusy,
  postSystemLine,
  persistRoomMutation,
  waits: bridgeWaits,
});

/**
 * POST /api/fleet/wake — TopBar "Wake fleet" button: reconnects every saved
 * agent that is not VERIFIED (see fleetWakeRoutes.ts). Loopback trust.
 */
registerFleetWakeRoute(fastify, {
  agents,
  defaultRoomId: () => defaultActiveRoomId,
  postSystemLine,
  reconnectSaved: reconnectSavedAgents,
});

/**
 * POST /api/workshop/propose. REST, loopback trust model — same convention as POST
 * /api/polls above. Route + validation logic live in workshopRoutes.ts
 * (pure/testable, same split as pollsRoutes.ts); the git-apply half runs
 * from pollsRoutes.ts's notifyPollSettled on a decided, approved,
 * source==='workshop' poll (shares getPollsState/setPollsState with
 * pollsRouteCtx above — both contexts read/write the SAME pollsState
 * closure, so a poll created here is immediately visible to poll.decide).
 */
const workshopRouteCtx: WorkshopRouteContext = {
  rooms,
  dataDir: config.dataDir,
  projectRoot,
  defaultRoomTurnCap: config.defaultRoomTurnCap,
  getPollsState: () => pollsState,
  setPollsState: (state) => {
    pollsState = state;
  },
  broadcast,
  broadcastStateSync: () => broadcast(buildStateSync()),
  postSystemLine,
  persistRoomMutation,
  // Two-Reviewer Policy (Wave 7 M3): workshop propose is today's ONLY
  // 'workshop-propose'-covered action. Fire-and-
  // forget — see startPollReview's own doc comment for the fail-open
  // contract this must never violate.
  onPollProposed: (poll) => startPollReview(pollReviewsCtx, pollReviewTracker, poll, 'workshop-propose'),
};
registerWorkshopRoute(fastify, workshopRouteCtx);

/**
 * Two-Reviewer Policy routes:
 * GET/POST /api/review-policy (the POST is humanToken-gated — see
 * pollReviews.ts's registerPollReviewRoutes), the per-finding valid/invalid
 * toggle, the digest, and a reviews-by-poll read. Route + decision logic
 * live in pollReviews.ts (pure/testable, same split as every other *Routes.ts
 * module in this file).
 */
registerPollReviewRoutes(fastify, pollReviewsCtx);

/**
 * GET /api/dossiers/:seatId. REST, loopback trust model, same convention as every other
 * /api/* route — registered unconditionally; the route itself 404s on every
 * request when dossiersDir is unset (see dossiersRoutes.ts's doc comment for
 * why that is indistinguishable from "no such route" to a caller). Roster
 * validation reads agents.ts's STATIC knownManifestIds() — deliberately NOT
 * the live `agents` map (see dossiers.ts's isKnownSeatId doc comment).
 */
registerDossiersRoute(fastify, {
  dossiersDir,
  knownManifestIds,
});

/**
 * POST /presence/temp/start and /presence/temp/end (2026-08-02, TEMP-agent
 * "on duty" surface) — see ephemeralRoutes.ts's module doc comment. Loopback
 * trust model, same as every other route registered in this file.
 * onChange broadcasts a fresh state.sync immediately so an announce/clear
 * shows up on every open tab right away, without waiting for the sweep timer
 * below.
 */
registerEphemeralRoutes(fastify, {
  registry: ephemeralPresence,
  onChange: () => broadcast(buildStateSync()),
});

const wss = new WebSocketServer({ noServer: true });

fastify.server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin && !isAllowedBrowserOrigin(origin)) {
    socket.destroy();
    return;
  }
  if (request.url?.startsWith('/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);
  sendEnvelope(ws, buildStateSync());
  // Room autoroute hydration: state.sync's Room
  // shape has no field for this (packages/shared is frozen), so a fresh
  // connect/reconnect self-heals via one room.autoroute.status per
  // currently-autorouted room — same self-healing spirit as state.sync
  // itself, just on the gateway-local extension channel.
  for (const roomId of autorouteRooms) {
    sendEnvelope(ws, { type: 'room.autoroute.status', payload: { roomId, enabled: true } } as unknown as ServerEvent);
  }
  // Loop-lite hydration (Wave 2): same self-healing pattern as autoroute
  // above — one loop.status per room with a currently-ACTIVE loop, sent
  // right after the initial state.sync.
  for (const [roomId, loop] of Object.entries(loopsConfig)) {
    if (!loop.active) continue;
    sendEnvelope(ws, {
      type: 'loop.status',
      payload: {
        roomId,
        active: loop.active,
        round: loop.round,
        maxRounds: loop.maxRounds,
        phase: loop.phase,
        builderSeat: loop.builderSeat,
        judgeSeat: loop.judgeSeat,
      },
    } as unknown as ServerEvent);
  }
  // Per-agent telemetry hydration: AgentSummary has no per-agent cost field (packages/shared
  // is frozen), so the UI's agentTokenTotals only ever grew from live
  // cost.event frames — empty until new traffic arrives after a restart, even
  // though globalCost.byAgent was already rehydrated from cost_events at boot
  // (see the recomputeCostTotals call above). One snapshot per connect, same
  // gateway-local-extension pattern as room.autoroute.status above: the UI
  // seeds agentTokenTotals from this once, then keeps accumulating from
  // cost.event exactly as before.
  if (Object.keys(globalCost.byAgent).length > 0) {
    sendEnvelope(ws, {
      type: 'agent.cost.snapshot',
      payload: { byAgent: globalCost.byAgent },
    } as unknown as ServerEvent);
  }

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as ClientEnvelope;
      // A malformed payload must not become an unhandled rejection — that
      // takes the whole gateway (and every agent session) down with it.
      handleClientEvent(ws, parsed).catch((e) =>
        console.error('Client event failed', parsed?.type, e)
      );
    } catch (e) {
      console.error('Invalid WS message', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// The batched DB writer (review 2026-08-04 §4.1 / RISK 1). This tick is now
// the ONLY unconditional writer of gateway.db: mutating helpers in db.ts mark
// the database dirty and this flushes at most once per 5 s, instead of the
// old behavior where this interval rewrote the whole file every 5 s whether
// or not anything had changed AND each agent turn rewrote it three more times.
// Durability-critical paths (the human's own chat.send, poll decisions,
// bridge/escalate commits) still call persistDatabase directly for an
// immediate synchronous write — see db.ts's dirty-flag header comment.
setInterval(() => flushDatabaseIfDirty(db, config.dataDir), 5000);

// Proof-of-life sweep (2026-07-27): refreshes lastHeartbeat via each live
// session's own health() probe so seats stop going falsely stale between
// gateway restarts — see proofOfLife.ts header for the full rationale.
startProofOfLifeSweep(agents);
// G2b activity sweep (2026-08-01, R4): separate ~30s tick for AgentSession.activity() —
// see proofOfLife.ts header for why this isn't folded into the 10-minute health sweep above.
startActivitySweep(agents);

// Ephemeral presence sweep (2026-08-02): drops expired TEMP entries every 5s.
// CRITICAL: only broadcasts when sweep() actually removed something —
// ephemeral.ts's sweep() returns false on a no-op pass specifically so this
// never fires a state.sync into 790 rooms / 8 seats' worth of open tabs every
// 5 seconds forever (that would be a standing performance regression, not a
// one-time cost). Announce/clear already broadcast immediately via onChange
// above; this timer only ever catches a temp that crashed/never called
// /presence/temp/end before its TTL ran out.
const ephemeralSweepTimer = setInterval(() => {
  if (ephemeralPresence.sweep()) broadcast(buildStateSync());
}, 5_000);
if (typeof ephemeralSweepTimer.unref === 'function') ephemeralSweepTimer.unref();

try {
  await fastify.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`Gateway http://127.0.0.1:${config.port}  ws://127.0.0.1:${config.port}/ws`);
  if (savedAgents.length > 0) {
    console.log(`[saved-agents] reconnecting ${savedAgents.length} saved agent(s)…`);
    void reconnectSavedAgents().then((outcomes) => {
      for (const o of outcomes) console.log(`[saved-agents] ${o.id}: ${o.status}${o.reason ? ` — ${o.reason}` : ''}`);
    });
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
