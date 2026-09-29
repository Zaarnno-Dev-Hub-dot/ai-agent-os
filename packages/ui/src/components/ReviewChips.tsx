import { useState } from 'react';
import type { PollReview } from '@agent-os/shared';
import { activeReviewsPerSlot, reviewChipLabel, reviewChipStatus, type ReviewChipStatus } from '../lib/pollPresent';
import { setFindingValidity } from '../lib/reviewPolicy';

/** Icon per chip status — decoration only, the label text is what's actually informative (accessibility: chips also carry a title="" with the full label). */
function chipIcon(status: ReviewChipStatus): string {
  switch (status) {
    case 'pending':
      return '…';
    case 'approve':
      return '✓';
    case 'concerns':
      return '△';
    case 'reject':
      return '✕';
    case 'unparseable':
      return '?';
    case 'timed-out':
      return '⏱';
  }
}

/** 3-state cycle for a finding's ground-truth toggle: unmarked -> valid -> invalid -> unmarked. */
function nextValidityState(current: boolean | undefined): boolean | null {
  if (current === undefined) return true;
  if (current === true) return false;
  return null;
}

function FindingRow({ reviewId, idx, text, valid }: { reviewId: string; idx: number; text: string; valid: boolean | undefined }) {
  const [pending, setPending] = useState(false);

  async function toggle() {
    if (pending) return;
    setPending(true);
    // Optimistic-free: the gateway broadcasts poll.review.updated on success
    // and the store applies it — this call's own return value is used only
    // to detect failure (see lib/reviewPolicy.ts's doc comment), so there is
    // no local state to roll back on a failed request.
    await setFindingValidity(reviewId, idx, nextValidityState(valid));
    setPending(false);
  }

  const stateLabel = valid === true ? 'valid' : valid === false ? 'invalid' : 'unmarked';
  return (
    <li className={`review-finding review-finding-${stateLabel}`}>
      <span className="review-finding-text">{text}</span>
      <button
        type="button"
        className="review-finding-toggle"
        disabled={pending}
        onClick={toggle}
        title={`Mark this finding — currently ${stateLabel}. Click to cycle valid → invalid → unmarked.`}
      >
        {valid === true ? '✓ valid' : valid === false ? '✕ invalid' : 'mark…'}
      </button>
    </li>
  );
}

function ReviewChip({ review }: { review: PollReview }) {
  const [expanded, setExpanded] = useState(false);
  const status = reviewChipStatus(review);
  const label = reviewChipLabel(status);
  const findings = review.findings ?? [];

  return (
    <div className={`review-chip review-chip-${status}`}>
      <div className="review-chip-hdr">
        <span className="review-chip-icon" aria-hidden="true">
          {chipIcon(status)}
        </span>
        <span className="review-chip-seat" title={`slot ${review.slot} — ${review.family}`}>
          {review.seatId}
        </span>
        <span className="review-chip-label">{label}</span>
        {review.substituteForReviewId && (
          <span className="review-chip-sub-badge" title="This reviewer substituted in after the original timed out">
            substitute
          </span>
        )}
      </div>

      {status === 'unparseable' && review.rawText && (
        <div className="review-chip-raw">
          <button type="button" className="review-chip-raw-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide raw reply' : 'Show raw reply'}
          </button>
          {expanded && <pre className="review-chip-raw-text">{review.rawText}</pre>}
        </div>
      )}

      {findings.length > 0 && (
        <ul className="review-findings">
          {findings.map((text, idx) => (
            <FindingRow key={idx} reviewId={review.id} idx={idx} text={text} valid={review.findingValid?.[idx]} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Two-Reviewer Policy chip row. Shows
 * the CURRENTLY ACTIVE reviewer per slot (activeReviewsPerSlot — a T+4
 * substitute naturally replaces its original in this display, see that
 * function's doc comment). Renders nothing when the poll was never covered
 * (no review rows at all) — same "v1 polls render exactly as before when the
 * rich fields are absent" spirit as the rest of this card.
 */
export function ReviewChipsRow({ reviews }: { reviews: PollReview[] }) {
  const active = activeReviewsPerSlot(reviews);
  if (active.length === 0) return null;
  return (
    <div className="poll-rich-section review-chips-row">
      <div className="poll-rich-label">Reviews</div>
      <div className="review-chips">
        {active.map((review) => (
          <ReviewChip key={review.id} review={review} />
        ))}
      </div>
    </div>
  );
}
