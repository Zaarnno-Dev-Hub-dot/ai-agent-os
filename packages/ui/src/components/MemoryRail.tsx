import { useEffect, useState } from 'react';
import { useStore } from '../store/gatewayStore';
import { renderMarkdown } from '../lib/markdown';

/**
 * Memory panel (docs/DESIGN-memory-read.md): search the read-only Obsidian
 * vault, view a rendered note, and pin/unpin it to the active room. Pinned
 * notes for the current room show inline with an unpin action; pinning a
 * note the room already has is a no-op guarded client-side (the gateway is
 * idempotent regardless — see memory.ts's pinNote).
 */
export function MemoryRail() {
  const {
    memoryRailOpen,
    toggleMemoryRail,
    memorySearchQuery,
    setMemorySearchQuery,
    memorySearchResults,
    memoryActiveNote,
    clearMemoryActiveNote,
    memoryPinnedByRoom,
    activeRoomId,
    rooms,
    sendClientEvent,
  } = useStore();
  const [debouncedQuery, setDebouncedQuery] = useState(memorySearchQuery);

  const room = rooms.find((r) => r.id === activeRoomId);
  const pinnedInActiveRoom = activeRoomId ? memoryPinnedByRoom.get(activeRoomId) : undefined;

  // Debounce search-as-you-type so every keystroke doesn't round-trip to the
  // gateway — the vault is tiny (55 files) so latency isn't the concern,
  // avoiding a flood of memory.search frames is.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(memorySearchQuery), 200);
    return () => clearTimeout(t);
  }, [memorySearchQuery]);

  useEffect(() => {
    if (!memoryRailOpen) return;
    sendClientEvent({ type: 'memory.search', payload: { query: debouncedQuery } });
    // Only re-run when the debounced query changes or the panel opens —
    // sendClientEvent/memoryRailOpen intentionally excluded from deps
    // (stable function identity from zustand; re-triggering on every store
    // change would spam memory.search).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, memoryRailOpen]);

  if (!memoryRailOpen) return null;

  function openNote(path: string) {
    sendClientEvent({ type: 'memory.get', payload: { path } });
  }

  function pinActiveNote() {
    if (!room || !memoryActiveNote) return;
    sendClientEvent({ type: 'memory.pin-note', payload: { roomId: room.id, path: memoryActiveNote.path } });
  }

  function unpinNote(path: string) {
    if (!room) return;
    sendClientEvent({ type: 'memory.unpin-note', payload: { roomId: room.id, path } });
  }

  const activeNoteIsPinnedHere =
    !!room && !!memoryActiveNote && memoryActiveNote.pinnedInRooms.includes(room.id);

  return (
    <div className="memory-rail">
      <div className="inspect-header">
        <div className="inspect-title">Memory {room ? `— ${room.name}` : ''}</div>
        <button className="cbtn" onClick={toggleMemoryRail} title="Close">
          ✕
        </button>
      </div>

      {memoryActiveNote ? (
        <div className="memory-note-view">
          <div className="memory-note-toolbar">
            <button type="button" className="memory-back" onClick={clearMemoryActiveNote}>
              ← Back to search
            </button>
            {room && (
              <button
                type="button"
                className={activeNoteIsPinnedHere ? 'memory-pin-btn pinned' : 'memory-pin-btn'}
                onClick={() =>
                  activeNoteIsPinnedHere ? unpinNote(memoryActiveNote.path) : pinActiveNote()
                }
                title={
                  activeNoteIsPinnedHere
                    ? `Unpin from ${room.name}`
                    : `Pin to ${room.name} — used as context in this room's next agent replies`
                }
              >
                {activeNoteIsPinnedHere ? '📌 Pinned — unpin' : '📌 Pin to room'}
              </button>
            )}
          </div>
          <div className="memory-note-title">{memoryActiveNote.title}</div>
          <div className="memory-note-path">{memoryActiveNote.path}</div>
          <div
            className="md-body memory-note-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(memoryActiveNote.markdown) }}
          />
        </div>
      ) : (
        <>
          <div className="memory-search">
            <input
              autoFocus
              className="side-input memory-search-input"
              placeholder="Search the vault…"
              value={memorySearchQuery}
              onChange={(e) => setMemorySearchQuery(e.target.value)}
            />
          </div>

          {room && pinnedInActiveRoom && pinnedInActiveRoom.size > 0 && (
            <div className="memory-pinned-section">
              <div className="memory-section-hdr">Pinned in {room.name}</div>
              {Array.from(pinnedInActiveRoom.entries()).map(([path, title]) => (
                <div key={path} className="memory-pinned-row">
                  <button type="button" className="memory-result-link" onClick={() => openNote(path)}>
                    {title}
                  </button>
                  <button
                    type="button"
                    className="memory-unpin-x"
                    onClick={() => unpinNote(path)}
                    title="Unpin"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="memory-results">
            {memorySearchResults.length === 0 && (
              <div className="empty-hint">
                {memorySearchQuery.trim() ? 'No matching notes.' : 'No notes indexed yet.'}
              </div>
            )}
            {memorySearchResults.map((r) => (
              <button
                type="button"
                key={r.path}
                className="memory-result-row"
                onClick={() => openNote(r.path)}
              >
                <div className="memory-result-title">{r.title}</div>
                {r.summary && <div className="memory-result-summary">{r.summary}</div>}
                <div className="memory-result-meta">
                  {r.path} · {new Date(r.mtime).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
