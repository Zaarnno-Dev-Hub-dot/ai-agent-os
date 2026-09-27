/**
 * Paperclip bridge-in poller (Wave 4, docs/DESIGN-approvals-rail.md §4).
 * Motivating incident: a Paperclip hire approval the operator could not find in
 * Paperclip's own inbox while living in this dashboard (2026-07-07). This
 * module polls `GET /api/companies/:cid/approvals?status=pending` for every
 * company listed in `data/paperclip.json` and turns each NEW approval into a
 * poll card in a find-or-create "Approvals" room (human-only membership — no
 * agent members, per the design doc).
 *
 * Isolation contract (design doc: "poller failures log-once and never affect
 * the gateway, same as router-log's fail-once"): every network call is
 * wrapped so a down/unreachable Paperclip NEVER throws into the interval
 * timer or takes the gateway down. Unlike router-log's PERMANENT latch,
 * this poller retries every tick by design (Paperclip coming back up must
 * self-heal without a restart) — so the log-once behavior here is
 * per-outage-streak: one console.error when a company's fetch first starts
 * failing, silence on repeats of the SAME failure, and a fresh log the next
 * time it starts failing again after a successful poll in between.
 *
 * Approvals-room heal (2026-07-28): every poll cycle now ensures the
 * "Approvals" room exists BEFORE and regardless of any Paperclip fetch —
 * the room silently vanished from live state ~2026-07-23 while Paperclip
 * was down (since 07-21) and the find-or-create that used to run only
 * after a successful fetch never fired (manual restore:
 * scripts/restore-approvals-room.mjs). Gateway boot + each 60s tick now
 * guarantee the room, Paperclip up or not, companies configured or not.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Room } from '@agent-os/shared';
import { createPoll, hasApprovalRef, type CreatePollInput, type PollsState } from './polls.js';

export interface PaperclipCompanyConfig {
  id: string;
  label: string;
}

export interface PaperclipConfig {
  companies: PaperclipCompanyConfig[];
}

/** Seed entry — the company already live in this deployment (scout-verified, 2026-07-07). */
const SEED_COMPANY: PaperclipCompanyConfig = {
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Acme Corp',
};

/** Default local Paperclip origin. Overridable (tests point this at an ephemeral fake server). */
export const DEFAULT_PAPERCLIP_BASE_URL = 'http://127.0.0.1:3100';

function paperclipConfigPath(dataDir: string): string {
  return join(dataDir, 'paperclip.json');
}

function isCompanyConfig(v: unknown): v is PaperclipCompanyConfig {
  return (
    typeof v === 'object' &&
    v != null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { label?: unknown }).label === 'string'
  );
}

/**
 * Load `data/paperclip.json`, writing it with the seed entry first if
 * absent — same boot-created idiom as loop.ts's ensureLoopsConfig. A
 * corrupt/unparsable file falls back to `{ companies: [] }` (NOT re-seeded —
 * a hand-edit that removed the seed company is an intentional choice, not a
 * crash to paper over).
 */
export function ensurePaperclipConfig(dataDir: string): PaperclipConfig {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = paperclipConfigPath(dataDir);
  if (!existsSync(path)) {
    const seeded: PaperclipConfig = { companies: [SEED_COMPANY] };
    writeFileSync(path, JSON.stringify(seeded, null, 2), 'utf8');
    return seeded;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { companies?: unknown };
    const companies = Array.isArray(parsed.companies) ? parsed.companies.filter(isCompanyConfig) : [];
    return { companies };
  } catch {
    return { companies: [] };
  }
}

/** Raw shape read off Paperclip's `/api/companies/:cid/approvals` response (scout-verified field set). */
export interface PaperclipApproval {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
}

function isPaperclipApproval(v: unknown): v is PaperclipApproval {
  return (
    typeof v === 'object' &&
    v != null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { companyId?: unknown }).companyId === 'string' &&
    typeof (v as { type?: unknown }).type === 'string' &&
    typeof (v as { status?: unknown }).status === 'string'
  );
}

/** GET pending approvals for one company. Throws on any network/parse failure — caller isolates. */
export async function fetchPendingApprovals(
  baseUrl: string,
  companyId: string,
  timeoutMs = 5000
): Promise<PaperclipApproval[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/companies/${encodeURIComponent(companyId)}/approvals?status=pending`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Paperclip approvals fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error('Paperclip approvals response was not an array.');
    return body.filter(isPaperclipApproval);
  } finally {
    clearTimeout(timer);
  }
}

/** POST the human decision back to Paperclip. Throws on failure — caller (index.ts's decide handler) logs-once and never lets this throw into the WS/REST decide path. */
export async function postApprovalDecision(
  baseUrl: string,
  approvalId: string,
  action: 'approve' | 'reject',
  decisionNote: string | undefined,
  timeoutMs = 5000
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(approvalId)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionNote: decisionNote ?? null }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Paperclip ${action} POST-back failed: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** `Approvals` — the exact, reused-by-name human-only room the poller finds-or-creates (design doc §4). Mirrors bridge.ts's paperclipRoomName precedent. */
export const APPROVALS_ROOM_NAME = 'Approvals';

/** requestedBy value stamped on every poller-created poll — never a real seat id, so the requester-notify branch (bridge.ts mechanics) never fires for these; the notify path for source='paperclip' polls is the approve/reject POST-back instead (design doc §3c). */
export const PAPERCLIP_REQUESTER = 'paperclip';

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  hire_agent: 'Hire agent',
};

function titleForApproval(approval: PaperclipApproval): string {
  const label = APPROVAL_TYPE_LABELS[approval.type] ?? approval.type;
  const payload = approval.payload ?? {};
  const name =
    (typeof payload.name === 'string' && payload.name) ||
    (typeof payload.agentName === 'string' && payload.agentName) ||
    (typeof payload.title === 'string' && payload.title) ||
    approval.id;
  return `${label}: ${name}`;
}

/** Build the poll-creation input for one Paperclip approval. Exported for direct unit testing without a live server. */
export function pollInputForApproval(approval: PaperclipApproval, roomId: string): CreatePollInput {
  return {
    roomId,
    question: titleForApproval(approval),
    options: [{ label: 'Approve' }, { label: 'Reject' }],
    requestedBy: PAPERCLIP_REQUESTER,
    // No recommendation, no expiry — the design doc lists these as "none" for v1 bridge-in.
    source: 'paperclip',
    externalRef: { approvalId: approval.id, companyId: approval.companyId },
  };
}

export interface PaperclipPollerContext {
  dataDir: string;
  baseUrl: string;
  config: PaperclipConfig;
  rooms: Map<string, Room>;
  /** Find-or-create + persist the Approvals room (same helper index.ts's other room-creating call sites use). */
  findOrCreateApprovalsRoom: () => Room;
  getPollsState: () => PollsState;
  setPollsState: (state: PollsState) => void;
  /** Called once per newly-created poll, so index.ts can broadcast poll.updated + a fresh state.sync — same "caller owns the broadcast" split as loop.ts. */
  onPollCreated: (poll: PollsState['polls'][number]) => void;
}

/** Per-company outage latch (module-scoped, process-lifetime — reset on gateway restart, same class as router.ts's routerLogDisabled but keyed and NOT permanent, see module doc comment). */
const failingCompanies = new Set<string>();

/** Approvals-room-heal outage latch — same log-once-per-outage-streak semantics as failingCompanies, for the room find-or-create itself. */
let approvalsRoomHealFailing = false;

/**
 * One poll cycle across every configured company. Never throws — each
 * company's fetch is isolated so one down/misconfigured company does not
 * block another's polling, and any failure log-once-per-outage-streak
 * (module doc comment) rather than spamming every 60s tick.
 */
export async function runPaperclipPollOnce(ctx: PaperclipPollerContext): Promise<void> {
  // Approvals-room heal, decoupled from Paperclip health (module doc
  // comment, 2026-07-28): runs first, unconditionally — a down Paperclip
  // or an empty company list must never leave the room unhealed again.
  // Isolated so a room-persist failure keeps this function's never-throws
  // contract.
  let healedRoom: Room | undefined;
  try {
    healedRoom = ctx.findOrCreateApprovalsRoom();
    approvalsRoomHealFailing = false;
  } catch (e) {
    if (!approvalsRoomHealFailing) {
      approvalsRoomHealFailing = true;
      console.error('[paperclip] Approvals-room heal failed — will keep retrying every tick, silencing repeats of this outage', e);
    }
  }
  for (const company of ctx.config.companies) {
    try {
      const approvals = await fetchPendingApprovals(ctx.baseUrl, company.id);
      failingCompanies.delete(company.id);
      let state = ctx.getPollsState();
      const room = healedRoom ?? ctx.findOrCreateApprovalsRoom();
      for (const approval of approvals) {
        if (hasApprovalRef(state, approval.id)) continue; // de-dupe by externalRef.approvalId
        const result = createPoll(state, pollInputForApproval(approval, room.id));
        if (!result.ok) continue; // structurally invalid approval payload — skip, do not crash the cycle
        state = result.state;
        ctx.onPollCreated(result.poll);
      }
      ctx.setPollsState(state);
    } catch (e) {
      if (!failingCompanies.has(company.id)) {
        failingCompanies.add(company.id);
        console.error(`[paperclip] poll failed for company ${company.label} (${company.id}) — will keep retrying every tick, silencing repeats of this outage`, e);
      }
    }
  }
}

/** Test/shutdown hook: clears the outage latches so tests don't leak state across runs sharing this module instance. */
export function resetPaperclipPollerState(): void {
  failingCompanies.clear();
  approvalsRoomHealFailing = false;
}

/** Find-or-create the human-only "Approvals" room. Pure given the current room map — index.ts's caller supplies persistRoomMutation. */
export function findApprovalsRoom(rooms: Map<string, Room>): Room | undefined {
  return Array.from(rooms.values()).find((r) => r.name === APPROVALS_ROOM_NAME && r.archivedAt == null);
}
