import { useMemo, useState } from 'react';
import { useStore } from '../store/gatewayStore';
import { pollSettledAt } from '../lib/pollPresent';
import { PollCard } from './PollCard';

const HISTORY_LIMIT = 20;

/**
 * Approvals/Polls rail, FilesRail/MemoryRail
 * pattern: every open poll across every room, newest first, plus a collapsed
 * history of the last 20 decided/expired polls. Cross-room by design — this
 * is the "find it even when you're not in that room" surface the motivating
 * incident (a Paperclip approval nobody saw) called for.
 */
export function PollsRail() {
  const { pollsRailOpen, togglePollsRail, polls, rooms } = useStore();
  const [historyOpen, setHistoryOpen] = useState(false);

  const roomName = (roomId: string) => rooms.find((r) => r.id === roomId)?.name ?? roomId;

  const open = useMemo(
    () => polls.filter((p) => p.status === 'open').sort((a, b) => b.createdAt - a.createdAt),
    [polls]
  );
  const history = useMemo(
    () =>
      polls
        .filter((p) => p.status !== 'open')
        .sort((a, b) => pollSettledAt(b) - pollSettledAt(a))
        .slice(0, HISTORY_LIMIT),
    [polls]
  );

  if (!pollsRailOpen) return null;

  return (
    <div className="polls-rail">
      <div className="inspect-header">
        <div className="inspect-title">Polls {open.length > 0 ? `— ${open.length} open` : ''}</div>
        <button className="cbtn" onClick={togglePollsRail} title="Close">
          ✕
        </button>
      </div>

      <div className="polls-rail-list">
        {open.length === 0 && <div className="empty-hint">No open decisions right now.</div>}
        {open.map((poll) => (
          <PollCard key={poll.id} poll={poll} roomName={roomName(poll.roomId)} />
        ))}

        {history.length > 0 && (
          <div className="polls-history">
            <button type="button" className="polls-history-toggle" onClick={() => setHistoryOpen((v) => !v)}>
              {historyOpen ? '▾' : '▸'} History ({history.length})
            </button>
            {historyOpen &&
              history.map((poll) => <PollCard key={poll.id} poll={poll} roomName={roomName(poll.roomId)} />)}
          </div>
        )}
      </div>
    </div>
  );
}
