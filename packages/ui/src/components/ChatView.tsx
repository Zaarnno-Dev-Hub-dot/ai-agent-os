import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/gatewayStore';
import { fetchRoomMessages } from '../lib/history';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { Composer } from './Composer';
import { PollCard } from './PollCard';

const PAGE_SIZE = 50;

export function ChatView() {
  const {
    activeRoomId,
    rooms,
    agents,
    messages,
    turnCapBannerRoomId,
    tokenPauseBannerRoomId,
    roomsWithHistoryLoaded,
    hasMoreHistory,
    markHistoryLoaded,
    prependMessages,
    setHasMoreHistory,
    polls,
    dismissedPollIds,
    dismissPoll,
  } = useStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // Set on room switch; cleared once we've done the one-time instant jump to
  // bottom for that room (deferred until history load resolves, so we don't
  // jump against an empty list and then get judged "not near bottom" once
  // the async fetch lands).
  const needsInitialScrollRef = useRef(false);
  const room = rooms.find((r) => r.id === activeRoomId);
  const roomMessages = activeRoomId ? messages.get(activeRoomId) ?? [] : [];
  // In-room inline poll card: open polls
  // for THIS room, dismissable per-poll without affecting the rail/history —
  // dismissal is cleared automatically once the poll leaves 'open' (see
  // gatewayStore's poll.updated handling), so it never hides a decision.
  const inlinePolls = activeRoomId
    ? polls.filter((p) => p.roomId === activeRoomId && p.status === 'open' && !dismissedPollIds.has(p.id))
    : [];

  // Flag a pending instant scroll-to-bottom whenever the active room changes.
  useEffect(() => {
    needsInitialScrollRef.current = true;
    setShowJump(false);
  }, [activeRoomId]);

  // Initial history load per room.
  useEffect(() => {
    if (!activeRoomId || roomsWithHistoryLoaded.has(activeRoomId)) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await fetchRoomMessages(activeRoomId, undefined, PAGE_SIZE);
        if (cancelled) return;
        prependMessages(activeRoomId, page);
        markHistoryLoaded(activeRoomId);
        setHasMoreHistory(activeRoomId, page.length >= PAGE_SIZE);
      } catch (e) {
        console.error('Failed to load room history', e);
        if (!cancelled) markHistoryLoaded(activeRoomId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, roomsWithHistoryLoaded, prependMessages, markHistoryLoaded, setHasMoreHistory]);

  // Autoscroll to bottom on new messages (only when already near bottom);
  // also handles the one-time instant jump to bottom on room open.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !activeRoomId) return;
    if (needsInitialScrollRef.current) {
      // Defer the jump until this room's history fetch has resolved (or was
      // already cached) so we don't jump against a still-empty list.
      if (!roomsWithHistoryLoaded.has(activeRoomId)) return;
      el.scrollTop = el.scrollHeight; // instant, no animation
      needsInitialScrollRef.current = false;
      setShowJump(false);
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [roomMessages.length, activeRoomId, roomsWithHistoryLoaded]);

  function jumpToBottom() {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // instant, matches "jump" not "smooth scroll"
    setShowJump(false);
  }

  async function loadOlder() {
    if (!activeRoomId || loadingMore || hasMoreHistory.get(activeRoomId) === false) return;
    const oldest = roomMessages[0];
    if (!oldest) return;
    setLoadingMore(true);
    const el = scrollContainerRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    try {
      const page = await fetchRoomMessages(activeRoomId, oldest.createdAt, PAGE_SIZE);
      prependMessages(activeRoomId, page);
      setHasMoreHistory(activeRoomId, page.length >= PAGE_SIZE);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
      });
    } catch (e) {
      console.error('Failed to load older messages', e);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 80) {
      void loadOlder();
    }
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(distanceFromBottom > 300);
  }

  return (
    <div className="chat">
      <div className="chathead">
        <div className="t">{room ? `${room.type === 'agent-agent' ? '⇄' : '#'} ${room.name}` : 'Select a room'}</div>
        <div className="s">
          {room
            ? `${room.memberIds.length} member${room.memberIds.length === 1 ? '' : 's'} · ${room.type}`
            : ''}
        </div>
        {room && (
          <div className="chathead-members">
            {/* The human seat is an implicit member of every room. */}
            <div
              className="member-chip"
              style={{ background: 'rgba(30, 122, 87, .25)' }}
              title="You"
            >
              ☺
            </div>
            {room.memberIds
              .filter((id) => id !== 'human')
              .map((id) => {
                const agent = agents.find((a) => a.id === id);
                return (
                  <div
                    key={id}
                    className="member-chip"
                    style={agent ? { background: `${agent.color}33` } : undefined}
                    title={agent ? `${agent.displayName} — ${agent.status}` : id}
                  >
                    {agent ? agent.avatar : id.slice(0, 1).toUpperCase()}
                  </div>
                );
              })}
          </div>
        )}
      </div>
      <div className="msgs-wrap">
        <div className="msgs" ref={scrollContainerRef} onScroll={handleScroll}>
          {loadingMore && <div className="empty-hint" style={{ textAlign: 'center' }}>Loading earlier messages…</div>}
          {room && hasMoreHistory.get(room.id) === false && roomMessages.length > 0 && (
            <div className="empty-hint" style={{ textAlign: 'center' }}>Start of history</div>
          )}
          {turnCapBannerRoomId === activeRoomId && room && (
            <div className="turn-cap-banner">
              Turn cap reached — agent-to-agent relay paused. Send a message to continue.
            </div>
          )}
          {tokenPauseBannerRoomId === activeRoomId && room && (
            <div className="turn-cap-banner">
              Room token budget reached — relay paused. Send a message to resume (+25% headroom,
              once) or raise the budget.
            </div>
          )}
          {roomMessages.length === 0 && room && roomsWithHistoryLoaded.has(room.id) && (
            <div className="empty-hint">No messages in this room yet.</div>
          )}
          {roomMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={messagesEndRef} />
        </div>
        {showJump && room && (
          <button type="button" className="jump-to-latest-btn" onClick={jumpToBottom}>
            ↓ Jump to current
          </button>
        )}
      </div>
      <TypingIndicator roomId={activeRoomId} />
      {inlinePolls.length > 0 && (
        <div className="inline-polls">
          {inlinePolls.map((poll) => (
            <PollCard key={poll.id} poll={poll} onDismiss={() => dismissPoll(poll.id)} />
          ))}
        </div>
      )}
      <Composer room={room} />
    </div>
  );
}
