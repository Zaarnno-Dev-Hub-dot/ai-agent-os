import type { PollReview } from '@agent-os/shared';
import type { Poll, PollAttachment } from '../store/gatewayStore';
import { isActionCovered, type ReviewPolicyMode } from './reviewPolicy';

/**
 * Presentation helpers for the Approvals Inbox rich card (Wave 6,
 * docs/DESIGN-approvals-app-v2.md). Pure functions only — no store reads, no
 * DOM — so they're plain-unit-testable without React or a live gatewayStore.
 */

/**
 * `[CRITICAL]` is a hand-typed convention (Team toolbox's
 * Park-Approvals-Card.ps1 prefixes it on questions it wants to survive
 * age-based cleanup) — matched trimmed/case-insensitive since it's
 * hand-typed, and exported so PollCard can render a real badge instead of
 * leaving the raw text sitting in the question sentence.
 */
const CRITICAL_PREFIX = /^\[critical\]\s*/i;

export function isCriticalPoll(poll: Poll): boolean {
  return CRITICAL_PREFIX.test(poll.question.trim());
}

/** Question text with a leading `[CRITICAL]` marker removed — call once the badge is rendered separately, so a critical poll doesn't say CRITICAL twice. */
export function stripCriticalPrefix(question: string): string {
  return question.trim().replace(CRITICAL_PREFIX, '').trim();
}

/** Plain-language summary lines for the inbox card (WHAT / WHY). */
export function pollSummaryLines(poll: Poll): { what: string; why?: string } {
  const what = stripCriticalPrefix(poll.question);
  const why = poll.detailSummary?.trim() || (typeof poll.detail === 'string' ? poll.detail.trim() : undefined);
  return { what, why: why || undefined };
}

export function pollRecommendationText(poll: Poll): string | undefined {
  if (poll.recommendation?.trim()) return poll.recommendation.trim();
  const rec = poll.recommendationId ? poll.options.find((o) => o.id === poll.recommendationId)?.label : undefined;
  return rec?.trim() || undefined;
}

export function pollAttachments(poll: Poll): PollAttachment[] {
  return poll.attachments ?? [];
}

/** Approve/Reject option ids for the inbox's fixed four-button row — matches by caller-supplied id first, falling back to an exact (case-insensitive) label match so a poll built with generated ids still maps its first two options. */
export function resolveApproveRejectOptionIds(poll: Poll): { approveId?: string; rejectId?: string } {
  const byId = (id: string) => poll.options.find((o) => o.id === id)?.id;
  const byLabel = (re: RegExp) => poll.options.find((o) => re.test(o.label))?.id;
  return {
    approveId: byId('approve') ?? byLabel(/^approve$/i),
    rejectId: byId('reject') ?? byLabel(/^reject$/i),
  };
}

/** Open polls oldest-first for the single-card inbox default (design doc §5: "oldest open poll first"). */
export function openPollsOldestFirst(polls: Poll[]): Poll[] {
  return polls.filter((p) => p.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * When a settled (non-open) poll actually left the open set — mirrors
 * gateway's polls.ts settledAt() byte-for-byte (gateway is a Node/fs-
 * importing package the browser bundle can't pull in — same reason
 * ReviewPolicyMode/isActionCovered/MAX_POLL_DEFERRALS are already mirrored
 * here rather than imported, see reviewPolicy.ts's own doc comment). 'decided'
 * has decision.decidedAt; 'withdrawn' has no decision but withdrawPoll()
 * always appends a message at the moment it settles, so the LAST message's
 * `at` is that moment; anything else (expired, or a legacy/corrupt poll with
 * neither) falls back to createdAt. Without this, a poll that sat open a
 * long time before being withdrawn sorts by its (stale) createdAt in the
 * History list and displays as if it settled ages ago — caught live
 * 2026-07-18 alongside the same bug in the gateway's own pollsForStateSync.
 */
export function pollSettledAt(poll: Poll): number {
  if (poll.decision) return poll.decision.decidedAt;
  if (poll.status === 'withdrawn') return poll.messages?.[poll.messages.length - 1]?.at ?? poll.createdAt;
  return poll.createdAt;
}

// --- attachmentSrc: the security boundary (design doc correction #1, MUSTFIX) ---
//
// A poll's attachments come from whoever calls POST /api/polls — any local
// script or agent, not just this dashboard's own code. The race branch's
// attachmentSrc() returned `att.url` (and any `att.data` that merely started
// with "data:" or "http") VERBATIM into `<img src>` / `<a href>`, so a
// `javascript:`, `file:`, `vbscript:`, `blob:`, or arbitrary external-http
// attachment url rendered (or navigated to) unchanged — the textbook
// stored-XSS/URL-scheme shape. Allowlist ONLY:
//   - `kind` is 'image' or 'graph' (checked FIRST, independent of url/data —
//     see the reopened gap below)
//   - AND `data:image/<subtype>;base64,...` (any image subtype)
//   - OR loopback `http(s)://127.0.0.1|localhost|::1[:port]/...`
// Everything else resolves to `undefined` — callers render the caption plus
// a "blocked source" note instead of a broken/dangerous element.
//
// REOPENED GAP (fixed here): this allowlist originally checked url/data SHAPE
// only, never `kind`. `kind` is caller-supplied (gateway now validates it's
// one of the 4 literals at POST /api/polls time — see polls.ts's
// isPollAttachment — but this function must not depend on that holding for
// EVERY caller/every era of persisted data). Without the `kind` gate, an
// attachment with a missing/misnamed `kind` (a typo, e.g. `'screenshot'`) but
// a `data:image/svg+xml;base64,...` url/data still passed the shape allowlist
// and reached PollRichSections.tsx's fallback `<a href>` — which, unlike an
// `<img src>`, DOES execute an embedded `<script>` on click (top-level
// navigation to a data: URI runs it as a document, not an inert image).
// Gating on `kind` here, not just in the one caller that happens to matter
// today, is what makes this "the ONLY place url/data may become a DOM sink"
// (gatewayStore.ts's own description of this function) actually true.

const DATA_IMAGE_URI_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
/** Bare base64 payload (no scheme prefix) — used for the "kind is image/graph and .data is raw base64" fallback, where THIS module constructs the data: URI itself rather than trusting a caller-supplied one. */
const BARE_BASE64_RE = /^[a-z0-9+/]+=*$/i;

/**
 * True if `raw` is an `http`/`https` URL whose host is 127.0.0.1, localhost,
 * or ::1 — same allowlist shape as the gateway's dockApps.ts's isLoopbackUrl,
 * but ALSO checks the scheme explicitly (a non-special scheme like
 * `javascript://127.0.0.1/` can still parse a loopback-looking "host" per the
 * WHATWG URL spec's generic authority parsing — checking protocol first
 * closes that gap rather than trusting hostname alone).
 */
function isLoopbackHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** True if `raw` is a `data:image/*;base64,...` URI. Deliberately does NOT special-case `svg+xml` — the only sink this can reach is `<img src>` for a `kind: 'image' | 'graph'` attachment (attachmentSrc's own kind-gate below enforces that; AttachmentTile in PollRichSections.tsx never wires this function's output into an `<a href>`, `<iframe>`, or `<object>`), and images loaded via `<img>` never execute embedded scripts regardless of subtype. If this function's output is ever wired into a sink other than `<img src>`, revisit both that exclusion AND the kind-gate below first. */
function isAllowedImageDataUri(raw: string): boolean {
  return DATA_IMAGE_URI_RE.test(raw);
}

/**
 * Resolve a poll attachment's renderable source, or `undefined` if it isn't
 * on the allowlist (caller renders caption + "blocked source" instead).
 * `url` and `data` are both attacker-reachable (see module doc above) and are
 * checked with the SAME allowlist — neither is "more trusted" than the other.
 * `kind` is checked FIRST and independently: only 'image'/'graph' ever
 * resolve to anything (design doc correction #1, reopened — see module doc).
 */
export function attachmentSrc(att: PollAttachment): string | undefined {
  if (att.kind !== 'image' && att.kind !== 'graph') return undefined;
  if (typeof att.url === 'string') {
    return isLoopbackHttpUrl(att.url) || isAllowedImageDataUri(att.url) ? att.url : undefined;
  }
  if (typeof att.data === 'string') {
    if (isAllowedImageDataUri(att.data) || isLoopbackHttpUrl(att.data)) return att.data;
    // Bare base64 payload with no scheme prefix at all — safe to wrap
    // ourselves — we control the "data:image/png;base64," prefix, so the
    // result can only ever decode as PNG bytes (or fail to decode), never
    // re-interpret as markup/script. (kind is already image/graph per the
    // guard above — that's what makes constructing this src safe here.)
    if (BARE_BASE64_RE.test(att.data)) {
      return `data:image/png;base64,${att.data}`;
    }
    return undefined;
  }
  return undefined;
}

/**
 * AttachmentTile's exact render dispatch (PollRichSections.tsx), pulled out
 * as a pure function so the security-relevant decision — which of the three
 * branches an attachment resolves to, and whether a link is ever eligible —
 * is itself unit-tested here rather than living untested inline in JSX
 * (design doc correction #1, reopened: the previous gap shipped because
 * attachmentSrc() had 28 tests and the component that actually renders its
 * output had none). 'table'/'text' render `.data` as inert text directly
 * (never through attachmentSrc); 'image'/'graph' resolve through
 * attachmentSrc's allowlist; anything else — a blocked visual, or a kind
 * outside the 4 the type declares (missing, a typo, or data older than
 * polls.ts's isPollAttachment enforcement at creation time) — is `blocked`
 * and NEVER carries a link, regardless of what attachmentSrc() would have
 * returned for a different kind value.
 */
export type AttachmentView =
  | { view: 'plain-text'; body: string }
  | { view: 'visual'; src: string }
  | { view: 'blocked'; hasSource: boolean };

export function resolveAttachmentView(att: PollAttachment): AttachmentView {
  if (att.kind === 'table' || att.kind === 'text') {
    return { view: 'plain-text', body: att.data ?? '' };
  }
  const src = attachmentSrc(att);
  if (src) return { view: 'visual', src };
  return { view: 'blocked', hasSource: Boolean(att.url || att.data) };
}

// ============================================================================
// Two-Reviewer Policy (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md).
// PollReview lives in @agent-os/shared (the one named exception to the
// frozen-file rule — see types.ts's own doc comment); the DISPLAY logic
// here is gateway/UI-local, same split as everything else in this file.
// ============================================================================

/**
 * A review chip's display bucket — collapses PollReview's
 * status/parseOk/verdict fields into ONE thing the chip renders. The
 * `unparseable` bucket is DISTINCT from every verdict value and is never
 * reachable from a parse failure coercing to 'approve' (design doc F/B3):
 * `verdict` only ever flows through here when `parseOk` is true.
 */
export type ReviewChipStatus = 'pending' | 'approve' | 'concerns' | 'reject' | 'unparseable' | 'timed-out';

export function reviewChipStatus(review: PollReview): ReviewChipStatus {
  if (review.status === 'pending') return 'pending';
  if (review.status === 'timed-out' || review.status === 'substituted') return 'timed-out';
  // status === 'attached': a reply arrived. Strict — anything that didn't
  // parse (parseOk false) OR somehow carries no verdict renders unparseable,
  // never a guessed/default verdict.
  if (!review.parseOk || review.verdict == null) return 'unparseable';
  return review.verdict;
}

/** Human label for a chip, independent of color/styling (used for title="" tooltips and tests). */
export function reviewChipLabel(status: ReviewChipStatus): string {
  switch (status) {
    case 'pending':
      return 'awaiting reply';
    case 'timed-out':
      return 'reviewer timed out';
    case 'unparseable':
      return 'unparseable';
    case 'approve':
      return 'approve';
    case 'concerns':
      return 'concerns';
    case 'reject':
      return 'reject';
  }
}

/**
 * Per-slot "currently active" review row — the row with the LARGEST
 * `wakeAt` in each slot. A T+4 substitute always has a strictly later
 * wakeAt than the original it replaced, so this naturally surfaces the
 * substitute once one exists, and the original otherwise — without either
 * side needing to know about the other. Sorted by slot (1, then 2) for a
 * stable render order.
 */
export function activeReviewsPerSlot(reviews: PollReview[]): PollReview[] {
  const bySlot = new Map<number, PollReview>();
  for (const r of reviews) {
    const existing = bySlot.get(r.slot);
    if (!existing || r.wakeAt > existing.wakeAt) bySlot.set(r.slot, r);
  }
  return Array.from(bySlot.values()).sort((a, b) => a.slot - b.slot);
}

export function hasAnyAttachedReview(reviews: PollReview[]): boolean {
  return reviews.some((r) => r.status === 'attached');
}

/**
 * Zero-verdict soft-confirm gate (design doc "Soft speed-bump" — "when a
 * COVERED card has ZERO attached verdicts"): true only for a workshop poll
 * whose action type (`workshop-propose`) is CURRENTLY covered under
 * `reviewPolicyMode` — via `isActionCovered`, not `source` alone — with
 * zero attached verdicts. `source === 'workshop'` is necessary but NOT
 * sufficient: workshopRoutes.ts hard-codes `source: 'workshop'` regardless
 * of `review_policy`, so a poll can be a workshop poll while its action type
 * is uncovered (`review_policy: 'off'`) — reviews are never even created in
 * that mode, so `hasAnyAttachedReview` would always be false and this would
 * fire forever without the coverage check (fixed in the M3 fix cycle,
 * 2026-07-09). A poll that was never subject to review at all (a plain
 * local/paperclip poll, OR a workshop poll that is currently uncovered)
 * never shows this friction — there is nothing to be missing. No typed
 * friction anywhere (design doc): this only decides WHETHER to show a
 * one-click inline confirm, never blocks the decide.
 */
export function needsZeroVerdictConfirm(poll: Poll, reviews: PollReview[], reviewPolicyMode: ReviewPolicyMode): boolean {
  if (poll.source !== 'workshop') return false;
  if (!isActionCovered(reviewPolicyMode, 'workshop-propose')) return false;
  return !hasAnyAttachedReview(reviews);
}
