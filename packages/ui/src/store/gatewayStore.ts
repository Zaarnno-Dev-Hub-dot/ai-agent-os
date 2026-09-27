import { create } from 'zustand';
import {
  AgentSummary,
  Room,
  Message,
  ServerEvent,
  ClientEvent,
  ClientEnvelope,
  PollReview,
} from '@agent-os/shared';
import { useVoiceStore } from './voiceStore';
import { getHumanToken } from '../lib/reviewPolicy';

/** Two-Reviewer Policy mode (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md) — re-exported for component convenience so callers don't need a second import from '@agent-os/shared' just for this string union. */
export type ReviewPolicyMode = 'off' | 'mutations' | 'all';

/** One raw frame kept for the inspect panel's "raw frames" debug tab. */
export interface InspectFrame {
  id: string;
  direction: 'in' | 'out';
  at: number;
  event: ServerEvent | ClientEvent;
}

/** Live typing/tool-activity indicator, per room+agent. Cleared on message-complete or timeout. */
export interface TypingState {
  agentId: string;
  roomId: string;
  tool?: string;
  updatedAt: number;
}

/** One recorded turn's usage, kept per-agent for the InspectPanel Telemetry tab. */
export interface RecentTurn {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  at: number;
}

/** Running token/cost tally — shape shared by per-room and per-agent totals. */
export interface TokenTotals {
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
}

const MAX_RECENT_TURNS_PER_AGENT = 20;

/** One vault note as shown in Memory panel search results (docs/DESIGN-memory-read.md). */
export interface MemorySearchResult {
  path: string;
  title: string;
  summary?: string;
  mtime: number;
}

/** A fully-loaded note (memory.note payload) — set as the panel's open note view. */
export interface MemoryActiveNote {
  path: string;
  title: string;
  markdown: string;
  pinnedInRooms: string[];
}

/**
 * Approvals/Polls rail (docs/DESIGN-approvals-rail.md #2): decision cards
 * agents or bridged systems (Paperclip) put in front of the operator. Gateway-local
 * — Room/ServerEvent have no field for this (packages/shared is frozen) —
 * hydrated from state.sync's additive `polls` field and kept live via
 * `poll.updated`, both cast at the endpoint per the room.autoroute.status
 * precedent (see applyServerEvent below).
 */
export interface PollOption {
  id: string;
  label: string;
}

export interface PollDecision {
  optionId: string;
  decidedBy: string;
  decidedAt: number;
  note?: string;
}

/** One deferral event (Wave 6, docs/DESIGN-approvals-app-v2.md correction #2) — logged, never overwritten. */
export interface PollDeferral {
  at: number;
  note?: string;
}

export type PollMessageSeverity = 'info' | 'note' | 'needs-info';

/** A note posted on an open poll without deciding it (deferral notes, more-info asks). */
export interface PollMessage {
  at: number;
  sender?: string;
  severity: PollMessageSeverity;
  content: string;
}

/** Rich-card evidence (Wave 6): a screenshot/graph/table/text blob. `attachmentSrc()` in lib/pollPresent.ts is the ONLY place `url`/`data` may become a DOM sink (an `<img src>`; there is no `<a href>`/`<iframe>`/`<object>` sink for these fields anywhere) — never read these fields directly into src/href elsewhere. Components should call `resolveAttachmentView()` (also lib/pollPresent.ts), not `attachmentSrc()` directly — it wraps attachmentSrc with the `kind` gate (design doc correction #1, reopened) that decides whether a value is even eligible to reach that sink. */
export interface PollAttachment {
  kind: 'image' | 'graph' | 'table' | 'text';
  url?: string;
  data?: string;
  caption?: string;
  source?: string;
}

/** One agent's stated position in a dispute — rendered unedited, side by side with the other side(s). */
export interface PollDisputeSide {
  agent: string;
  statement?: string;
  summary?: string;
  evidence?: PollAttachment[];
}

export interface Poll {
  id: string;
  roomId: string;
  question: string;
  detail?: string;
  /** Plain-language WHY (Wave 6) — the inbox card's "Why" block prefers this over `detail` when present. Absent on v1 (pre-Wave-6) polls, which render exactly as before (design doc correction #4). */
  detailSummary?: string;
  /** Plain-language recommendation text (Wave 6), shown alongside/instead of the recommended option's label. */
  recommendation?: string;
  options: PollOption[];
  recommendationId?: string;
  requestedBy: string;
  createdAt: number;
  expiresAt?: number;
  defaultOptionId?: string;
  // 'withdrawn' added 2026-07-18 (owner-directed "remove decision" button,
  // polls.ts's PollStatus) — a poll a human retired on purpose, never voted
  // on (decision stays undefined, distinct from 'decided'/'expired').
  status: 'open' | 'decided' | 'expired' | 'withdrawn';
  decision?: PollDecision;
  /** Deferral log (Wave 6) — capped server-side at 3 (polls.ts's MAX_POLL_DEFERRALS). */
  deferrals?: PollDeferral[];
  /** Non-deciding notes (Wave 6): deferral notes + more-info asks, newest last. */
  messages?: PollMessage[];
  // 'workshop' added Wave 7 M3 — was missing here even though gateway-side
  // polls.ts's Poll type has carried it since Wave 6 (docs/DESIGN-workshop-
  // flow.md); a workshop poll's `source` was reaching this store as a
  // string TS didn't know about (harmless at runtime — this is a plain
  // data field, not a discriminant anything switched on — but it silently
  // widened this type's real-world truth). Two-Reviewer Policy's
  // `needsZeroVerdictConfirm` (lib/pollPresent.ts) is the first thing that
  // actually needs to compare against it.
  source: 'local' | 'paperclip' | 'workshop';
  externalRef?: { approvalId: string; companyId: string };
  /** Rich-card evidence (Wave 6, design doc: "images, graphs, descriptions"). */
  attachments?: PollAttachment[];
  /** Both sides of an agent disagreement, unedited (Wave 6, design doc: "2 sides of the argument if agents disagree"). */
  disputeSides?: PollDisputeSide[];
}

/**
 * A room's loop-lite state (Wave 2), hydrated entirely from the gateway's
 * `loop.status` broadcasts — Room itself has no field for this
 * (packages/shared is frozen), same gateway-local-extension shape as
 * autorouteRooms below. Absence from the map means "no loop has ever run in
 * this room" (distinct from an explicit `active: false` after a stop, which
 * still carries the final round/phase for display).
 */
export interface LoopStatus {
  active: boolean;
  round?: number;
  maxRounds?: number;
  phase?: 'awaiting-builder' | 'awaiting-judge';
  builderSeat?: string;
  judgeSeat?: string;
}

/**
 * Studio Dock registry entry (docs/DESIGN-studio-dock.md §2), hydrated from
 * state.sync's additive `dockApps` field (gateway-local — packages/shared is
 * frozen — same cast-at-the-endpoint pattern as polls/projects above).
 */
export interface DockAppEntry {
  id: string;
  label: string;
  icon: string;
  kind: 'route' | 'iframe';
  url?: string;
  enabled?: boolean;
}

/**
 * A live TEMP worker's "on duty" row (2026-08-02, Agents\temp\ presence
 * surface). Hydrated from state.sync's additive `ephemeral` field — same
 * cast-at-the-endpoint pattern as dockApps/polls above — and kept live via
 * the same broadcast (the gateway resends state.sync on every announce/
 * clear and on any sweep that actually removed something; see gateway's
 * ephemeral.ts). Deliberately NOT part of AgentSummary/the `agents` array:
 * this is a separate, self-expiring presence lane, not a seat.
 */
export interface EphemeralPresence {
  id: string;
  label: string;
  kind: 'temp';
  startedAt: number;
  expiresAt: number;
  meta?: { role?: string; jobSlug?: string; tempId?: string; [key: string]: string | undefined };
}

export interface UIState {
  ws: WebSocket | null;
  connected: boolean;
  connecting: boolean;
  agents: AgentSummary[];
  rooms: Room[];
  activeRoomId: string | null;
  messages: Map<string, Message[]>;
  turnCapBannerRoomId: string | null;
  /** budget.exceeded (TOKEN budget pause) — kept separate from turnCapBannerRoomId so the UI can show the right notice for each. */
  tokenPauseBannerRoomId: string | null;
  sidebarCollapsed: boolean;
  inspectPanelOpen: boolean;
  inspectAgentId: string | null;
  filesRailOpen: boolean;
  inspectFrames: InspectFrame[];
  typing: Map<string, TypingState>; // key: `${roomId}:${agentId}`
  unreadByRoom: Map<string, number>;
  globalCost: { tokensIn: number; tokensOut: number; estimatedCostUsd: number };
  budgetWarningByRoom: Map<string, number>; // roomId -> percent (80 = token warning; 100 is the turn-cap pause notice, see budget.warning handling below)
  /** Per-room token/cost tally, hydrated from state.sync rooms' costTracker and accumulated from cost.event. */
  roomTokenTotals: Map<string, TokenTotals>;
  /** Per-agent token/cost tally + recent-turns list, for the InspectPanel Telemetry tab. */
  agentTokenTotals: Map<string, TokenTotals & { recentTurns: RecentTurn[] }>;
  /** Last server `error` event, surfaced as a toast (gateway rejections must be visible). */
  errorToast: { code: string; message: string; at: number } | null;
  /**
   * Room ids with autoroute ON (docs/DESIGN-router.md #2). Room itself has no
   * field for this (packages/shared is frozen) — hydrated on every connect
   * (the gateway sends one `room.autoroute.status` per currently-autorouted
   * room right after its initial state.sync, mirroring how state.sync itself
   * self-heals on reconnect) and kept live via the same broadcast type, typed
   * at the two endpoints — same pattern as room.rollover, see Sidebar.tsx.
   */
  autorouteRooms: Set<string>;

  /**
   * Projects layer (Phase 3 Milestone E, slimmed): Room has no projectId
   * field (packages/shared is frozen) — hydrated from state.sync's
   * gateway-local extension fields (archivedRooms/projects/projectAssignments),
   * same cast-at-the-endpoint pattern as autorouteRooms/room.autoroute.status
   * above, just riding the state.sync broadcast instead of a discrete event.
   */
  projects: Array<{ id: string; name: string }>;
  /** roomId -> projectId. Absent key = Unsorted (a UI label, never a stored project). */
  projectAssignments: Map<string, string>;
  /** Archived rooms are excluded from `rooms` server-side; this is the ONLY client-side visibility into them. */
  archivedRooms: Room[];
  /** Loop-lite state per room (Wave 2), keyed by roomId — see LoopStatus doc comment. */
  loopByRoom: Map<string, LoopStatus>;

  /** Vault memory layer v1 (docs/DESIGN-memory-read.md) UI state. */
  memoryRailOpen: boolean;
  memorySearchQuery: string;
  memorySearchResults: MemorySearchResult[];
  memoryActiveNote: MemoryActiveNote | null;
  /** roomId -> (path -> title), for the room header's pinned chips + the panel's "pinned in this room" list. Derived entirely from memory.note's pinnedInRooms field (see applyServerEvent). */
  memoryPinnedByRoom: Map<string, Map<string, string>>;

  /** Approvals/Polls rail (docs/DESIGN-approvals-rail.md). Full set of polls this client knows about, across all rooms — hydrated from state.sync + poll.updated. */
  polls: Poll[];
  pollsRailOpen: boolean;
  /** Poll ids dismissed from the in-room inline card (non-blocking — the poll still lives in the rail and history). Cleared automatically once a poll leaves 'open' status. */
  dismissedPollIds: Set<string>;

  /**
   * Two-Reviewer Policy (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md).
   * Keyed by pollId — hydrated from state.sync's additive `pollReviews`
   * field (same windowing as `polls`: open + last 20 settled) and kept live
   * via `poll.review.updated` (upsert-by-id within the poll's array), both
   * cast at the endpoint since ServerEvent has no dedicated field for this
   * (packages/shared frozen except the PollReview/ReviewVerdict TYPES
   * themselves — the event shape is a gateway-local extension, same pattern
   * as `poll.updated`).
   */
  pollReviews: Map<string, PollReview[]>;
  /** Current review_policy mode — hydrated from state.sync's additive `reviewPolicy` field, kept live via `review.policy.status`. */
  reviewPolicyMode: ReviewPolicyMode;

  /** Studio Dock (docs/DESIGN-studio-dock.md). Registry hydrated from state.sync; active app id null = room chat view, set = DockView mounted in the main pane in its place. */
  dockApps: DockAppEntry[];
  activeDockAppId: string | null;

  /**
   * Agent Dossiers (Wave 7 stretch, M4, docs/DESIGN-agent-dossiers-surface.md).
   * Hydrated from state.sync's additive `dossiersEnabled` boolean (gateway-
   * local — packages/shared is frozen, same cast-at-the-endpoint pattern as
   * dockApps/polls above). "dossiersDir config unset (default) = feature
   * hidden entirely" — InspectPanel reads this to skip the Dossier tab
   * outright rather than rendering a tab that always 404s.
   */
  dossiersEnabled: boolean;

  /**
   * TEMP-agent "on duty" presence (2026-08-02). Hydrated from state.sync's
   * additive `ephemeral` field, same full-replace-on-hydrate pattern as
   * `polls` above — the gateway is authoritative and resends state.sync on
   * every change, so there is no live-accumulation to preserve here.
   */
  ephemeral: EphemeralPresence[];
  /** Seat ids the gateway will reconnect on start (saved from the Add agent panel). */
  savedAgentIds: string[];

  setWs: (ws: WebSocket | null) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  applyServerEvent: (event: ServerEvent) => void;
  /** Returns false when the socket is down — callers must not treat the send as delivered. */
  sendClientEvent: (event: ClientEvent) => boolean;
  setActiveRoom: (roomId: string) => void;
  dismissErrorToast: () => void;
  toggleSidebar: () => void;
  toggleInspectPanel: () => void;
  setInspectAgent: (agentId: string | null) => void;
  toggleFilesRail: () => void;
  roomsWithHistoryLoaded: Set<string>;
  markHistoryLoaded: (roomId: string) => void;
  prependMessages: (roomId: string, older: Message[]) => void;
  hasMoreHistory: Map<string, boolean>;
  setHasMoreHistory: (roomId: string, hasMore: boolean) => void;

  toggleMemoryRail: () => void;
  setMemorySearchQuery: (query: string) => void;
  clearMemoryActiveNote: () => void;
  /** Opens (or focuses) the Memory rail on a specific vault note — used by MemoryGalaxy's node click, reusing the exact same memory.get plumbing MemoryRail's search results already use. */
  openMemoryPath: (path: string) => void;

  togglePollsRail: () => void;
  dismissPoll: (pollId: string) => void;

  setActiveDockAppId: (appId: string | null) => void;
}

const MAX_INSPECT_FRAMES = 500;
const TYPING_TIMEOUT_MS = 12000;

export const useStore = create<UIState>((set, get) => ({
  ws: null,
  connected: false,
  connecting: false,
  agents: [],
  rooms: [],
  activeRoomId: null,
  messages: new Map(),
  turnCapBannerRoomId: null,
  tokenPauseBannerRoomId: null,
  sidebarCollapsed: false,
  inspectPanelOpen: false,
  inspectAgentId: null,
  filesRailOpen: false,
  inspectFrames: [],
  typing: new Map(),
  unreadByRoom: new Map(),
  globalCost: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 },
  roomTokenTotals: new Map(),
  agentTokenTotals: new Map(),
  budgetWarningByRoom: new Map(),
  errorToast: null,
  roomsWithHistoryLoaded: new Set(),
  hasMoreHistory: new Map(),
  autorouteRooms: new Set(),
  projects: [],
  projectAssignments: new Map(),
  archivedRooms: [],
  loopByRoom: new Map(),
  memoryRailOpen: false,
  memorySearchQuery: '',
  memorySearchResults: [],
  memoryActiveNote: null,
  memoryPinnedByRoom: new Map(),
  polls: [],
  pollsRailOpen: false,
  dismissedPollIds: new Set(),
  pollReviews: new Map(),
  reviewPolicyMode: 'mutations',
  dockApps: [],
  activeDockAppId: null,
  dossiersEnabled: false,
  ephemeral: [],
  savedAgentIds: [],

  setWs: (ws) => set({ ws }),
  setConnected: (connected) => set({ connected, connecting: false }),
  setConnecting: (connecting) => set({ connecting }),

  applyServerEvent: (event) =>
    set((state) => {
      const next = { ...state };
      const frame: InspectFrame = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        direction: 'in',
        at: Date.now(),
        event,
      };
      next.inspectFrames = [...state.inspectFrames.slice(-(MAX_INSPECT_FRAMES - 1)), frame];

      // room.autoroute.status (docs/DESIGN-router.md #2) is a gateway-local
      // extension of the frozen shared ServerEvent union (Room has no field
      // for this) — identical envelope shape, typed at the two endpoints
      // instead of packages/shared, same pattern as room.rollover in index.ts.
      if ((event as { type: string }).type === 'room.autoroute.status') {
        const payload = (event as unknown as { payload: { roomId: string; enabled: boolean } }).payload;
        const autorouteRooms = new Set(state.autorouteRooms);
        if (payload.enabled) autorouteRooms.add(payload.roomId);
        else autorouteRooms.delete(payload.roomId);
        return { ...next, autorouteRooms };
      }

      // loop.status (Wave 2) — same gateway-local-extension pattern as
      // room.autoroute.status above (Room has no field for this either).
      // Server is authoritative for round/phase/active on every message —
      // no client-side prediction, matching the "no painted status" rule.
      if ((event as { type: string }).type === 'loop.status') {
        const payload = (event as unknown as { payload: { roomId: string } & LoopStatus }).payload;
        const loopByRoom = new Map(state.loopByRoom);
        loopByRoom.set(payload.roomId, {
          active: payload.active,
          round: payload.round,
          maxRounds: payload.maxRounds,
          phase: payload.phase,
          builderSeat: payload.builderSeat,
          judgeSeat: payload.judgeSeat,
        });
        return { ...next, loopByRoom };
      }

      // agent.cost.snapshot (docs/TECH-DEBT.md "Agent telemetry reads 0s on a
      // fresh tab") is a gateway-local extension of the frozen ServerEvent
      // union (AgentSummary has no per-agent cost field) — same pattern as
      // room.autoroute.status above. Sent once per connect with the gateway's
      // already-rehydrated globalCost.byAgent (recomputeCostTotals at boot),
      // so a fresh tab (or a tab open across a gateway restart) shows real
      // totals immediately instead of waiting for the next live cost.event.
      // Only seeds agents this client hasn't already been live-accumulating
      // for — same non-stomping guard as roomTokenTotals' state.sync hydration
      // below, in case a cost.event for this session interleaves with connect.
      if ((event as { type: string }).type === 'agent.cost.snapshot') {
        const payload = (
          event as unknown as {
            payload: { byAgent: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }> };
          }
        ).payload;
        const agentTotals = new Map(state.agentTokenTotals);
        for (const [agentId, totals] of Object.entries(payload.byAgent)) {
          if (agentTotals.has(agentId)) continue;
          agentTotals.set(agentId, {
            tokensIn: totals.tokensIn,
            tokensOut: totals.tokensOut,
            estimatedCostUsd: totals.costUsd,
            recentTurns: [],
          });
        }
        return { ...next, agentTokenTotals: agentTotals };
      }

      // poll.updated (docs/DESIGN-approvals-rail.md #3) is a gateway-local
      // extension of the frozen shared ServerEvent union (ServerEvent has no
      // dedicated poll field) — typed at the two endpoints instead of
      // packages/shared, same cast idiom as room.autoroute.status above.
      // Upsert by id: covers create, live edits, and decide/expire in one path.
      if ((event as { type: string }).type === 'poll.updated') {
        const payload = (event as unknown as { payload: Poll }).payload;
        const idx = state.polls.findIndex((p) => p.id === payload.id);
        const polls = idx >= 0 ? [...state.polls] : [...state.polls, payload];
        if (idx >= 0) polls[idx] = payload;
        // A poll that's no longer open (decided/expired) shouldn't stay
        // dismissed forever if it somehow reopens later — drop the flag once
        // it leaves 'open' so a future reopen (unlikely, but no server
        // guarantee against it) shows the inline card again.
        let dismissedPollIds = state.dismissedPollIds;
        if (payload.status !== 'open' && dismissedPollIds.has(payload.id)) {
          dismissedPollIds = new Set(dismissedPollIds);
          dismissedPollIds.delete(payload.id);
        }
        return { ...next, polls, dismissedPollIds };
      }

      // poll.review.updated (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md)
      // — same gateway-local-extension idiom as poll.updated above. Upsert
      // by id WITHIN that poll's review array (a poll can carry up to 2
      // active slots, plus timed-out originals once a T+4 substitute has
      // been spawned).
      if ((event as { type: string }).type === 'poll.review.updated') {
        const review = (event as unknown as { payload: PollReview }).payload;
        const pollReviews = new Map(state.pollReviews);
        const existing = pollReviews.get(review.pollId) ?? [];
        const idx = existing.findIndex((r) => r.id === review.id);
        const updated = idx >= 0 ? [...existing] : [...existing, review];
        if (idx >= 0) updated[idx] = review;
        pollReviews.set(review.pollId, updated);
        return { ...next, pollReviews };
      }

      // review.policy.status (Wave 7 M3): broadcast whenever the humanToken-
      // gated POST /api/review-policy toggle succeeds — every open tab
      // reflects the CURRENT mode live, same "server is authoritative, no
      // client-side prediction" rule as loop.status.
      if ((event as { type: string }).type === 'review.policy.status') {
        const payload = (event as unknown as { payload: { mode: ReviewPolicyMode } }).payload;
        return { ...next, reviewPolicyMode: payload.mode };
      }

      switch (event.type) {
        case 'state.sync': {
          next.agents = event.payload.agents;
          next.rooms = event.payload.rooms;
          // Projects layer (Milestone E, slimmed): state.sync's payload has
          // three gateway-local extension fields ServerEvent's shared type
          // doesn't declare (packages/shared is frozen) — read via the same
          // cast idiom as room.autoroute.status above, riding this existing
          // broadcast instead of a discrete event/endpoint.
          {
            const extra = (event as unknown as {
              payload: {
                archivedRooms?: Room[];
                projects?: Array<{ id: string; name: string }>;
                projectAssignments?: Record<string, string>;
                polls?: Poll[];
                pollReviews?: PollReview[];
                reviewPolicy?: { mode: ReviewPolicyMode };
                dockApps?: DockAppEntry[];
                dossiersEnabled?: boolean;
                ephemeral?: EphemeralPresence[];
                savedAgentIds?: string[];
              };
            }).payload;
            next.archivedRooms = extra.archivedRooms ?? [];
            next.projects = extra.projects ?? [];
            next.projectAssignments = new Map(Object.entries(extra.projectAssignments ?? {}));
            // Approvals/Polls rail (docs/DESIGN-approvals-rail.md #3): same
            // additive state.sync field as archivedRooms/projects above.
            // Full replace on hydrate — the gateway is authoritative and this
            // fires on every (re)connect, so there's no live-accumulation to
            // preserve the way roomTokenTotals guards against below.
            next.polls = extra.polls ?? [];
            // Two-Reviewer Policy (Wave 7 M3): same full-replace-on-hydrate
            // pattern as polls above — group the flat array back into the
            // per-poll Map this store keys reviews by.
            {
              const pollReviews = new Map<string, PollReview[]>();
              for (const review of extra.pollReviews ?? []) {
                const list = pollReviews.get(review.pollId) ?? [];
                list.push(review);
                pollReviews.set(review.pollId, list);
              }
              next.pollReviews = pollReviews;
            }
            next.reviewPolicyMode = extra.reviewPolicy?.mode ?? next.reviewPolicyMode;
            // Studio Dock registry (docs/DESIGN-studio-dock.md §2): static
            // per-boot list, same additive state.sync field pattern.
            next.dockApps = extra.dockApps ?? [];
            // Agent Dossiers (Wave 7 stretch, M4): boolean feature flag, same
            // additive state.sync field pattern — absent/false hides the
            // Dossier tab in InspectPanel entirely.
            next.dossiersEnabled = extra.dossiersEnabled ?? false;
            // TEMP-agent "on duty" presence (2026-08-02): same full-replace
            // pattern as polls/dockApps above — the gateway already filters
            // to non-expired entries (ephemeral.ts's list()), so this is a
            // straight hydrate, no client-side expiry logic needed.
            next.ephemeral = extra.ephemeral ?? [];
            next.savedAgentIds = extra.savedAgentIds ?? [];
          }
          // Keep the local room choice while it still exists; when it falls
          // away (archived), follow the gateway's default — the Lobby.
          const stillExists =
            state.activeRoomId != null && next.rooms.some((r) => r.id === state.activeRoomId);
          next.activeRoomId = stillExists
            ? state.activeRoomId
            : event.payload.activeRoomId ?? next.rooms[0]?.id ?? null;
          if (next.rooms.length < state.rooms.length) {
            const roomIds = new Set(next.rooms.map((r) => r.id));
            const unread = new Map(state.unreadByRoom);
            for (const id of unread.keys()) {
              if (!roomIds.has(id)) unread.delete(id);
            }
            next.unreadByRoom = unread;
            const loopByRoom = new Map(state.loopByRoom);
            for (const id of loopByRoom.keys()) {
              if (!roomIds.has(id)) loopByRoom.delete(id);
            }
            next.loopByRoom = loopByRoom;
          }
          // Hydrate room token/cost totals from the gateway's rehydrated
          // costTracker (docs/DESIGN-token-budgets.md boot rehydration) —
          // only for rooms we haven't already been live-accumulating via
          // cost.event, so a mid-session state.sync (e.g. after a room
          // mutation) can't stomp totals this client already tracked more
          // precisely (per-turn) than the room-level snapshot.
          const roomTotals = new Map(state.roomTokenTotals);
          for (const room of next.rooms) {
            if (roomTotals.has(room.id)) continue;
            if (room.costTracker) {
              roomTotals.set(room.id, {
                tokensIn: room.costTracker.tokensIn,
                tokensOut: room.costTracker.tokensOut,
                estimatedCostUsd: room.costTracker.estimatedCostUsd,
              });
            }
          }
          next.roomTokenTotals = roomTotals;
          break;
        }
        case 'agent.status': {
          const idx = next.agents.findIndex((a) => a.id === event.payload.agentId);
          if (idx >= 0) {
            next.agents = [...next.agents];
            next.agents[idx] = {
              ...next.agents[idx],
              status: event.payload.status,
              statusReason: event.payload.reason,
              health: event.payload.health,
            };
          }
          break;
        }
        case 'room.created':
          next.rooms = [...next.rooms, event.payload];
          break;
        case 'room.updated': {
          const ri = next.rooms.findIndex((r) => r.id === event.payload.id);
          if (ri >= 0) {
            const rooms = [...next.rooms];
            rooms[ri] = event.payload;
            next.rooms = rooms;
          }
          break;
        }
        case 'message.new': {
          const list = next.messages.get(event.payload.roomId) ?? [];
          const messages = new Map(next.messages);
          messages.set(event.payload.roomId, [...list, event.payload]);
          next.messages = messages;
          if (event.payload.senderId === 'human') {
            next.turnCapBannerRoomId = null;
            // Token-pause resume is asymmetric server-side (budgets.ts
            // maybeResumeFromTokenPause — the +25% extension is granted only
            // once), but the BANNER can optimistically clear here the same
            // way the turn-cap banner does: if the room is still paused
            // after this message (extension already spent), the next
            // budget.exceeded broadcast re-sets it.
            next.tokenPauseBannerRoomId = null;
          }
          // Clear typing indicator for the sender in this room once their message lands.
          if (event.payload.senderId !== 'human') {
            const typing = new Map(next.typing);
            typing.delete(`${event.payload.roomId}:${event.payload.senderId}`);
            next.typing = typing;

            // Voice v1 auto-read (docs/DESIGN-voice-v1.md): hand agent
            // messages to the voice store, which owns the toggle/visibility
            // gating and the bounded read-queue. Pure client-side hop — no
            // wire event, voiceStore is a separate zustand store
            // (packages/ui/src/store/voiceStore.ts), not part of this one.
            //
            // try/catch fix (review 2026-07-09): this call runs synchronously
            // inside THIS reducer's set() updater, before `next` (already
            // holding the appended message) is returned below. Web Speech API
            // implementations are inconsistent across browsers — an uncaught
            // synchronous throw anywhere down this call chain (speechSynthesis
            // .getVoices(), new SpeechSynthesisUtterance(), synth.speak(), all
            // reachable from handleIncomingAgentMessage) would abort this
            // set() callback before it returns, so zustand would never commit
            // `next` — silently dropping the chat message itself for this
            // event, not merely failing to read it aloud. A bystander feature
            // must never be able to take down the primary message-append path.
            try {
              useVoiceStore.getState().handleIncomingAgentMessage({
                messageId: event.payload.id,
                roomId: event.payload.roomId,
                senderId: event.payload.senderId,
                content: event.payload.content,
              });
            } catch (e) {
              console.error('Voice auto-read failed for an incoming message', e);
            }
          }
          if (event.payload.roomId !== state.activeRoomId) {
            const unread = new Map(next.unreadByRoom);
            unread.set(event.payload.roomId, (unread.get(event.payload.roomId) ?? 0) + 1);
            next.unreadByRoom = unread;
          }
          break;
        }
        case 'message.updated': {
          const list = next.messages.get(event.payload.roomId) ?? [];
          const mi = list.findIndex((m) => m.id === event.payload.id);
          if (mi >= 0) {
            const updated = [...list];
            updated[mi] = event.payload;
            const messages = new Map(next.messages);
            messages.set(event.payload.roomId, updated);
            next.messages = messages;
          }
          break;
        }
        case 'message.deleted': {
          const list = next.messages.get(event.payload.roomId) ?? [];
          const messages = new Map(next.messages);
          messages.set(
            event.payload.roomId,
            list.filter((m) => m.id !== event.payload.messageId)
          );
          next.messages = messages;
          break;
        }
        case 'message.reaction': {
          // Server is authoritative for the toggle result via message.updated in this
          // gateway's implementation; but if a bare reaction event arrives, patch locally.
          break;
        }
        case 'chat.typing': {
          const key = `${event.payload.roomId}:${event.payload.agentId}`;
          const typing = new Map(next.typing);
          typing.set(key, {
            agentId: event.payload.agentId,
            roomId: event.payload.roomId,
            tool: event.payload.tool,
            updatedAt: Date.now(),
          });
          next.typing = typing;
          break;
        }
        case 'cost.event': {
          const { agentId, roomId, tokensIn, tokensOut, estimatedCostUsd } = event.payload;
          next.globalCost = {
            tokensIn: next.globalCost.tokensIn + tokensIn,
            tokensOut: next.globalCost.tokensOut + tokensOut,
            estimatedCostUsd: next.globalCost.estimatedCostUsd + estimatedCostUsd,
          };

          if (roomId) {
            const roomTotals = new Map(next.roomTokenTotals);
            const prevRoom = roomTotals.get(roomId) ?? {
              tokensIn: 0,
              tokensOut: 0,
              estimatedCostUsd: 0,
            };
            roomTotals.set(roomId, {
              tokensIn: prevRoom.tokensIn + tokensIn,
              tokensOut: prevRoom.tokensOut + tokensOut,
              estimatedCostUsd: prevRoom.estimatedCostUsd + estimatedCostUsd,
            });
            next.roomTokenTotals = roomTotals;
          }

          const agentTotals = new Map(next.agentTokenTotals);
          const prevAgent = agentTotals.get(agentId) ?? {
            tokensIn: 0,
            tokensOut: 0,
            estimatedCostUsd: 0,
            recentTurns: [] as RecentTurn[],
          };
          const recentTurns = [
            ...prevAgent.recentTurns,
            { tokensIn, tokensOut, costUsd: estimatedCostUsd, at: event.payload.timestamp },
          ].slice(-MAX_RECENT_TURNS_PER_AGENT);
          agentTotals.set(agentId, {
            tokensIn: prevAgent.tokensIn + tokensIn,
            tokensOut: prevAgent.tokensOut + tokensOut,
            estimatedCostUsd: prevAgent.estimatedCostUsd + estimatedCostUsd,
            recentTurns,
          });
          next.agentTokenTotals = agentTotals;
          break;
        }
        case 'budget.warning': {
          const bw = new Map(next.budgetWarningByRoom);
          bw.set(event.payload.roomId, event.payload.percent);
          next.budgetWarningByRoom = bw;
          // NOTE: percent:100 on budget.warning is currently emitted by the
          // TURN CAP (relay.ts commitAgentReply, reusing this event type
          // until shared types add a dedicated turn-cap event — see that
          // comment). Keep rendering it as the turn-cap pause notice; the
          // TOKEN budget's 100% case is its own event, budget.exceeded below.
          if (event.payload.percent >= 100) {
            next.turnCapBannerRoomId = event.payload.roomId;
          }
          break;
        }
        case 'budget.exceeded':
          next.tokenPauseBannerRoomId = event.payload.roomId;
          break;
        case 'memory.results':
          next.memorySearchResults = event.payload.items;
          break;
        case 'memory.note': {
          next.memoryActiveNote = {
            path: event.payload.path,
            title: event.payload.title,
            markdown: event.payload.markdown,
            pinnedInRooms: event.payload.pinnedInRooms,
          };
          // Rebuild this note's room membership across ALL rooms from the
          // authoritative pinnedInRooms list the gateway just sent — add it
          // to every room listed, remove it from every room not listed. This
          // event is the only signal the wire gives about a note's pin
          // state, so it's treated as the full truth for this one path,
          // every time it arrives (initial memory.get, and after every
          // pin-note/unpin-note).
          const pinnedByRoom = new Map(
            Array.from(state.memoryPinnedByRoom.entries()).map(([roomId, m]) => [roomId, new Map(m)])
          );
          const pinnedSet = new Set(event.payload.pinnedInRooms);
          for (const [roomId, notes] of pinnedByRoom) {
            if (!pinnedSet.has(roomId)) notes.delete(event.payload.path);
          }
          for (const roomId of pinnedSet) {
            const notes = pinnedByRoom.get(roomId) ?? new Map<string, string>();
            notes.set(event.payload.path, event.payload.title);
            pinnedByRoom.set(roomId, notes);
          }
          next.memoryPinnedByRoom = pinnedByRoom;
          break;
        }
        case 'error':
          next.errorToast = {
            code: event.payload.code,
            message: event.payload.message,
            at: Date.now(),
          };
          break;
        default:
          break;
      }

      return next;
    }),

  sendClientEvent: (event) => {
    const { ws, connected } = get();
    if (!ws || !connected || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    // humanToken auto-attach (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md
    // B2): poll.decide / agent.disconnect require it server-side
    // (index.ts/pollsRoutes.ts) — centralizing the attach HERE means no
    // individual call site (PollCard's decide(), the agent-card disconnect
    // button, …) has to remember to add it. "No typed friction anywhere"
    // (design doc) — this is silent plumbing, never a prompt. Every OTHER
    // event type is sent unchanged; readAsHumanTokenGated only widens the
    // payload object, it never removes anything a caller already set.
    const HUMAN_TOKEN_GATED_TYPES = new Set(['poll.decide', 'agent.disconnect']);
    const outgoing = HUMAN_TOKEN_GATED_TYPES.has(event.type)
      ? { ...event, payload: { ...(event.payload as Record<string, unknown>), humanToken: getHumanToken() } }
      : event;
    const envelope: ClientEnvelope = {
      v: 1,
      timestamp: Date.now(),
      ...(outgoing as ClientEvent),
    };
    ws.send(JSON.stringify(envelope));
    set((state) => {
      const frame: InspectFrame = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        direction: 'out',
        at: Date.now(),
        event,
      };
      return { inspectFrames: [...state.inspectFrames.slice(-(MAX_INSPECT_FRAMES - 1)), frame] };
    });
    return true;
  },

  setActiveRoom: (roomId) =>
    set((state) => {
      const unread = new Map(state.unreadByRoom);
      unread.delete(roomId);
      // Picking a room returns the main pane to chat (docs/DESIGN-studio-dock.md
      // §1: "mounts it in the main pane... until the user clicks back to a room").
      return { activeRoomId: roomId, unreadByRoom: unread, activeDockAppId: null };
    }),
  dismissErrorToast: () => set({ errorToast: null }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  // Only one right-side rail at a time — simplest consistent behavior in the
  // existing flex layout (Sidebar | ChatView | one rail), so opening either
  // panel closes the others rather than stacking fixed-width rails.
  toggleInspectPanel: () =>
    set((s) => ({
      inspectPanelOpen: !s.inspectPanelOpen,
      filesRailOpen: false,
      memoryRailOpen: false,
      pollsRailOpen: false,
    })),
  setInspectAgent: (agentId) =>
    set({
      inspectAgentId: agentId,
      inspectPanelOpen: true,
      filesRailOpen: false,
      memoryRailOpen: false,
      pollsRailOpen: false,
    }),
  toggleFilesRail: () =>
    set((s) => ({
      filesRailOpen: !s.filesRailOpen,
      inspectPanelOpen: false,
      memoryRailOpen: false,
      pollsRailOpen: false,
    })),
  toggleMemoryRail: () =>
    set((s) => ({
      memoryRailOpen: !s.memoryRailOpen,
      inspectPanelOpen: false,
      filesRailOpen: false,
      pollsRailOpen: false,
    })),
  setMemorySearchQuery: (query) => set({ memorySearchQuery: query }),
  clearMemoryActiveNote: () => set({ memoryActiveNote: null }),
  openMemoryPath: (path) => {
    const state = get();
    state.sendClientEvent({ type: 'memory.get', payload: { path } });
    if (!state.memoryRailOpen) state.toggleMemoryRail();
  },

  togglePollsRail: () =>
    set((s) => ({
      pollsRailOpen: !s.pollsRailOpen,
      inspectPanelOpen: false,
      filesRailOpen: false,
      memoryRailOpen: false,
    })),
  dismissPoll: (pollId) =>
    set((s) => {
      const dismissedPollIds = new Set(s.dismissedPollIds);
      dismissedPollIds.add(pollId);
      return { dismissedPollIds };
    }),

  setActiveDockAppId: (appId) => set({ activeDockAppId: appId }),

  markHistoryLoaded: (roomId) =>
    set((s) => {
      const next = new Set(s.roomsWithHistoryLoaded);
      next.add(roomId);
      return { roomsWithHistoryLoaded: next };
    }),

  prependMessages: (roomId, older) =>
    set((s) => {
      const existing = s.messages.get(roomId) ?? [];
      const existingIds = new Set(existing.map((m) => m.id));
      const dedupedOlder = older.filter((m) => !existingIds.has(m.id));
      const messages = new Map(s.messages);
      messages.set(roomId, [...dedupedOlder, ...existing]);
      return { messages };
    }),

  setHasMoreHistory: (roomId, hasMore) =>
    set((s) => {
      const next = new Map(s.hasMoreHistory);
      next.set(roomId, hasMore);
      return { hasMoreHistory: next };
    }),
}));

/** Sweep stale typing indicators so a dead tool-call doesn't show "working" forever. */
export function sweepStaleTyping() {
  const state = useStore.getState();
  const now = Date.now();
  let changed = false;
  const typing = new Map(state.typing);
  for (const [key, t] of typing) {
    if (now - t.updatedAt > TYPING_TIMEOUT_MS) {
      typing.delete(key);
      changed = true;
    }
  }
  if (changed) useStore.setState({ typing });
}
