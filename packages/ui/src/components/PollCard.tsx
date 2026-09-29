import { useEffect, useState } from 'react';
import { ClientEvent } from '@agent-os/shared';
import { useStore, Poll } from '../store/gatewayStore';
import { isCriticalPoll, needsZeroVerdictConfirm, resolveApproveRejectOptionIds, stripCriticalPrefix } from '../lib/pollPresent';
import { withdrawPoll } from '../lib/pollActions';
import { PollAttachmentsGallery, PollDisputeColumns, PollSummarySection } from './PollRichSections';
import { ReviewChipsRow } from './ReviewChips';

/** `expiresAt` -> "2h 14m" / "38s" / "expired" — re-derived on a tick so an open card counts down live without a per-second re-render storm. */
function formatCountdown(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** `createdAt` -> "opened Jul 28" (+ "· 4d ago" once it's a day or more old) — the "put dates on approvals" ask, rendered once per card, not re-ticked. */
function formatOpenedDate(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / 86400000);
  const dateStr = new Date(createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return days >= 1 ? `opened ${dateStr} · ${days}d ago` : `opened ${dateStr}`;
}

function sourceBadge(source: Poll['source']) {
  if (source === 'paperclip') {
    return (
      <span className="poll-badge poll-badge-paperclip" title="Bridged in from Paperclip">
        ⇄ Paperclip
      </span>
    );
  }
  return (
    <span className="poll-badge poll-badge-local" title="Raised locally in this dashboard">
      ● Local
    </span>
  );
}

export type PollCardVariant = 'rail' | 'inbox';

/**
 * One decision card, shared by PollsRail (cross-room list), the in-room
 * inline mount above the composer, and the
 * Studio Dock `approvals-inbox` route.
 * Decided/expired cards render read-only (their outcome) in every variant.
 * Open cards differ by `variant`:
 *   - `'rail'` (default): unchanged from Wave 4 — plain question/detail text,
 *     one button per option.
 *   - `'inbox'`: WHAT/WHY/RECOMMENDATION + attachments gallery + dispute
 *     columns (PollRichSections.tsx), and a fixed four-button row
 *     (Approve/Reject/Defer/More info) instead of the raw options list.
 * `poll.decide`/`poll.defer`/`poll.info-requested` are gateway-local
 * extensions of the frozen shared ClientEvent union — cast at this endpoint,
 * same idiom as room.rollover (see Sidebar.tsx).
 */
export function PollCard({
  poll,
  roomName,
  onDismiss,
  variant = 'rail',
  onAction,
}: {
  poll: Poll;
  roomName?: string;
  onDismiss?: () => void;
  variant?: PollCardVariant;
  /** Called after a decide/defer/more-info send succeeds — the inbox uses this to advance its queue cursor. */
  onAction?: () => void;
}) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const connected = useStore((s) => s.connected);
  // Two-Reviewer Policy (Wave 7 M3): this poll's review rows, if any — empty
  // array for a poll the policy never covered (e.g. a plain local poll), or
  // one that predates M3. `useStore` selector returns a NEW array identity
  // only when the underlying Map entry actually changes (zustand's default
  // equality is reference — the store only ever replaces this array via a
  // fresh `[...existing]`/`[...existing, review]`, never mutates in place —
  // see gatewayStore.ts's poll.review.updated handler), so this doesn't
  // over-render.
  const reviews = useStore((s) => s.pollReviews.get(poll.id) ?? []);
  // Zero-verdict confirm needs the CURRENT policy mode, not just source ===
  // 'workshop' (see pollPresent.ts's needsZeroVerdictConfirm doc comment —
  // M3 fix cycle, 2026-07-09): a workshop poll's action type can be
  // uncovered (review_policy: 'off') even though its source is unchanged.
  const reviewPolicyMode = useStore((s) => s.reviewPolicyMode);
  const [note, setNote] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Soft speed-bump: set to the optionId the
  // user just clicked once a zero-verdict decide needs a second, inline
  // click to confirm. Cleared on cancel or once the decide actually sends.
  const [pendingConfirmOptionId, setPendingConfirmOptionId] = useState<string | null>(null);
  // Withdraw ("remove decision" button, owner-directed, ): a
  // human-only affordance to retire a stale/superseded OPEN poll without
  // deciding it — the only prior exit was defer, which just re-queues it.
  // Two-step: clicking "Remove" arms an inline confirm banner (same shape as
  // the zero-verdict confirm above) with an optional reason input; the
  // second click actually sends the REST call.
  const [withdrawConfirming, setWithdrawConfirming] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const isOpen = poll.status === 'open';
  const isInbox = variant === 'inbox';

  // Only tick while there's a countdown to show — decided/expired cards and
  // polls without expiresAt never need a re-render clock.
  useEffect(() => {
    if (!isOpen || poll.expiresAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isOpen, poll.expiresAt]);

  // sendClientEvent already no-ops (returns false) when the socket isn't
  // open; this wrapper's only job is surfacing that as visible inline text
  // instead of a silent no-op button press.
  function sendPollEvent(type: string, payload: Record<string, unknown>): boolean {
    if (!connected) {
      setActionError('Gateway offline — reconnect to decide.');
      return false;
    }
    setActionError(null);
    return sendClientEvent({ type, payload } as unknown as ClientEvent);
  }

  function decide(optionId: string) {
    if (deciding) return;
    // Zero-verdict soft-confirm: the FIRST
    // click on a covered, zero-attached-verdict poll only arms the inline
    // banner below — it does not send anything. Clicking the SAME option
    // again (either the original button, re-labeled by the disabled state
    // below, or the banner's own "decide anyway" button, which calls
    // decide(pendingConfirmOptionId) directly) is the confirming second
    // click. No typed friction anywhere — this is the only extra step, and
    // it is exactly one click.
    if (needsZeroVerdictConfirm(poll, reviews, reviewPolicyMode) && pendingConfirmOptionId !== optionId) {
      setPendingConfirmOptionId(optionId);
      return;
    }
    setPendingConfirmOptionId(null);
    setDeciding(true);
    const ok = sendPollEvent('poll.decide', { pollId: poll.id, optionId, note: note.trim() || undefined });
    if (!ok) {
      // Send failed (offline) — re-enable so the user can retry once reconnected.
      setDeciding(false);
      return;
    }
    // Deliberately NOT resetting `deciding` here: the poll is about to go
    // non-open (poll.updated round trip), at which point this whole
    // buttons/note block is replaced by the read-only outcome view — leaving
    // it disabled in the meantime blocks a double-decide click during that
    // window instead of relying solely on the server's settle-once guard.
    // (Unlike defer/more-info below, where the poll stays OPEN and this card
    // must stay interactive — resetting there is required, not optional.)
    onAction?.();
  }

  function deferPoll() {
    if (deciding) return;
    setDeciding(true);
    const ok = sendPollEvent('poll.defer', { pollId: poll.id, note: note.trim() || undefined });
    setDeciding(false);
    if (ok) onAction?.();
  }

  function requestMoreInfo() {
    if (deciding) return;
    const promptNote = window.prompt('What additional info do you need?');
    if (promptNote === null) return;
    setDeciding(true);
    const ok = sendPollEvent('poll.info-requested', { pollId: poll.id, note: promptNote.trim() || undefined });
    setDeciding(false);
    if (ok) onAction?.();
  }

  function requestWithdraw() {
    if (deciding || withdrawing) return;
    setWithdrawError(null);
    setWithdrawConfirming(true);
  }

  function cancelWithdraw() {
    setWithdrawConfirming(false);
    setWithdrawNote('');
    setWithdrawError(null);
  }

  async function confirmWithdraw() {
    if (withdrawing) return;
    setWithdrawing(true);
    setWithdrawError(null);
    const result = await withdrawPoll(poll.id, withdrawNote.trim() || undefined);
    setWithdrawing(false);
    if (!result.ok) {
      setWithdrawError(result.error);
      return;
    }
    setWithdrawConfirming(false);
    setWithdrawNote('');
    onAction?.();
  }

  const { approveId, rejectId } = resolveApproveRejectOptionIds(poll);
  const deferralCount = poll.deferrals?.length ?? 0;
  const deferDisabled = deciding || deferralCount >= 3; // MAX_POLL_DEFERRALS — see polls.ts; mirrored here since the UI has no import path into gateway code.
  const decidedOption = poll.decision ? poll.options.find((o) => o.id === poll.decision!.optionId) : undefined;

  return (
    <div className={`poll-card ${isOpen ? 'open' : poll.status} ${isInbox ? 'poll-card-inbox' : ''}`}>
      <div className="poll-card-hdr">
        {sourceBadge(poll.source)}
        {isCriticalPoll(poll) && (
          <span className="poll-badge poll-badge-critical" title="Marked CRITICAL — survives age-based cleanup">
            CRITICAL
          </span>
        )}
        {roomName && <span className="poll-badge poll-badge-room">#{roomName}</span>}
        <span className="poll-requester" title={`Requested by ${poll.requestedBy}`}>
          {poll.requestedBy}
        </span>
        <span className="poll-opened-date" title={new Date(poll.createdAt).toLocaleString()}>
          {formatOpenedDate(poll.createdAt, now)}
        </span>
        {isOpen && poll.expiresAt != null && (
          <span className="poll-expiry" title={new Date(poll.expiresAt).toLocaleString()}>
            ⏱ {formatCountdown(poll.expiresAt, now)}
          </span>
        )}
        {onDismiss && (
          <button type="button" className="poll-dismiss" onClick={onDismiss} title="Dismiss (still visible in the rail)">
            ✕
          </button>
        )}
      </div>

      {isInbox ? (
        <PollSummarySection poll={poll} />
      ) : (
        <>
          <div className="poll-question">{stripCriticalPrefix(poll.question)}</div>
          {poll.detail && <div className="poll-detail">{poll.detail}</div>}
        </>
      )}

      {isInbox && (
        <>
          <PollAttachmentsGallery poll={poll} />
          <PollDisputeColumns poll={poll} />
        </>
      )}

      {/* Two-Reviewer Policy (Wave 7 M3): shown in EVERY variant — renders
          nothing when this poll has no review rows (never covered, or
          predates M3), same "absent fields render exactly as before" rule
          the rest of this card follows. */}
      <ReviewChipsRow reviews={reviews} />

      {isOpen ? (
        <>
          {isInbox ? (
            <div className="poll-inbox-actions">
              {approveId && rejectId ? (
                <>
                  <button
                    type="button"
                    className="poll-action poll-action-approve"
                    disabled={deciding}
                    title="Approve"
                    onClick={() => decide(approveId)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="poll-action poll-action-reject"
                    disabled={deciding}
                    title="Reject"
                    onClick={() => decide(rejectId)}
                  >
                    Reject
                  </button>
                </>
              ) : (
                // No approve/reject option on this poll (custom option set,
                // e.g. a Photon/production-lanes-style poll) — the fixed
                // pair would be permanently disabled and undecidable, so
                // fall back to the poll's real options (same rendering as
                // the rail variant's .poll-options block below).
                <div className="poll-options">
                  {poll.options.map((opt) => {
                    const recommended = opt.id === poll.recommendationId;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className={recommended ? 'poll-option recommended' : 'poll-option'}
                        disabled={deciding}
                        onClick={() => decide(opt.id)}
                        title={recommended ? 'Recommended option' : undefined}
                      >
                        {opt.label}
                        {recommended && <span className="poll-rec-label">recommended</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                className="poll-action poll-action-defer"
                disabled={deferDisabled}
                title={deferralCount >= 3 ? 'Already deferred 3 times — must be decided now' : 'Defer'}
                onClick={deferPoll}
              >
                Defer
              </button>
              <button type="button" className="poll-action poll-action-info" disabled={deciding} onClick={requestMoreInfo}>
                More info
              </button>
              <button
                type="button"
                className="poll-action poll-action-withdraw"
                disabled={deciding || withdrawing}
                title="Withdraw — remove from Approvals without deciding"
                onClick={requestWithdraw}
              >
                Remove
              </button>
            </div>
          ) : (
            <>
              <div className="poll-options">
                {poll.options.map((opt) => {
                  const recommended = opt.id === poll.recommendationId;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={recommended ? 'poll-option recommended' : 'poll-option'}
                      disabled={deciding}
                      onClick={() => decide(opt.id)}
                      title={recommended ? 'Recommended option' : undefined}
                    >
                      {opt.label}
                      {recommended && <span className="poll-rec-label">recommended</span>}
                    </button>
                  );
                })}
              </div>
              <div className="poll-options">
                <button
                  type="button"
                  className="poll-action poll-action-withdraw"
                  disabled={deciding || withdrawing}
                  title="Withdraw — remove from Approvals without deciding"
                  onClick={requestWithdraw}
                >
                  Remove
                </button>
              </div>
            </>
          )}
          {withdrawConfirming && (
            <div className="poll-withdraw-confirm">
              <span>Remove this from Approvals without deciding?</span>
              <input
                className="side-input poll-note-input"
                placeholder="Optional reason…"
                value={withdrawNote}
                disabled={withdrawing}
                onChange={(e) => setWithdrawNote(e.target.value)}
              />
              <button
                type="button"
                className="poll-withdraw-confirm-yes"
                disabled={withdrawing}
                onClick={confirmWithdraw}
              >
                {withdrawing ? 'Removing…' : 'Yes, remove'}
              </button>
              <button
                type="button"
                className="poll-withdraw-confirm-cancel"
                disabled={withdrawing}
                onClick={cancelWithdraw}
              >
                Cancel
              </button>
            </div>
          )}
          {withdrawError && <div className="poll-action-error">{withdrawError}</div>}
          {pendingConfirmOptionId && (
            <div className="poll-review-confirm">
              <span>No reviews attached yet — decide anyway?</span>
              <button type="button" className="poll-review-confirm-yes" onClick={() => decide(pendingConfirmOptionId)}>
                Yes, decide
              </button>
              <button type="button" className="poll-review-confirm-cancel" onClick={() => setPendingConfirmOptionId(null)}>
                Cancel
              </button>
            </div>
          )}
          <input
            className="side-input poll-note-input"
            placeholder={isInbox ? 'Optional note (approve / reject / defer)…' : 'Optional note with your decision…'}
            value={note}
            disabled={deciding}
            onChange={(e) => setNote(e.target.value)}
          />
          {actionError && <div className="poll-action-error">{actionError}</div>}
          {isInbox && deferralCount > 0 && (
            <div className="poll-deferral-log">
              {poll.deferrals!.map((d, i) => (
                <div key={i} className="poll-deferral-line">
                  Deferred {new Date(d.at).toLocaleString()}
                  {d.note ? ` — ${d.note}` : ''}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="poll-outcome">
          {poll.status === 'decided' && poll.decision ? (
            <>
              <span className={poll.decision.decidedBy === 'auto-default' ? 'poll-outcome-auto' : 'poll-outcome-picked'}>
                {decidedOption?.label ?? poll.decision.optionId}
              </span>
              <span className="poll-outcome-meta">
                {poll.decision.decidedBy === 'auto-default'
                  ? 'auto-decided (expiry default)'
                  : `decided by ${poll.decision.decidedBy}`}
                {' · '}
                {new Date(poll.decision.decidedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              {poll.decision.note && <span className="poll-outcome-note">“{poll.decision.note}”</span>}
            </>
          ) : poll.status === 'withdrawn' ? (
            <>
              <span className="poll-outcome-withdrawn">Withdrawn</span>
              {(() => {
                const last = poll.messages?.[poll.messages.length - 1];
                return last && last.content.startsWith('Withdrawn by') ? (
                  <span className="poll-outcome-meta">{last.content}</span>
                ) : null;
              })()}
            </>
          ) : (
            <span className="poll-outcome-meta">expired — no decision</span>
          )}
        </div>
      )}
    </div>
  );
}
