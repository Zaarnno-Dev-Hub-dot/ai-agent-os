/**
 * Polls / Approvals rail. Decision
 * cards agents — or bridged systems like Paperclip — put in front of the operator
 * inside the dashboard. Config lives at `data/polls.json` (gateway-local,
 * load-at-boot/save-on-mutation — same shape-of-problem as projects.ts's
 * data/projects.json). This module is pure gateway-local state plus a
 * handful of exported functions; the wiring (WS/REST routes, expiry sweep
 * timer, notification side effects) lives in index.ts, same split as
 * router.ts/loop.ts/projects.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface PollOption {
  id: string;
  label: string;
}

export interface PollDecision {
  optionId: string;
  /** A human seat's caller id (currently always 'human'), or 'auto-default' for an expiry auto-decide. */
  decidedBy: string;
  decidedAt: number;
  note?: string;
}

/** One deferral event. Logged, never overwritten — repeat defers are a growing list, not a single mutable timestamp. */
export interface PollDeferral {
  at: number;
  note?: string;
}

/**
 * Rich-card evidence (Wave 6): a screenshot/graph/table/text blob attached to
 * a poll or to one side of a dispute. `url` and `data` are mutually
 * optional-but-one-should-be-present — rendering (and the allowlist that
 * guards it) lives in the UI's pollPresent.ts, never here; this module only
 * shapes/persists the data.
 */
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

export type PollMessageSeverity = 'info' | 'note' | 'needs-info';

/** A note posted onto an open poll without deciding it — deferrals and more-info asks both append one of these. */
export interface PollMessage {
  at: number;
  sender?: string;
  severity: PollMessageSeverity;
  content: string;
}

/**
 * 'withdrawn': a human "remove this decision"
 * outcome, distinct from 'expired' (ran out the clock) and 'decided' (an
 * option was picked) — a poll a human retired on purpose, never voted on.
 * Added because the only prior exit from an open card was defer, which just
 * re-queues it.
 */
export type PollStatus = 'open' | 'decided' | 'expired' | 'withdrawn';

/** One file's display-ready diff — built once at propose time by workshop.ts's buildUnifiedDiff, already truncated to its per-file line cap. Distinct from Message.attachments' AttachmentRef (byte-stored file uploads): this is ephemeral, poll-scoped diff TEXT, never routed through the /api/files store. */
export interface PollDiffAttachment {
  repoPath: string;
  diff: string;
  truncated: boolean;
}

/** One target file's EXACT proposed content, snapshotted at propose time. */
export interface WorkshopSnapshotTarget {
  repoPath: string;
  content: string;
}

/**
 * Everything workshop-apply needs to write the commit, captured at propose
 * time — apply NEVER re-reads the seat's live draft workspace. Without this,
 * a seat could show the human one diff and then swap the draft file before
 * approval lands (TOCTOU); snapshotting means what got approved (the diff)
 * is byte-for-byte what gets committed.
 */
export interface WorkshopSnapshot {
  seatId: string;
  taskSlug: string;
  targets: WorkshopSnapshotTarget[];
}

export interface Poll {
  id: string;
  roomId: string;
  question: string;
  detail?: string;
  /** Plain-language WHY, distinct from `detail` (kept for v1 wire-compat) — the inbox card's "Why" block prefers this when present. */
  detailSummary?: string;
  /** Plain-language recommendation text, shown when `recommendationId` doesn't carry enough on its own (falls back to the recommended option's label). */
  recommendation?: string;
  options: PollOption[];
  /** Must reference a real option id, when present. */
  recommendationId?: string;
  requestedBy: string;
  createdAt: number;
  expiresAt?: number;
  /**
   * The expiresAt this poll was FIRST created with — set once at creation,
   * never mutated. deferPoll() extends the live `expiresAt` by
   * `originalExpiresAt - createdAt` on every deferral so repeat defers
   * compound off the same fixed increment rather than the already-extended
   * value (the bug this replaces: extending off the CURRENT expiresAt with
   * "now + remaining" is a no-op, since remaining = expiresAt - now already).
   */
  originalExpiresAt?: number;
  /** Must reference a real option id, when present. Auto-decided to this option on expiry. FORBIDDEN when source==='workshop' (see createPoll) — a workshop apply must never auto-run unattended. */
  defaultOptionId?: string;
  status: PollStatus;
  decision?: PollDecision;
  /** Deferral log — capped at MAX_POLL_DEFERRALS by deferPoll. */
  deferrals?: PollDeferral[];
  /** Non-deciding notes posted on an open poll (deferral notes, more-info asks) — rendered in the inbox card's log, additive to v1. */
  messages?: PollMessage[];
  source: 'local' | 'paperclip' | 'workshop';
  externalRef?: { approvalId: string; companyId: string };
  /** Rich-card evidence. */
  attachments?: PollAttachment[];
  /** Both sides of an agent disagreement, unedited. */
  disputeSides?: PollDisputeSide[];
  /** source==='workshop' only — per-file diffs for the poll card. */
  diffAttachments?: PollDiffAttachment[];
  /** source==='workshop' only — consumed by workshopRoutes.ts's applyWorkshopPoll on approve. */
  workshopSnapshot?: WorkshopSnapshot;
}

/** `data/polls.json` shape: a flat array, newest-created-last (same append order projects.ts uses for its arrays). */
export interface PollsState {
  polls: Poll[];
}

function pollsFilePath(dataDir: string): string {
  return join(dataDir, 'polls.json');
}

function isPollOption(v: unknown): v is PollOption {
  return (
    typeof v === 'object' &&
    v != null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { label?: unknown }).label === 'string'
  );
}

function isPollAttachment(v: unknown): v is PollAttachment {
  if (typeof v !== 'object' || v == null) return false;
  const a = v as Record<string, unknown>;
  if (a.kind !== 'image' && a.kind !== 'graph' && a.kind !== 'table' && a.kind !== 'text') return false;
  if (a.url != null && typeof a.url !== 'string') return false;
  if (a.data != null && typeof a.data !== 'string') return false;
  if (a.caption != null && typeof a.caption !== 'string') return false;
  if (a.source != null && typeof a.source !== 'string') return false;
  return true;
}

function isPollDeferral(v: unknown): v is PollDeferral {
  if (typeof v !== 'object' || v == null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.at === 'number' && (d.note == null || typeof d.note === 'string');
}

function isPollMessage(v: unknown): v is PollMessage {
  if (typeof v !== 'object' || v == null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.at === 'number' &&
    typeof m.content === 'string' &&
    (m.sender == null || typeof m.sender === 'string') &&
    (m.severity === 'info' || m.severity === 'note' || m.severity === 'needs-info')
  );
}

function isPollDisputeSide(v: unknown): v is PollDisputeSide {
  if (typeof v !== 'object' || v == null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.agent !== 'string' || d.agent.trim().length === 0) return false;
  if (d.statement != null && typeof d.statement !== 'string') return false;
  if (d.summary != null && typeof d.summary !== 'string') return false;
  if (d.evidence != null && (!Array.isArray(d.evidence) || !d.evidence.every(isPollAttachment))) return false;
  return true;
}

/** Defensive shape validation so a hand-edited or truncated file degrades to empty state, never a crash — same idiom as projects.ts's isProjectRecord. */
function isPoll(v: unknown): v is Poll {
  if (typeof v !== 'object' || v == null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.roomId === 'string' &&
    typeof p.question === 'string' &&
    Array.isArray(p.options) &&
    p.options.every(isPollOption) &&
    typeof p.requestedBy === 'string' &&
    typeof p.createdAt === 'number' &&
    (p.status === 'open' || p.status === 'decided' || p.status === 'expired' || p.status === 'withdrawn') &&
    (p.source === 'local' || p.source === 'paperclip' || p.source === 'workshop') &&
    (p.deferrals == null || (Array.isArray(p.deferrals) && p.deferrals.every(isPollDeferral))) &&
    (p.messages == null || (Array.isArray(p.messages) && p.messages.every(isPollMessage))) &&
    (p.attachments == null || (Array.isArray(p.attachments) && p.attachments.every(isPollAttachment))) &&
    (p.disputeSides == null || (Array.isArray(p.disputeSides) && p.disputeSides.every(isPollDisputeSide)))
  );
}

/** Load `data/polls.json`. Absent file (not yet created) or a corrupt one both fall back to the empty default — same try/catch-return-default idiom as loadProjects. */
export function loadPolls(dataDir: string): PollsState {
  const path = pollsFilePath(dataDir);
  if (!existsSync(path)) return { polls: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { polls?: unknown };
    const shaped = Array.isArray(parsed.polls) ? parsed.polls.filter(isPoll) : [];
    // Belt-and-suspenders:
    // createPoll forbids a workshop poll from ever carrying a defaultOptionId,
    // so one present here means a hand-edited/corrupted file. Drop it loudly
    // rather than let it survive a reload and auto-apply on the next sweep —
    // same "drop invalid entries loudly at load" convention as dockApps.ts.
    const polls: Poll[] = [];
    for (const p of shaped) {
      if (p.source === 'workshop' && p.defaultOptionId != null) {
        console.warn(
          `[polls] dropping workshop poll ${p.id} from ${path}: workshop polls must never carry defaultOptionId (never auto-approve) — corrupted/hand-edited state.`
        );
        continue;
      }
      polls.push(p);
    }
    return { polls };
  } catch {
    return { polls: [] };
  }
}

/** Persist the full state. Create-on-first-write, same as projects.json/autoroute.json — not boot-created. */
export function savePolls(dataDir: string, state: PollsState): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(pollsFilePath(dataDir), JSON.stringify(state, null, 2), 'utf8');
}

export interface CreatePollInput {
  roomId: string;
  question: string;
  detail?: string;
  detailSummary?: string;
  recommendation?: string;
  /** `id` is caller-supplied when present (e.g. 'approve'/'reject') so recommendationId/defaultOptionId can reference it directly, per the original design's "must reference a real option id"; auto-generated otherwise. */
  options: Array<{ id?: string; label: string }>;
  recommendationId?: string;
  requestedBy: string;
  expiresAt?: number;
  defaultOptionId?: string;
  source?: 'local' | 'paperclip' | 'workshop';
  externalRef?: { approvalId: string; companyId: string };
  attachments?: PollAttachment[];
  disputeSides?: PollDisputeSide[];
  diffAttachments?: PollDiffAttachment[];
  workshopSnapshot?: WorkshopSnapshot;
}

export type CreatePollResult =
  | { ok: true; state: PollsState; poll: Poll }
  | { ok: false; error: string };

/**
 * Create a poll. `roomId` existence/archived-state is NOT checked here (this
 * module has no `rooms` map — same split as loop.ts's startLoop, which
 * leaves room-membership checks to index.ts's caller). Validated here per
 * the original design: 2..6 options, recommendationId/defaultOptionId (if given)
 * must reference a real option id, requestedBy required/non-empty.
 */
export function createPoll(state: PollsState, input: CreatePollInput): CreatePollResult {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (question.length < 1) return { ok: false, error: 'question is required.' };

  const rawOptions = Array.isArray(input.options) ? input.options : [];
  if (rawOptions.length < 2 || rawOptions.length > 6) {
    return { ok: false, error: 'options must contain between 2 and 6 entries.' };
  }
  const options: PollOption[] = [];
  const seenIds = new Set<string>();
  for (const o of rawOptions) {
    const label = typeof o?.label === 'string' ? o.label.trim() : '';
    if (label.length < 1) return { ok: false, error: 'Every option needs a non-empty label.' };
    const id = typeof o?.id === 'string' && o.id.trim().length > 0 ? o.id.trim() : randomUUID();
    if (seenIds.has(id)) return { ok: false, error: `Duplicate option id: ${id}` };
    seenIds.add(id);
    options.push({ id, label });
  }

  const requestedBy = typeof input.requestedBy === 'string' ? input.requestedBy.trim() : '';
  if (requestedBy.length < 1) return { ok: false, error: 'requestedBy is required.' };

  // SECURITY: pollsRoutes.ts's REST
  // handler only checks `Array.isArray` on `attachments`/`disputeSides`
  // before casting — deep shape (and critically, `kind` being one of the 4
  // literals the type declares) was previously left entirely to the UI's
  // attachmentSrc() allowlist. That allowlist gates url/data SHAPE, not
  // `kind`, so a missing/misnamed `kind` (typo or otherwise) let a
  // `data:image/svg+xml;base64,...` attachment reach PollRichSections.tsx's
  // fallback `<a href>` — which, unlike an `<img>`, executes the embedded
  // script on click. Reuse the module's own (correct, existing)
  // isPollAttachment/isPollDisputeSide validators HERE, at creation time, so
  // a malformed attachment never enters live state at all — not just on a
  // future disk reload (loadPolls already ran these via isPoll).
  if (input.attachments != null && (!Array.isArray(input.attachments) || !input.attachments.every(isPollAttachment))) {
    return { ok: false, error: 'attachments must be an array of valid attachments (kind: image|graph|table|text).' };
  }
  if (
    input.disputeSides != null &&
    (!Array.isArray(input.disputeSides) || !input.disputeSides.every(isPollDisputeSide))
  ) {
    return { ok: false, error: 'disputeSides must be an array of valid dispute sides.' };
  }

  let recommendationId: string | undefined;
  if (input.recommendationId != null) {
    recommendationId = options.some((o) => o.id === input.recommendationId) ? input.recommendationId : undefined;
    if (!recommendationId) return { ok: false, error: 'recommendationId must reference one of the given options.' };
  }
  // Workshop polls must never auto-approve
  // (defaultOptionId is forbidden for them) — checked
  // here, the single choke point every caller (including a future one) goes
  // through, rather than trusting each call site to remember the rule.
  if (input.source === 'workshop' && input.defaultOptionId != null) {
    return { ok: false, error: 'workshop polls must not set defaultOptionId (never auto-approve).' };
  }

  let defaultOptionId: string | undefined;
  if (input.defaultOptionId != null) {
    defaultOptionId = options.some((o) => o.id === input.defaultOptionId) ? input.defaultOptionId : undefined;
    if (!defaultOptionId) return { ok: false, error: 'defaultOptionId must reference one of the given options.' };
  }

  const poll: Poll = {
    id: randomUUID(),
    roomId: input.roomId,
    question,
    detail: input.detail?.trim() || undefined,
    detailSummary: input.detailSummary?.trim() || undefined,
    recommendation: input.recommendation?.trim() || undefined,
    options,
    recommendationId,
    requestedBy,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
    // Snapshot at birth, never mutated again — deferPoll's extension math
    // (correction #2) needs the ORIGINAL duration, not whatever expiresAt
    // has drifted to after prior deferrals.
    originalExpiresAt: input.expiresAt,
    defaultOptionId,
    status: 'open',
    source: input.source ?? 'local',
    externalRef: input.externalRef,
    attachments: input.attachments?.length ? input.attachments : undefined,
    disputeSides: input.disputeSides?.length ? input.disputeSides : undefined,
    diffAttachments: input.diffAttachments,
    workshopSnapshot: input.workshopSnapshot,
  };

  return { ok: true, state: { polls: [...state.polls, poll] }, poll };
}

export type DecideResult =
  | { ok: true; state: PollsState; poll: Poll }
  | { ok: false; error: string };

/**
 * Settle-once decide. Manual-vs-expiry and double-decide races are both
 * resolved first-write-wins: only a poll whose status is STILL 'open' at the
 * moment this runs can be decided — a second caller (a duplicate WS frame, or
 * the expiry sweep firing in the same tick) sees status !== 'open' and gets a
 * clean rejection instead of clobbering the first decision. Callers run
 * single-threaded (Node event loop, no concurrent mutation of the same
 * in-memory PollsState object) so there is no actual data race here, only
 * the ORDERING race between "a manual decide arrives" and "the sweep timer
 * fires" — both funnel through this same settle-once check.
 */
export function decidePoll(
  state: PollsState,
  pollId: string,
  optionId: string,
  decidedBy: string,
  note?: string
): DecideResult {
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx < 0) return { ok: false, error: 'Poll not found.' };
  const existing = state.polls[idx];
  if (existing.status !== 'open') {
    return { ok: false, error: `Poll already ${existing.status}.` };
  }
  if (!existing.options.some((o) => o.id === optionId)) {
    return { ok: false, error: 'optionId does not match any option on this poll.' };
  }
  const decided: Poll = {
    ...existing,
    status: 'decided',
    decision: { optionId, decidedBy, decidedAt: Date.now(), note: note?.trim() || undefined },
  };
  const polls = [...state.polls];
  polls[idx] = decided;
  return { ok: true, state: { polls }, poll: decided };
}

/**
 * Withdraw an open poll (owner-directed, : a human "remove this
 * decision" affordance — the only prior exit from a stale open card was
 * defer, which just re-queues it; the operator tried 4 times to retire one this
 * way before this existed). Settle-once, same first-write-wins guard as
 * decidePoll: only a poll whose status is STILL 'open' at the moment this
 * runs can be withdrawn. Deliberately records NO `decision` (a withdrawn
 * poll was never voted on — that field staying undefined is the signal that
 * distinguishes it from a 'decided' poll for any reader, including
 * pollDecisionLine/notifyPollSettled call sites). Always logs a note message
 * (severity 'note') onto the poll, same messages[] convention as
 * deferPoll/requestPollInfo, so the log shows who/why even though the poll
 * itself is about to leave the open set.
 */
export function withdrawPoll(state: PollsState, pollId: string, note?: string): DecideResult {
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx < 0) return { ok: false, error: 'Poll not found.' };
  const existing = state.polls[idx];
  if (existing.status !== 'open') {
    return { ok: false, error: `Poll already ${existing.status}.` };
  }
  const trimmedNote = note?.trim() || undefined;
  const withdrawn: Poll = {
    ...existing,
    status: 'withdrawn',
    messages: [
      ...(existing.messages ?? []),
      {
        at: Date.now(),
        sender: 'human',
        severity: 'note',
        content: trimmedNote ? `Withdrawn by human: ${trimmedNote}` : 'Withdrawn by human',
      },
    ],
  };
  const polls = [...state.polls];
  polls[idx] = withdrawn;
  return { ok: true, state: { polls }, poll: withdrawn };
}

/**
 * Hard cap on deferrals per poll. Enforced HERE, not just by the UI greying the button
 * out — a stale tab or a replayed WS frame must not be able to defer past
 * the cap just because its local button state was never disabled.
 */
export const MAX_POLL_DEFERRALS = 3;

/**
 * Defer an open poll. Always logs the deferral
 * (`deferrals[]`) and a note message; when the poll HAS an expiry, extends
 * `expiresAt` by the poll's ORIGINAL duration (`originalExpiresAt - createdAt`,
 * snapshotted once at creation) rather than the already-mutated current
 * expiresAt — repeat deferrals compound off the same fixed increment. This
 * replaces the branch's `Date.now() + (expiresAt - Date.now())` formula, which
 * is algebraically a no-op (adds back out exactly what it subtracted) and
 * never actually pushed the deadline. Capped at MAX_POLL_DEFERRALS; a poll
 * with no expiresAt can still be deferred (message-only — nothing to extend).
 */
export function deferPoll(state: PollsState, pollId: string, by: string, note?: string): DecideResult {
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx < 0) return { ok: false, error: 'Poll not found.' };
  const existing = state.polls[idx];
  if (existing.status !== 'open') {
    return { ok: false, error: `Poll already ${existing.status}.` };
  }
  const priorDeferrals = existing.deferrals ?? [];
  if (priorDeferrals.length >= MAX_POLL_DEFERRALS) {
    return { ok: false, error: `Poll already deferred the maximum of ${MAX_POLL_DEFERRALS} times.` };
  }

  const now = Date.now();
  // originalExpiresAt is set at creation (createPoll) and never mutated
  // afterward — a poll created before this field existed falls back to its
  // current expiresAt, matching pre-Wave-6 behavior for old persisted data.
  const originalExpiresAt = existing.originalExpiresAt ?? existing.expiresAt;
  const expiresAt =
    existing.expiresAt != null && originalExpiresAt != null
      ? existing.expiresAt + Math.max(0, originalExpiresAt - existing.createdAt)
      : existing.expiresAt;
  const trimmedNote = note?.trim() || undefined;

  const updated: Poll = {
    ...existing,
    expiresAt,
    originalExpiresAt,
    deferrals: [...priorDeferrals, { at: now, note: trimmedNote }],
    messages: [
      ...(existing.messages ?? []),
      {
        at: now,
        sender: by,
        severity: 'note',
        content: trimmedNote ? `Deferred by ${by}: ${trimmedNote}` : `Deferred by ${by}.`,
      },
    ],
  };
  const polls = [...state.polls];
  polls[idx] = updated;
  return { ok: true, state: { polls }, poll: updated };
}

/**
 * More-info ask: posts a needs-info message onto
 * an open poll. No status change, no decision recorded — the requester-notify
 * side effect (bridge wake, VERIFIED-only) is index.ts/pollsRoutes.ts's job,
 * same split as decidePoll (pure state) vs notifyPollSettled (side effects).
 */
export function requestPollInfo(state: PollsState, pollId: string, by: string, note?: string): DecideResult {
  const idx = state.polls.findIndex((p) => p.id === pollId);
  if (idx < 0) return { ok: false, error: 'Poll not found.' };
  const existing = state.polls[idx];
  if (existing.status !== 'open') {
    return { ok: false, error: `Poll already ${existing.status}.` };
  }
  const trimmedNote = note?.trim() || undefined;
  const updated: Poll = {
    ...existing,
    messages: [
      ...(existing.messages ?? []),
      {
        at: Date.now(),
        sender: by,
        severity: 'needs-info',
        content: trimmedNote ? `More info requested by ${by}: ${trimmedNote}` : `More info requested by ${by}.`,
      },
    ],
  };
  const polls = [...state.polls];
  polls[idx] = updated;
  return { ok: true, state: { polls }, poll: updated };
}

/**
 * Expiry sweep: every OPEN poll whose expiresAt has passed is settled —
 * `defaultOptionId` present -> decided by 'auto-default'; absent -> status
 * 'expired' (no decision). Run from an interval AND once at boot (rehydrate)
 * so a poll that expired while the gateway was down is not left open
 * forever. Pure: returns the new state plus the list of polls that changed,
 * so the caller (index.ts) can broadcast + fire side effects per changed
 * poll without re-diffing itself.
 */
export function sweepExpiredPolls(state: PollsState, now: number = Date.now()): { state: PollsState; changed: Poll[] } {
  const changed: Poll[] = [];
  const polls = state.polls.map((p) => {
    if (p.status !== 'open' || p.expiresAt == null || p.expiresAt > now) return p;
    // Workshop polls must NEVER auto-approve on expiry, even if a corrupted or
    // hand-edited state slipped a defaultOptionId past load-time validation
    //. Expire = reject; a
    // workshop apply only ever runs from an explicit human decide, never a sweep.
    if (p.source === 'workshop') {
      if (p.defaultOptionId != null) {
        console.warn(
          `[polls] workshop poll ${p.id} carried a defaultOptionId at expiry — refusing to auto-approve; expiring instead (corrupted state).`
        );
      }
      const settled: Poll = { ...p, status: 'expired' };
      changed.push(settled);
      return settled;
    }
    const settled: Poll = p.defaultOptionId
      ? {
          ...p,
          status: 'decided',
          decision: { optionId: p.defaultOptionId, decidedBy: 'auto-default', decidedAt: now },
        }
      : { ...p, status: 'expired' };
    changed.push(settled);
    return settled;
  });
  if (changed.length === 0) return { state, changed: [] };
  return { state: { polls }, changed };
}

/**
 * When this poll actually left the open set — the recency key the settled
 * window below sorts by. 'decided' has `decision.decidedAt`; 'withdrawn' has
 * no decision but withdrawPoll() always appends a message at the moment it
 * settles, so the LAST message's `at` is that moment; 'expired' (and any
 * legacy/corrupt poll with neither) falls back to `createdAt`, same as
 * before this function existed. Without this, a poll that sat open a long
 * time before being withdrawn would rank by its (stale) createdAt instead of
 * "just settled" and could fall straight out of the 20-item window on the
 * very sync that should show it — caught live 2026-07-18 verifying the
 * withdraw feature end-to-end (poll 34b2e69e vanished from /api/state
 * instead of showing status:'withdrawn').
 */
function settledAt(p: Poll): number {
  if (p.decision) return p.decision.decidedAt;
  if (p.status === 'withdrawn') return p.messages?.[p.messages.length - 1]?.at ?? p.createdAt;
  return p.createdAt;
}

/**
 * Hydration slice for state.sync's additive `polls` field (E-lite/projects
 * precedent): every OPEN poll (any room, newest first) plus the most recent
 * 20 DECIDED/EXPIRED/WITHDRAWN polls — enough history for the rail without
 * unbounded growth on a long-lived gateway. The `p.status !== 'open'` filter
 * below buckets 'withdrawn' into this settled window (it leaves the
 * Approvals inbox the same tick it withdraws) — sorted by settledAt (above),
 * not raw createdAt, so a long-open poll that just settled still ranks as
 * recent.
 */
export function pollsForStateSync(state: PollsState): Poll[] {
  const open = state.polls.filter((p) => p.status === 'open').sort((a, b) => b.createdAt - a.createdAt);
  const settled = state.polls
    .filter((p) => p.status !== 'open')
    .sort((a, b) => settledAt(b) - settledAt(a))
    .slice(0, 20);
  return [...open, ...settled];
}

export function findPoll(state: PollsState, pollId: string): Poll | undefined {
  return state.polls.find((p) => p.id === pollId);
}

/** True if a poll's externalRef.approvalId is already present in state — de-dupe guard for the Paperclip poller. */
export function hasApprovalRef(state: PollsState, approvalId: string): boolean {
  return state.polls.some((p) => p.externalRef?.approvalId === approvalId);
}
