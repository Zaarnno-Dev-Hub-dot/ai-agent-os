import { useState } from 'react';
import { useStore, type ReviewPolicyMode } from '../store/gatewayStore';
import { setReviewPolicyMode } from '../lib/reviewPolicy';

const MODES: Array<{ id: ReviewPolicyMode; label: string; title: string }> = [
  { id: 'off', label: 'Off', title: 'No agent reviews on any action.' },
  { id: 'mutations', label: 'Mutations', title: 'Default — workshop proposes get two agent reviews before you decide.' },
  { id: 'all', label: 'All', title: 'Mutations, plus any seat message carrying an attachment or diff. Plain chat stays exempt.' },
];

/**
 * review_policy toggle. The server is authoritative — clicking a mode POSTs to
 * /api/review-policy (humanToken attached automatically by
 * lib/reviewPolicy.ts's setReviewPolicyMode) and waits for the
 * `review.policy.status` broadcast (gatewayStore.ts) to actually move the
 * highlighted state; a rejected toggle (e.g. dev-mode with no humanToken —
 * see lib/reviewPolicy.ts's doc comment) shows an inline error instead of
 * silently doing nothing.
 */
export function ReviewPolicyToggle() {
  const mode = useStore((s) => s.reviewPolicyMode);
  const [pending, setPending] = useState<ReviewPolicyMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(next: ReviewPolicyMode) {
    if (next === mode || pending) return;
    setPending(next);
    setError(null);
    const result = await setReviewPolicyMode(next);
    setPending(null);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="review-policy-toggle" title="Two-Reviewer Policy — how many actions get an agent review before you decide">
      <span className="review-policy-toggle-label">Reviews</span>
      <div className="review-policy-toggle-buttons">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`review-policy-toggle-btn ${mode === m.id ? 'active' : ''}`}
            disabled={pending != null}
            title={m.title}
            onClick={() => pick(m.id)}
          >
            {pending === m.id ? '…' : m.label}
          </button>
        ))}
      </div>
      {error && <span className="review-policy-toggle-error">{error}</span>}
    </div>
  );
}
