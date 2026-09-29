import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/gatewayStore';
import { openPollsOldestFirst } from '../lib/pollPresent';
import { PollCard } from './PollCard';
import { ReviewPolicyToggle } from './ReviewPolicyToggle';

/**
 * Studio Dock route `approvals-inbox`. Single-card focus on the oldest open poll, with queue
 * navigation. Reads live polls straight from gatewayStore (state.sync +
 * poll.updated) — no parallel store, same source of truth as PollsRail.
 */
export function ApprovalsInbox() {
  const { polls, rooms, setActiveDockAppId } = useStore();
  const open = useMemo(() => openPollsOldestFirst(polls), [polls]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, open.length - 1)));
  }, [open.length]);

  const index = open.length === 0 ? 0 : Math.min(cursor, open.length - 1);
  const poll = open[index];
  const roomName = poll ? rooms.find((r) => r.id === poll.roomId)?.name ?? poll.roomId : undefined;

  function goPrev() {
    setCursor((c) => Math.max(0, c - 1));
  }
  function goNext() {
    setCursor((c) => Math.min(open.length - 1, c + 1));
  }

  return (
    <div className="approvals-inbox">
      <header className="approvals-inbox-hdr">
        <div>
          <h1 className="approvals-inbox-title">Approvals</h1>
          <p className="approvals-inbox-sub">Decisions waiting on you — sourced from the live poll store.</p>
        </div>
        <div className="approvals-inbox-meta">
          <ReviewPolicyToggle />
          <span className="approvals-inbox-count">{open.length} open</span>
          <button type="button" className="approvals-nav-btn" onClick={() => setActiveDockAppId(null)} title="Back to rooms">
            ← Rooms
          </button>
        </div>
      </header>

      {open.length === 0 ? (
        <div className="approvals-inbox-empty">
          <div className="empty-hint">No open approvals right now.</div>
        </div>
      ) : (
        <>
          <div className="approvals-inbox-nav">
            <button type="button" className="approvals-nav-btn" disabled={index <= 0} onClick={goPrev}>
              ← Older in queue
            </button>
            <span className="approvals-inbox-pos">
              {index + 1} / {open.length}
              <span className="approvals-inbox-pos-hint"> (oldest first)</span>
            </span>
            <button type="button" className="approvals-nav-btn" disabled={index >= open.length - 1} onClick={goNext}>
              Newer in queue →
            </button>
          </div>
          <div className="approvals-inbox-card">
            <PollCard
              key={poll.id}
              poll={poll}
              roomName={roomName}
              variant="inbox"
              onAction={() => {
                if (index >= open.length - 1) setCursor(Math.max(0, index - 1));
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
