import type { PollReview } from '@agent-os/shared';

/**
 * Two-Reviewer Policy client helpers. REST calls to the gateway-local
 * routes pollReviews.ts registers — same GATEWAY_ORIGIN convention as
 * lib/attachments.ts's uploadFile.
 */

import { gatewayHttpOrigin } from './gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

/**
 * humanToken: injected ONLY into the served index.html by
 * the gateway (index.ts's servedIndexHtml) — never fetched from an API
 * route. Undefined in the Vite dev server (which serves its own raw
 * index.html, not the gateway's) — a KNOWN, accepted gap: dev-mode poll.decide/
 * agent.disconnect/policy-toggle will be rejected the same way a stale/
 * offline token would be. The production build (served BY the gateway) is
 * unaffected.
 */
export function getHumanToken(): string | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { __AGENT_OS_HUMAN_TOKEN__?: string }).__AGENT_OS_HUMAN_TOKEN__
    : undefined;
}

export type ReviewPolicyMode = 'off' | 'mutations' | 'all';

// ============================================================================
// Coverage — mirrors packages/gateway/src/reviewPolicy.ts's `isActionCovered`
// byte-for-byte (same three-mode truth table, see that file's gateway
// reviewPolicy.test.ts `describe('isActionCovered', ...)` block). Duplicated
// here rather than imported: gateway is a Node/fs-importing package the
// browser bundle can't pull in — same reason `ReviewPolicyMode` itself is
// already duplicated in this file and in gatewayStore.ts, and why
// `MAX_POLL_DEFERRALS` is mirrored as a comment in PollCard.tsx.
//
// Added in the M3 fix cycle (2026-07-09): `needsZeroVerdictConfirm`
// (pollPresent.ts) originally checked `poll.source === 'workshop'` alone and
// never consulted the policy mode. Every workshop poll always has
// `source === 'workshop'` regardless of `review_policy` (workshopRoutes.ts
// hard-codes it), so setting review_policy to 'off' never silenced the
// zero-verdict confirm — it fired forever, on every workshop-poll decide,
// even though 'off' means the action was never actually covered. "Covered"
// can only be answered by combining `source` with the current mode via this
// function, never by `source` alone.
// ============================================================================

export type CoveredActionType = 'workshop-propose' | 'seat-attachment-or-diff';

export function isActionCovered(mode: ReviewPolicyMode, actionType: CoveredActionType): boolean {
  if (mode === 'off') return false;
  if (mode === 'mutations') return actionType === 'workshop-propose';
  return true; // 'all': every covered type, mutations included
}

export type SetReviewPolicyResult = { ok: true; mode: ReviewPolicyMode } | { ok: false; error: string };

/** POST /api/review-policy — humanToken-gated (pollReviews.ts's registerPollReviewRoutes). */
export async function setReviewPolicyMode(mode: ReviewPolicyMode): Promise<SetReviewPolicyResult> {
  try {
    const res = await fetch(`${GATEWAY_ORIGIN}/api/review-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, humanToken: getHumanToken() }),
    });
    const json = (await res.json().catch(() => ({}))) as { mode?: ReviewPolicyMode; error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true, mode: json.mode ?? mode };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * POST /api/poll-reviews/:reviewId/findings/:idx — the per-finding valid/
 * invalid/unmark 3-state toggle, NOT humanToken-gated (loopback trust, same as every other
 * non-decide poll mutation). The gateway broadcasts `poll.review.updated`
 * on success, which is what actually updates the store — this function's
 * return value is only used to detect failure; callers do not need to
 * apply its payload themselves.
 */
export async function setFindingValidity(reviewId: string, idx: number, valid: boolean | null): Promise<PollReview | undefined> {
  try {
    const res = await fetch(`${GATEWAY_ORIGIN}/api/poll-reviews/${encodeURIComponent(reviewId)}/findings/${idx}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid }),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as PollReview;
  } catch {
    return undefined;
  }
}
