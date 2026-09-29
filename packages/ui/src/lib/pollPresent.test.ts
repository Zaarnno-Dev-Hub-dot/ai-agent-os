import { describe, expect, it } from 'vitest';
import type { PollReview } from '@agent-os/shared';
import type { Poll, PollAttachment } from '../store/gatewayStore';
import {
  activeReviewsPerSlot,
  attachmentSrc,
  hasAnyAttachedReview,
  needsZeroVerdictConfirm,
  openPollsOldestFirst,
  pollAttachments,
  pollRecommendationText,
  pollSettledAt,
  pollSummaryLines,
  resolveApproveRejectOptionIds,
  resolveAttachmentView,
  reviewChipLabel,
  reviewChipStatus,
} from './pollPresent';

function basePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 'poll-1',
    roomId: 'room-1',
    question: 'Ship it?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    requestedBy: 'hermes',
    createdAt: Date.now(),
    status: 'open',
    source: 'local',
    ...overrides,
  };
}

function att(overrides: Partial<PollAttachment> = {}): PollAttachment {
  return { kind: 'image', ...overrides };
}

/**
 * Build an attachment the way real wire data (a POST /api/polls body, a
 * state.sync WS payload, JSON.parse'd disk state) actually arrives: NOT
 * checked against PollAttachment's `kind` union at compile time. `att()`
 * above can't express this — its `overrides: Partial<PollAttachment>` is
 * still union-constrained, so it can't express a missing/misnamed `kind`.
 * That exact gap (kind lies, or is absent, at runtime even though the type
 * says it can't be) is what the reopened MUSTFIX below is about.
 */
function hostileAtt(raw: Record<string, unknown>): PollAttachment {
  return raw as unknown as PollAttachment;
}

describe('attachmentSrc — security allowlist (docs/DESIGN-approvals-app-v2.md correction #1, MUSTFIX)', () => {
  it('blocks a javascript: URL in .url', () => {
    expect(attachmentSrc(att({ url: 'javascript:alert(1)' }))).toBeUndefined();
  });

  it('blocks a javascript: URL disguised with a loopback-looking authority', () => {
    // `javascript://127.0.0.1/%0aalert(1)` — some URL parsers only check the
    // hostname substring; this must fail on protocol, not hostname.
    expect(attachmentSrc(att({ url: 'javascript://127.0.0.1/%0aalert(1)//' }))).toBeUndefined();
  });

  it('blocks a vbscript: URL', () => {
    expect(attachmentSrc(att({ url: 'vbscript:msgbox(1)' }))).toBeUndefined();
  });

  it('blocks a file: URL', () => {
    expect(attachmentSrc(att({ url: 'file:///etc/passwd' }))).toBeUndefined();
  });

  it('blocks a blob: URL', () => {
    expect(attachmentSrc(att({ url: 'blob:http://evil.example.com/uuid' }))).toBeUndefined();
  });

  it('blocks an external http(s) URL', () => {
    expect(attachmentSrc(att({ url: 'https://evil.example.com/x.png' }))).toBeUndefined();
    expect(attachmentSrc(att({ url: 'http://attacker.example.com/x.png' }))).toBeUndefined();
  });

  it('blocks a host that merely starts with the loopback string (bypass attempt)', () => {
    expect(attachmentSrc(att({ url: 'http://127.0.0.1.evil.example.com/x.png' }))).toBeUndefined();
    expect(attachmentSrc(att({ url: 'http://localhost.evil.example.com/x.png' }))).toBeUndefined();
  });

  it('blocks a userinfo bypass attempt (loopback text before an "@", real host after)', () => {
    expect(attachmentSrc(att({ url: 'http://127.0.0.1@evil.example.com/x.png' }))).toBeUndefined();
  });

  it('blocks an unparseable URL', () => {
    expect(attachmentSrc(att({ url: 'not a url at all' }))).toBeUndefined();
  });

  it('blocks a non-image data: URI (e.g. text/html — could carry a script)', () => {
    expect(attachmentSrc(att({ url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }))).toBeUndefined();
  });

  it('allows a data:image/* URI', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    expect(attachmentSrc(att({ url: uri }))).toBe(uri);
    expect(attachmentSrc(att({ data: uri }))).toBe(uri);
  });

  it('allows loopback http(s) URLs (127.0.0.1, localhost, ::1), any port or path', () => {
    expect(attachmentSrc(att({ url: 'http://127.0.0.1:4110/api/attachments/x.png' }))).toBe(
      'http://127.0.0.1:4110/api/attachments/x.png'
    );
    expect(attachmentSrc(att({ url: 'http://localhost:4110/x.png' }))).toBe('http://localhost:4110/x.png');
    expect(attachmentSrc(att({ url: 'https://127.0.0.1/x.png' }))).toBe('https://127.0.0.1/x.png');
  });

  it('checks .data with the SAME allowlist as .url when .url is absent', () => {
    expect(attachmentSrc(att({ data: 'javascript:alert(1)' }))).toBeUndefined();
    expect(attachmentSrc(att({ data: 'https://evil.example.com/x.png' }))).toBeUndefined();
    expect(attachmentSrc(att({ data: 'http://127.0.0.1:4110/x.png' }))).toBe('http://127.0.0.1:4110/x.png');
  });

  it('wraps a bare base64 payload (no scheme) as a self-constructed data:image/png URI for image/graph kinds', () => {
    const bare = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    expect(attachmentSrc(att({ kind: 'image', data: bare }))).toBe(`data:image/png;base64,${bare}`);
    expect(attachmentSrc(att({ kind: 'graph', data: bare }))).toBe(`data:image/png;base64,${bare}`);
  });

  it('does NOT wrap a bare-looking payload for table/text kinds — those render as plain text, never a src', () => {
    const bare = 'aGVsbG8gd29ybGQ';
    expect(attachmentSrc(att({ kind: 'table', data: bare }))).toBeUndefined();
    expect(attachmentSrc(att({ kind: 'text', data: bare }))).toBeUndefined();
  });

  it('returns undefined when neither url nor data is present', () => {
    expect(attachmentSrc(att({}))).toBeUndefined();
  });

  it('does not fall back to .data when .url is present but blocked (no silent downgrade to a different field)', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    expect(attachmentSrc(att({ url: 'javascript:alert(1)', data: uri }))).toBeUndefined();
  });
});

describe('attachmentSrc — kind gate (docs/DESIGN-approvals-app-v2.md correction #1, REOPENED)', () => {
  // The reopened gap: attachmentSrc's allowlist checked url/data SHAPE only,
  // never `kind` — so a `data:image/svg+xml;base64,...` payload (which DOES
  // match the "allowed image data URI" shape; the regex never excludes
  // svg+xml) resolved to a truthy src for ANY kind, including a missing or
  // non-canonical one. That src reached PollRichSections.tsx's fallback
  // `<a href>`, and unlike `<img src>`, a direct/top-level navigation to a
  // data:image/svg+xml URI DOES execute the embedded <script>.
  const svgScript = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoZG9jdW1lbnQuZG9tYWluKTwvc2NyaXB0Pjwvc3ZnPg==';

  it('blocks an allowlisted-shape data:image/svg+xml URI when kind is missing entirely', () => {
    expect(attachmentSrc(hostileAtt({ url: svgScript, caption: 'View screenshot' }))).toBeUndefined();
  });

  it('blocks the same payload when kind is a non-canonical string (e.g. a typo)', () => {
    expect(attachmentSrc(hostileAtt({ kind: 'screenshot', url: svgScript, caption: 'View screenshot' }))).toBeUndefined();
  });

  it('blocks an otherwise-fully-allowed loopback URL when kind is table/text — those never resolve a src at all', () => {
    expect(attachmentSrc(att({ kind: 'table', url: 'http://127.0.0.1:4110/x.png' }))).toBeUndefined();
    expect(attachmentSrc(att({ kind: 'text', url: 'data:image/png;base64,iVBORw0KGgo=' }))).toBeUndefined();
  });

  it('still allows the same svg+xml data URI for the correct kind (image/graph) — the fix gates on kind, it does not additionally ban svg', () => {
    expect(attachmentSrc(att({ kind: 'image', url: svgScript }))).toBe(svgScript);
    expect(attachmentSrc(att({ kind: 'graph', url: svgScript }))).toBe(svgScript);
  });
});

describe("resolveAttachmentView — AttachmentTile's render dispatch (docs/DESIGN-approvals-app-v2.md correction #1, REOPENED)", () => {
  it('table/text kinds resolve to plain-text with the raw body, never touching attachmentSrc', () => {
    expect(resolveAttachmentView(att({ kind: 'table', data: 'a,b\n1,2' }))).toEqual({ view: 'plain-text', body: 'a,b\n1,2' });
    expect(resolveAttachmentView(att({ kind: 'text' }))).toEqual({ view: 'plain-text', body: '' });
  });

  it('image/graph with an allowlisted src resolves to visual', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    expect(resolveAttachmentView(att({ kind: 'image', url: uri }))).toEqual({ view: 'visual', src: uri });
  });

  it('image/graph with a blocked url resolves to blocked, hasSource true', () => {
    expect(resolveAttachmentView(att({ kind: 'graph', url: 'javascript:alert(1)' }))).toEqual({
      view: 'blocked',
      hasSource: true,
    });
  });

  it('no url/data at all resolves to blocked, hasSource false', () => {
    expect(resolveAttachmentView(att({}))).toEqual({ view: 'blocked', hasSource: false });
  });

  it('REGRESSION: a data:image/svg+xml attachment with a missing or non-canonical kind resolves to blocked, NEVER visual — the exact PoC from the reopened finding', () => {
    const svgScript = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoZG9jdW1lbnQuZG9tYWluKTwvc2NyaXB0Pjwvc3ZnPg==';

    const missingKind = resolveAttachmentView(hostileAtt({ url: svgScript, caption: 'View screenshot' }));
    expect(missingKind).toEqual({ view: 'blocked', hasSource: true });

    const wrongKind = resolveAttachmentView(hostileAtt({ kind: 'screenshot', url: svgScript, caption: 'View screenshot' }));
    expect(wrongKind).toEqual({ view: 'blocked', hasSource: true });
  });
});

describe('pollSummaryLines', () => {
  it('prefers detailSummary over detail for "why"', () => {
    const poll = basePoll({ detail: 'legacy detail', detailSummary: 'the rich summary' });
    expect(pollSummaryLines(poll)).toEqual({ what: 'Ship it?', why: 'the rich summary' });
  });

  it('falls back to detail when detailSummary is absent (v1 wire-compat)', () => {
    const poll = basePoll({ detail: 'legacy detail' });
    expect(pollSummaryLines(poll)).toEqual({ what: 'Ship it?', why: 'legacy detail' });
  });

  it('has no "why" when neither field is present', () => {
    const poll = basePoll();
    expect(pollSummaryLines(poll)).toEqual({ what: 'Ship it?', why: undefined });
  });
});

describe('pollRecommendationText', () => {
  it('prefers the explicit recommendation string', () => {
    const poll = basePoll({ recommendation: 'Go with approve', recommendationId: 'approve' });
    expect(pollRecommendationText(poll)).toBe('Go with approve');
  });

  it('falls back to the recommended option label', () => {
    const poll = basePoll({ recommendationId: 'approve' });
    expect(pollRecommendationText(poll)).toBe('Approve');
  });

  it('is undefined when neither is present', () => {
    expect(pollRecommendationText(basePoll())).toBeUndefined();
  });
});

describe('pollAttachments', () => {
  it('returns the attachments array, or empty when absent', () => {
    expect(pollAttachments(basePoll())).toEqual([]);
    const attachments = [att({ caption: 'a' })];
    expect(pollAttachments(basePoll({ attachments }))).toBe(attachments);
  });
});

describe('resolveApproveRejectOptionIds', () => {
  it('matches by caller-supplied id "approve"/"reject"', () => {
    expect(resolveApproveRejectOptionIds(basePoll())).toEqual({ approveId: 'approve', rejectId: 'reject' });
  });

  it('falls back to a case-insensitive exact label match when ids differ', () => {
    const poll = basePoll({
      options: [
        { id: 'opt-a', label: 'approve' },
        { id: 'opt-b', label: 'Reject' },
      ],
    });
    expect(resolveApproveRejectOptionIds(poll)).toEqual({ approveId: 'opt-a', rejectId: 'opt-b' });
  });

  it('is undefined for a poll with unrelated option labels', () => {
    const poll = basePoll({ options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] });
    expect(resolveApproveRejectOptionIds(poll)).toEqual({ approveId: undefined, rejectId: undefined });
  });
});

describe('openPollsOldestFirst', () => {
  it('filters to open polls only, sorted oldest first', () => {
    const polls: Poll[] = [
      basePoll({ id: 'a', createdAt: 300, status: 'open' }),
      basePoll({ id: 'b', createdAt: 100, status: 'open' }),
      basePoll({ id: 'c', createdAt: 200, status: 'decided' }),
    ];
    expect(openPollsOldestFirst(polls).map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('pollSettledAt (2026-07-18, mirrors gateway polls.ts byte-for-byte)', () => {
  it('uses decision.decidedAt for a decided poll', () => {
    const poll = basePoll({ status: 'decided', createdAt: 100, decision: { optionId: 'approve', decidedBy: 'human', decidedAt: 999 } });
    expect(pollSettledAt(poll)).toBe(999);
  });

  it("uses the LAST message's `at` for a withdrawn poll, not its (possibly stale) createdAt", () => {
    const poll = basePoll({
      status: 'withdrawn',
      createdAt: 100,
      messages: [
        { at: 500, severity: 'note', content: 'Deferred by human.' },
        { at: 900, severity: 'note', content: 'Withdrawn by human: old' },
      ],
    });
    expect(pollSettledAt(poll)).toBe(900);
  });

  it('falls back to createdAt for a withdrawn poll with no messages (defensive)', () => {
    const poll = basePoll({ status: 'withdrawn', createdAt: 123 });
    expect(pollSettledAt(poll)).toBe(123);
  });

  it('falls back to createdAt for an expired poll (no decision, not withdrawn)', () => {
    const poll = basePoll({ status: 'expired', createdAt: 456 });
    expect(pollSettledAt(poll)).toBe(456);
  });
});

// ============================================================================
// Two-Reviewer Policy
// ============================================================================

function baseReview(overrides: Partial<PollReview> = {}): PollReview {
  return {
    id: 'r1',
    pollId: 'poll-1',
    seatId: 'ollama',
    family: 'homebrew',
    slot: 1,
    poolSizeAtSelection: 2,
    policyMode: 'mutations',
    wakeAt: 1000,
    status: 'pending',
    parseOk: false,
    ...overrides,
  };
}

describe('reviewChipStatus / reviewChipLabel', () => {
  it('pending -> "pending"', () => {
    expect(reviewChipStatus(baseReview({ status: 'pending' }))).toBe('pending');
  });

  it('timed-out and substituted both -> "timed-out"', () => {
    expect(reviewChipStatus(baseReview({ status: 'timed-out' }))).toBe('timed-out');
    expect(reviewChipStatus(baseReview({ status: 'substituted' }))).toBe('timed-out');
  });

  it('attached + parseOk + a verdict -> that verdict', () => {
    expect(reviewChipStatus(baseReview({ status: 'attached', parseOk: true, verdict: 'approve' }))).toBe('approve');
    expect(reviewChipStatus(baseReview({ status: 'attached', parseOk: true, verdict: 'concerns' }))).toBe('concerns');
    expect(reviewChipStatus(baseReview({ status: 'attached', parseOk: true, verdict: 'reject' }))).toBe('reject');
  });

  it('attached but parseOk=false -> "unparseable", NEVER a verdict value even if one is somehow present', () => {
    expect(reviewChipStatus(baseReview({ status: 'attached', parseOk: false }))).toBe('unparseable');
    // Defense in depth: even a stray verdict value alongside parseOk=false
    // must not leak through as a real verdict — parseOk is the ONLY gate.
    expect(reviewChipStatus(baseReview({ status: 'attached', parseOk: false, verdict: 'approve' }))).toBe('unparseable');
  });

  it('attached + parseOk true but no verdict -> "unparseable" (defensive; should not happen from the gateway, but never silently renders nothing)', () => {
    expect(reviewChipStatus(baseReview({ status: 'attached', parseOk: true, verdict: undefined }))).toBe('unparseable');
  });

  it('reviewChipLabel has a distinct, non-empty label for every status', () => {
    const statuses = ['pending', 'approve', 'concerns', 'reject', 'unparseable', 'timed-out'] as const;
    const labels = statuses.map(reviewChipLabel);
    expect(new Set(labels).size).toBe(statuses.length); // all distinct
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });
});

describe('activeReviewsPerSlot', () => {
  it('returns one row per slot, sorted by slot', () => {
    const reviews = [baseReview({ id: 'r2', slot: 2, wakeAt: 10 }), baseReview({ id: 'r1', slot: 1, wakeAt: 10 })];
    expect(activeReviewsPerSlot(reviews).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('prefers the LATEST wakeAt within a slot — a T+4 substitute (later wakeAt) replaces its original in the display', () => {
    const original = baseReview({ id: 'orig', slot: 1, wakeAt: 1000, status: 'substituted' });
    const substitute = baseReview({ id: 'sub', slot: 1, wakeAt: 5000, status: 'pending', substituteForReviewId: 'orig' });
    expect(activeReviewsPerSlot([original, substitute]).map((r) => r.id)).toEqual(['sub']);
    // Order in the input array must not matter.
    expect(activeReviewsPerSlot([substitute, original]).map((r) => r.id)).toEqual(['sub']);
  });

  it('empty input -> empty output', () => {
    expect(activeReviewsPerSlot([])).toEqual([]);
  });
});

describe('hasAnyAttachedReview / needsZeroVerdictConfirm', () => {
  it('hasAnyAttachedReview is true only when at least one row is attached', () => {
    expect(hasAnyAttachedReview([])).toBe(false);
    expect(hasAnyAttachedReview([baseReview({ status: 'pending' })])).toBe(false);
    expect(hasAnyAttachedReview([baseReview({ status: 'timed-out' })])).toBe(false);
    expect(hasAnyAttachedReview([baseReview({ status: 'attached' })])).toBe(true);
  });

  it('needsZeroVerdictConfirm is false for a non-workshop poll regardless of reviews or mode', () => {
    const poll = basePoll({ source: 'local' });
    expect(needsZeroVerdictConfirm(poll, [], 'mutations')).toBe(false);
    expect(needsZeroVerdictConfirm(poll, [baseReview({ status: 'pending' })], 'all')).toBe(false);
  });

  it('needsZeroVerdictConfirm is true for a covered (workshop, mode!=="off") poll with zero attached reviews', () => {
    const poll = basePoll({ source: 'workshop' });
    expect(needsZeroVerdictConfirm(poll, [], 'mutations')).toBe(true); // no reviewers were ever assigned
    expect(needsZeroVerdictConfirm(poll, [baseReview({ status: 'pending' }), baseReview({ id: 'r2', status: 'timed-out' })], 'mutations')).toBe(true);
    expect(needsZeroVerdictConfirm(poll, [], 'all')).toBe(true);
  });

  it('needsZeroVerdictConfirm is false once at least one review has attached', () => {
    const poll = basePoll({ source: 'workshop' });
    expect(needsZeroVerdictConfirm(poll, [baseReview({ status: 'attached', parseOk: true, verdict: 'approve' })], 'mutations')).toBe(false);
  });

  // Mode-interaction gap (M3 fix cycle, 2026-07-09 — mustFix): a workshop
  // poll's `source` is hard-coded regardless of `review_policy`
  // (workshopRoutes.ts), so `review_policy: 'off'` must silence the confirm
  // even though the poll is still source==='workshop' with zero reviews
  // (reviews are never created in 'off' mode, so hasAnyAttachedReview is
  // always false there — without the coverage check this fired forever).
  it('needsZeroVerdictConfirm is false for a workshop poll when review_policy is "off", regardless of zero attached reviews', () => {
    const poll = basePoll({ source: 'workshop' });
    expect(needsZeroVerdictConfirm(poll, [], 'off')).toBe(false);
    expect(needsZeroVerdictConfirm(poll, [baseReview({ status: 'pending' })], 'off')).toBe(false);
  });

  it('needsZeroVerdictConfirm is false in "off" mode even for the fail-open zero-eligible-reviewers case (no reviews ever attach)', () => {
    // Same shape as the documented fail-open path: zero reviewers were ever
    // selected, so `reviews` stays empty for the poll's whole lifetime.
    const poll = basePoll({ source: 'workshop' });
    expect(needsZeroVerdictConfirm(poll, [], 'off')).toBe(false);
  });
});
