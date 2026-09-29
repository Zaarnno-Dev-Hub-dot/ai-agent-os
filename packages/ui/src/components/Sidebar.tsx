import { useEffect, useState } from 'react';
import { ClientEvent, Room } from '@agent-os/shared';
import { useStore, type EphemeralPresence } from '../store/gatewayStore';
import { useVoiceStore } from '../store/voiceStore';
import { isTTSSupported } from '../lib/voice';
import { AgentSidebarRow } from './AgentCard';
import { StatusDot } from './StatusDot';
import { StudioDock } from './StudioDock';
import { AddAgentPanel } from './AddAgentPanel';

/** "12s" / "1m 05s" — elapsed time since a TEMP worker announced itself. */
function elapsedLabel(startedAt: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - startedAt) / 1000));
  if (deltaS < 60) return `${deltaS}s`;
  const m = Math.floor(deltaS / 60);
  const s = deltaS % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * One "on duty" TEMP row (2026-08-02, Agents\temp\ presence surface).
 * Ticks its own elapsed-time label off a local 1s interval — the gateway
 * only pushes a fresh state.sync on announce/clear/a-sweep-that-removed-
 * something, never once a second, so a live-feeling counter has to be
 * computed client-side rather than waiting on a new server message.
 * Interval is cleaned up on unmount (return => clearInterval(...)).
 */
function EphemeralSidebarRow({ entry }: { entry: EphemeralPresence }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const detail = entry.meta?.role ? ` — ${entry.meta.role}` : '';

  return (
    <div className="agent" title={`${entry.label}${detail} — on duty ${elapsedLabel(entry.startedAt, nowMs)}`}>
      <div className="av" style={{ background: 'rgba(138,125,250,.2)' }}>
        ⏱
      </div>
      {entry.label}
      <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--faint)' }}>
        {elapsedLabel(entry.startedAt, nowMs)}
      </span>
      <span className="tbadge" style={{ marginLeft: '6px' }}>
        TEMP
      </span>
    </div>
  );
}

/** Agent checkbox list shared by the create dialog and the room Members editor. */
function MemberChecklist({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const agents = useStore((s) => s.agents);
  if (agents.length === 0) {
    return (
      <div className="empty-hint" style={{ padding: '2px 0 6px' }}>
        No known agents to add yet.
      </div>
    );
  }
  return (
    <>
      {agents.map((agent) => (
        <label key={agent.id} className="member-row">
          <input
            type="checkbox"
            checked={selected.has(agent.id)}
            onChange={() => onToggle(agent.id)}
          />
          <div className="av" style={{ background: `${agent.color}33`, width: 20, height: 20, fontSize: 11 }}>
            {agent.avatar}
          </div>
          {agent.displayName}
          <span style={{ marginLeft: 'auto' }}>
            <StatusDot status={agent.status} />
          </span>
        </label>
      ))}
    </>
  );
}

/** Inline create-room dialog under the ROOMS header ("+" button). */
function RoomCreateDialog({ onClose }: { onClose: () => void }) {
  const { sendClientEvent } = useStore();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= 60;

  const toggleMember = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = () => {
    if (!valid) return;
    // The gateway re-validates everything — this check is UX only.
    const ok = sendClientEvent({
      type: 'room.create',
      payload: { name: trimmed, type: 'group', memberIds: Array.from(selected) },
    });
    if (ok) onClose();
  };

  return (
    <div className="room-create">
      <input
        autoFocus
        className="side-input"
        placeholder="Room name"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') create();
          if (e.key === 'Escape') onClose();
        }}
      />
      <MemberChecklist selected={selected} onToggle={toggleMember} />
      <div className="room-create-actions">
        <button type="button" className="room-create-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="side-connect-btn" disabled={!valid} onClick={create}>
          Create
        </button>
      </div>
    </div>
  );
}

/**
 * Inline create-project dialog under the ROOMS header ("+ project" button).
 * No member picker — projects have no membership/budget defaults their rooms
 * inherit.
 * project.create is a gateway-local extension of the frozen shared
 * ClientEvent union — same cast idiom as room.rollover/room.set-project.
 */
function ProjectCreateDialog({ onClose }: { onClose: () => void }) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const [name, setName] = useState('');
  const trimmed = name.trim();
  // Gateway also rejects the reserved 'Unsorted' literal (case-insensitive) —
  // this check is UX only, same "server re-validates everything" contract as
  // every other create dialog in this file.
  const valid = trimmed.length >= 1 && trimmed.length <= 60 && trimmed.toLowerCase() !== 'unsorted';

  const create = () => {
    if (!valid) return;
    const ok = sendClientEvent({
      type: 'project.create',
      payload: { name: trimmed },
    } as unknown as ClientEvent);
    if (ok) onClose();
  };

  return (
    <div className="room-create">
      <input
        autoFocus
        className="side-input"
        placeholder="Project name"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') create();
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="room-create-actions">
        <button type="button" className="room-create-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="side-connect-btn" disabled={!valid} onClick={create}>
          Create
        </button>
      </div>
    </div>
  );
}

/**
 * "Project →" submenu content: lists every project + "Unsorted" (=null),
 * highlighting the room's current assignment. Selecting an option sends
 * room.set-project and closes the whole kebab menu (same one-shot-then-close
 * shape as Rename/Archive, not the stays-open shape Autoroute uses, since
 * picking a project is a single decision rather than a toggle likely to be
 * flipped back and forth in one visit).
 */
function ProjectPicker({
  currentProjectId,
  onPick,
}: {
  currentProjectId: string | null;
  onPick: (projectId: string | null) => void;
}) {
  const projects = useStore((s) => s.projects);
  return (
    <>
      <button
        type="button"
        className="room-menu-item"
        onClick={() => onPick(null)}
        disabled={currentProjectId == null}
      >
        {currentProjectId == null ? '✓ ' : ''}Unsorted
      </button>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          className="room-menu-item"
          onClick={() => onPick(project.id)}
          disabled={currentProjectId === project.id}
        >
          {currentProjectId === project.id ? '✓ ' : ''}
          {project.name}
        </button>
      ))}
    </>
  );
}

/**
 * Loop-lite panel (Wave 2): pick a builder seat + judge seat from the room's
 * current members, a round cap (1-6), and Start/Stop. The gateway is the
 * only source of truth for seat eligibility (VERIFIED + free/local billing —
 * AgentSummary carries no billing field to the UI, so this panel does not
 * attempt to pre-filter the picker; an ineligible pick is rejected server-
 * side and surfaces as the existing error toast, same as any other room.*
 * validation failure). Round/phase shown here come ONLY from loop.status —
 * no client-side prediction of where the loop "should" be.
 */
function LoopPanel({ room, onClose }: { room: Room; onClose: () => void }) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const agents = useStore((s) => s.agents);
  const loop = useStore((s) => s.loopByRoom.get(room.id));
  const memberAgents = agents.filter((a) => room.memberIds.includes(a.id));

  const [builderSeat, setBuilderSeat] = useState(loop?.builderSeat ?? memberAgents[0]?.id ?? '');
  const [judgeSeat, setJudgeSeat] = useState(
    loop?.judgeSeat ?? memberAgents.find((a) => a.id !== builderSeat)?.id ?? ''
  );
  const [maxRounds, setMaxRounds] = useState(loop?.maxRounds ?? 4);

  const isActive = loop?.active === true;

  const start = () => {
    if (!builderSeat || !judgeSeat || builderSeat === judgeSeat) return;
    sendClientEvent({
      type: 'loop.start',
      payload: { roomId: room.id, builderSeat, judgeSeat, maxRounds },
    } as unknown as ClientEvent);
  };

  const stop = () => {
    sendClientEvent({ type: 'loop.stop', payload: { roomId: room.id } } as unknown as ClientEvent);
  };

  // No wrapper <div> here — the caller (RoomRow) already renders the
  // `.room-menu.wide` container this panel lives inside, same convention
  // MemberChecklist follows for the Members… editor.
  if (memberAgents.length < 2) {
    return (
      <>
        <div className="room-menu-label">Loop — {room.name}</div>
        <div className="empty-hint" style={{ padding: '2px 9px 8px' }}>
          Needs at least 2 agents in this room (builder + judge).
        </div>
        <button type="button" className="room-menu-item" onClick={onClose}>
          Close
        </button>
      </>
    );
  }

  return (
    <>
      <div className="room-menu-label">Loop — {room.name}</div>
      {isActive && (
        <div className="loop-status-line">
          {loop?.round ?? 0}/{loop?.maxRounds} rounds complete —{' '}
          {loop?.phase === 'awaiting-judge' ? `@${loop?.judgeSeat} reviewing` : `@${loop?.builderSeat}'s turn`}
        </div>
      )}
      <label className="loop-field-label">Builder</label>
      <select
        className="side-input loop-seat-select"
        value={builderSeat}
        disabled={isActive}
        onChange={(e) => setBuilderSeat(e.target.value)}
      >
        {memberAgents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </select>
      <label className="loop-field-label">Judge</label>
      <select
        className="side-input loop-seat-select"
        value={judgeSeat}
        disabled={isActive}
        onChange={(e) => setJudgeSeat(e.target.value)}
      >
        {memberAgents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </select>
      <label className="loop-field-label">Max rounds (1–6)</label>
      <input
        type="number"
        min={1}
        max={6}
        className="side-input"
        value={maxRounds}
        disabled={isActive}
        onChange={(e) => setMaxRounds(Math.max(1, Math.min(6, Number(e.target.value) || 1)))}
      />
      {builderSeat === judgeSeat && (
        <div className="loop-warn">Builder and judge must be different seats.</div>
      )}
      <div className="room-create-actions">
        <button type="button" className="room-create-cancel" onClick={onClose}>
          Close
        </button>
        {isActive ? (
          <button type="button" className="room-menu-item danger" style={{ width: 'auto' }} onClick={stop}>
            Stop loop
          </button>
        ) : (
          <button
            type="button"
            className="side-connect-btn"
            disabled={!builderSeat || !judgeSeat || builderSeat === judgeSeat}
            onClick={start}
          >
            Start
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Room row: switch on click; kebab/right-click → Rename / Archive (inline
 * confirm). the Lobby gets Reset Lobby instead — rename/archive are rejected
 * for it server-side, and rollover is its archive story.
 */
function RoomRow({
  room,
  active,
  unread,
  onSelect,
}: {
  room: Room;
  active: boolean;
  unread: number;
  onSelect: () => void;
}) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const autorouteEnabled = useStore((s) => s.autorouteRooms.has(room.id));
  const currentProjectId = useStore((s) => s.projectAssignments.get(room.id) ?? null);
  // Voice v1: per-room auto-read toggle. Pure
  // client-side/localStorage state — no wire event, no gateway involvement —
  // hence useVoiceStore rather than sendClientEvent, unlike autoroute above.
  const autoReadEnabled = useVoiceStore((s) => s.autoReadRoomIds.has(room.id));
  const toggleAutoRead = useVoiceStore((s) => s.toggleAutoRead);
  const ttsSupported = isTTSSupported();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(room.name);
  const [editingMembers, setEditingMembers] = useState(false);
  const [memberDraft, setMemberDraft] = useState<Set<string>>(new Set());
  const [pickingProject, setPickingProject] = useState(false);
  const [editingLoop, setEditingLoop] = useState(false);
  // The gateway reserves this exact name for the default room (and archives
  // dailies under dated names), so name is a reliable Quad signal here; the
  // server re-validates the rollover target regardless.
  const isQuad = room.name === 'Lobby';

  const toggleAutoroute = () => {
    sendClientEvent({ type: 'room.autoroute', payload: { roomId: room.id, enabled: !autorouteEnabled } });
    // Menu stays open (unlike archive/reset) — this is a reversible setting a
    // human is likely to check/flip more than once per visit, not a
    // destructive one-shot action that should close on confirm.
  };

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setMenuOpen(false);
      setConfirmArchive(false);
      setConfirmReset(false);
      setEditingMembers(false);
      setPickingProject(false);
      setEditingLoop(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  const commitRename = () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name.length > 60 || name === room.name) return;
    sendClientEvent({ type: 'room.rename', payload: { roomId: room.id, name } });
  };

  const archive = () => {
    setMenuOpen(false);
    setConfirmArchive(false);
    sendClientEvent({ type: 'room.archive', payload: { roomId: room.id } });
  };

  const openMembers = () => {
    setMemberDraft(new Set(room.memberIds));
    setEditingMembers(true);
  };

  const toggleMemberDraft = (id: string) =>
    setMemberDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const saveMembers = () => {
    setMenuOpen(false);
    setEditingMembers(false);
    // Full replacement per the room.members contract. The gateway filters the
    // list to known agents; relay keeps delivering only to VERIFIED members.
    sendClientEvent({
      type: 'room.members',
      payload: { roomId: room.id, memberIds: Array.from(memberDraft) },
    });
  };

  const resetQuad = () => {
    setMenuOpen(false);
    setConfirmReset(false);
    // room.rollover is a gateway-local extension of the frozen shared
    // ClientEvent union — identical envelope
    // shape, typed at the two endpoints instead of packages/shared.
    sendClientEvent({
      type: 'room.rollover',
      payload: { roomId: room.id },
    } as unknown as ClientEvent);
  };

  const pickProject = (projectId: string | null) => {
    setMenuOpen(false);
    setPickingProject(false);
    // room.set-project is a gateway-local extension of the frozen shared
    // ClientEvent union (Milestone E, slimmed) — same endpoint-typed-cast
    // idiom as room.rollover/room.autoroute above.
    sendClientEvent({
      type: 'room.set-project',
      payload: { roomId: room.id, projectId },
    } as unknown as ClientEvent);
  };

  if (renaming) {
    return (
      <div className={`room ${active ? 'active' : ''}`}>
        <span className="h">{room.type === 'agent-agent' ? '⇄' : '#'}</span>
        {/* Enter saves, Escape/blur cancels — the gateway enforces the name rules. */}
        <input
          autoFocus
          className="room-rename-input"
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={() => setRenaming(false)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div
      className={`room ${active ? 'active' : ''}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setConfirmArchive(false);
        setConfirmReset(false);
        setMenuOpen(true);
      }}
    >
      <span className="h">{room.type === 'agent-agent' ? '⇄' : '#'}</span>
      <span className="room-name">{room.name}</span>
      {unread > 0 && <span className="unread-badge">{unread}</span>}
      <button
        type="button"
        className="room-kebab"
        title="Room options"
        onClick={(e) => {
          e.stopPropagation();
          setConfirmArchive(false);
          setConfirmReset(false);
          setMenuOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {menuOpen && isQuad && (
        <div className="room-menu" onClick={(e) => e.stopPropagation()}>
          {confirmReset ? (
            <>
              <div className="room-menu-label">
                Reset the Lobby? Today’s chat is kept as an archived daily.
              </div>
              <button type="button" className="room-menu-item danger" onClick={resetQuad}>
                Reset
              </button>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setConfirmReset(false);
                  setMenuOpen(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="room-menu-item"
                onClick={toggleAutoroute}
              >
                Autoroute: {autorouteEnabled ? 'ON' : 'OFF'}
              </button>
              {ttsSupported && (
                <button type="button" className="room-menu-item" onClick={() => toggleAutoRead(room.id)}>
                  Auto-read: {autoReadEnabled ? 'ON' : 'OFF'}
                </button>
              )}
              <button
                type="button"
                className="room-menu-item danger"
                onClick={() => setConfirmReset(true)}
              >
                Reset Lobby
              </button>
            </>
          )}
        </div>
      )}
      {menuOpen && !isQuad && (
        <div className={`room-menu${editingMembers || editingLoop ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
          {confirmArchive ? (
            <>
              <div className="room-menu-label">Archive “{room.name}”?</div>
              <button type="button" className="room-menu-item danger" onClick={archive}>
                Archive
              </button>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setConfirmArchive(false);
                  setMenuOpen(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : editingMembers ? (
            <>
              <div className="room-menu-label">Members of “{room.name}”</div>
              <MemberChecklist selected={memberDraft} onToggle={toggleMemberDraft} />
              <button type="button" className="room-menu-item" onClick={saveMembers}>
                Save members
              </button>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setEditingMembers(false);
                  setMenuOpen(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : pickingProject ? (
            <>
              <div className="room-menu-label">Move “{room.name}” to…</div>
              <ProjectPicker currentProjectId={currentProjectId} onPick={pickProject} />
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setPickingProject(false);
                  setMenuOpen(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : editingLoop ? (
            <LoopPanel
              room={room}
              onClose={() => {
                setEditingLoop(false);
                setMenuOpen(false);
              }}
            />
          ) : (
            <>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setDraft(room.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button type="button" className="room-menu-item" onClick={openMembers}>
                Members…
              </button>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => setPickingProject(true)}
              >
                Project →
              </button>
              <button
                type="button"
                className="room-menu-item"
                onClick={toggleAutoroute}
              >
                Autoroute: {autorouteEnabled ? 'ON' : 'OFF'}
              </button>
              {ttsSupported && (
                <button type="button" className="room-menu-item" onClick={() => toggleAutoRead(room.id)}>
                  Auto-read: {autoReadEnabled ? 'ON' : 'OFF'}
                </button>
              )}
              <button type="button" className="room-menu-item" onClick={() => setEditingLoop(true)}>
                Loop…
              </button>
              <button
                type="button"
                className="room-menu-item danger"
                onClick={() => setConfirmArchive(true)}
              >
                Archive
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible project group header: click toggles the room list below it;
 * kebab (or double-click the name) → Rename / Delete. Collapse state is
 * local, same ad-hoc useState pattern RoomRow already uses for its own
 * per-row toggles — a project's collapsed-ness isn't gateway state.
 */
function ProjectGroupHeader({
  project,
  collapsed,
  onToggleCollapsed,
}: {
  project: { id: string; name: string };
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setMenuOpen(false);
      setConfirmDelete(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  const commitRename = () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name.length > 60 || name === project.name) return;
    sendClientEvent({
      type: 'project.rename',
      payload: { projectId: project.id, name },
    } as unknown as ClientEvent);
  };

  const del = () => {
    setMenuOpen(false);
    setConfirmDelete(false);
    // Gateway unassigns (not reassigns) every room pointed at this project —
    // they fall back to Unsorted, same as clearing archivedAt does for
    // un-archive: absence of the key IS the default state.
    sendClientEvent({
      type: 'project.delete',
      payload: { projectId: project.id },
    } as unknown as ClientEvent);
  };

  if (renaming) {
    return (
      <div className="sect sect-row project-group-header">
        <input
          autoFocus
          className="room-rename-input"
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={() => setRenaming(false)}
        />
      </div>
    );
  }

  return (
    <div className="sect sect-row project-group-header" style={{ position: 'relative' }}>
      <span
        onClick={onToggleCollapsed}
        onDoubleClick={() => {
          setDraft(project.name);
          setRenaming(true);
        }}
        style={{ cursor: 'pointer', flex: 1 }}
        title="Click to collapse/expand, double-click to rename"
      >
        <span className="project-collapse-caret">{collapsed ? '▶' : '▼'}</span> {project.name}
      </span>
      <button
        type="button"
        className="room-kebab project-kebab"
        title="Project options"
        onClick={(e) => {
          e.stopPropagation();
          setConfirmDelete(false);
          setMenuOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="room-menu" onClick={(e) => e.stopPropagation()}>
          {confirmDelete ? (
            <>
              <div className="room-menu-label">
                Delete “{project.name}”? Its rooms become Unsorted.
              </div>
              <button type="button" className="room-menu-item danger" onClick={del}>
                Delete
              </button>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setConfirmDelete(false);
                  setMenuOpen(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="room-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setDraft(project.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="room-menu-item danger"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One row in the collapsible "Archived" section: name + Un-archive. Archived
 * rooms are never clickable into a chat view (they're not in the active
 * `rooms` list at all) — Un-archive is the only affordance. Keyed by
 * room.id, never grouped/deduped by name: a documented pre-existing bug
 * can produce two archived
 * rooms with an identical display name and distinct ids, and this is the
 * first UI surface that ever renders that state to a human.
 */
function ArchivedRoomRow({ room }: { room: Room }) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const unarchive = () => {
    sendClientEvent({
      type: 'room.unarchive',
      payload: { roomId: room.id },
    } as unknown as ClientEvent);
  };
  return (
    <div className="room archived-room">
      <span className="h">{room.type === 'agent-agent' ? '⇄' : '#'}</span>
      <span className="room-name">{room.name}</span>
      <button type="button" className="unarchive-btn" onClick={unarchive}>
        Un-archive
      </button>
    </div>
  );
}

export function Sidebar() {
  const {
    agents,
    rooms,
    activeRoomId,
    unreadByRoom,
    sidebarCollapsed,
    setActiveRoom,
    toggleSidebar,
    projects,
    projectAssignments,
    archivedRooms,
    ephemeral,
  } = useStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const toggleProjectCollapsed = (projectId: string) =>
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  if (sidebarCollapsed) {
    return (
      <div className="sidebar collapsed" onClick={toggleSidebar} title="Expand sidebar (Ctrl+\)">
        <div className="collapse-handle">▶</div>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        {/* Stacked crest-above-title brand mark — the one place the mark renders. */}
        <div className="sidebar-brand-mark">
          <svg
            className="sidebar-brand-crest"
            viewBox="0 0 44 52"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M3 5 L41 5 L41 25 C41 37 33 45.5 22 49.5 C11 45.5 3 37 3 25 Z"
              fill="var(--accent-gold)"
            />
            <path
              d="M5.3 7 L38.7 7 L38.7 24.3 C38.7 34.8 31.5 42.2 22 46 C12.5 42.2 5.3 34.8 5.3 24.3 Z"
              fill="var(--accent-green)"
              stroke="var(--accent-gold)"
              strokeWidth="0.6"
            />
            <circle cx="22" cy="16" r="6" fill="var(--accent-gold)" />
            <circle cx="16.5" cy="19.5" r="4.8" fill="var(--accent-gold)" />
            <circle cx="27.5" cy="19.5" r="4.8" fill="var(--accent-gold)" />
            <circle cx="22" cy="21.5" r="5.6" fill="var(--accent-gold)" />
            <rect x="20.6" y="21" width="2.8" height="9" fill="var(--accent-gold)" />
            <path d="M9 30 L35 30" stroke="var(--accent-gold)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M11 35 L33 35" stroke="var(--accent-gold)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M15 40 L29 40" stroke="var(--accent-gold)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="sidebar-brand-word">
            <span className="sidebar-brand-word-small">AI</span>
            <span className="sidebar-brand-word-large">Agent OS</span>
          </span>
        </div>
      </div>

      <div className="sect sect-row">
        ROOMS
        {/* Uniform control style for both create actions: same class, same size, explicit labels + tooltips. */}
        <span className="sect-add-group">
          <button
            type="button"
            className="sect-add-btn"
            title="+ Project — create a new project"
            onClick={() => setCreateProjectOpen((v) => !v)}
          >
            + Project
          </button>
          <button
            type="button"
            className="sect-add-btn"
            title="+ Room — create a new room"
            onClick={() => setCreateOpen((v) => !v)}
          >
            + Room
          </button>
        </span>
      </div>
      {createProjectOpen && <ProjectCreateDialog onClose={() => setCreateProjectOpen(false)} />}
      {createOpen && <RoomCreateDialog onClose={() => setCreateOpen(false)} />}
      {rooms.length === 0 ? (
        <div className="empty-hint">No rooms yet.</div>
      ) : projects.length === 0 ? (
        // No projects exist yet: flat list, exactly as before this feature —
        // "Unsorted" is a UI label that only appears once a real project
        // exists, never a stored project of its own.
        rooms.map((room) => (
          <RoomRow
            key={room.id}
            room={room}
            active={room.id === activeRoomId}
            unread={unreadByRoom.get(room.id) ?? 0}
            onSelect={() => setActiveRoom(room.id)}
          />
        ))
      ) : (
        <>
          {projects.map((project) => {
            const projectRooms = rooms.filter((r) => projectAssignments.get(r.id) === project.id);
            const collapsed = collapsedProjects.has(project.id);
            return (
              <div key={project.id}>
                <ProjectGroupHeader
                  project={project}
                  collapsed={collapsed}
                  onToggleCollapsed={() => toggleProjectCollapsed(project.id)}
                />
                {!collapsed &&
                  (projectRooms.length === 0 ? (
                    <div className="empty-hint">No rooms yet.</div>
                  ) : (
                    projectRooms.map((room) => (
                      <RoomRow
                        key={room.id}
                        room={room}
                        active={room.id === activeRoomId}
                        unread={unreadByRoom.get(room.id) ?? 0}
                        onSelect={() => setActiveRoom(room.id)}
                      />
                    ))
                  ))}
              </div>
            );
          })}
          {(() => {
            const unsortedRooms = rooms.filter((r) => !projectAssignments.has(r.id));
            // Only shown once at least one real project exists.
            return (
              <div>
                <div className="sect">UNSORTED</div>
                {unsortedRooms.length === 0 ? (
                  <div className="empty-hint">No unsorted rooms.</div>
                ) : (
                  unsortedRooms.map((room) => (
                    <RoomRow
                      key={room.id}
                      room={room}
                      active={room.id === activeRoomId}
                      unread={unreadByRoom.get(room.id) ?? 0}
                      onSelect={() => setActiveRoom(room.id)}
                    />
                  ))
                )}
              </div>
            );
          })()}
        </>
      )}

      <div className="sect sect-row">
        ARCHIVED
        <button
          type="button"
          className="sect-add"
          title={archivedCollapsed ? 'Expand' : 'Collapse'}
          onClick={() => setArchivedCollapsed((v) => !v)}
        >
          {archivedCollapsed ? '▶' : '▼'}
        </button>
      </div>
      {!archivedCollapsed &&
        (archivedRooms.length === 0 ? (
          <div className="empty-hint">No archived rooms.</div>
        ) : (
          archivedRooms.map((room) => <ArchivedRoomRow key={room.id} room={room} />)
        ))}

      <div className="sect sect-row">
        AGENTS
        <span className="sect-add-group">
          <button
            type="button"
            className="sect-add-btn"
            title="Connect ChatGPT, Claude, Grok, Cursor, Hermes or any model API"
            onClick={() => setAddAgentOpen((v) => !v)}
          >
            {addAgentOpen ? 'Close' : '+ Add agent'}
          </button>
        </span>
      </div>
      {addAgentOpen && <AddAgentPanel onClose={() => setAddAgentOpen(false)} />}
      {agents.length === 0 && !addAgentOpen ? (
        <div className="empty-hint">
          No agents yet.{' '}
          <button type="button" className="link-btn" onClick={() => setAddAgentOpen(true)}>
            Add your first one
          </button>{' '}
          — ChatGPT, Claude, Grok, Cursor, Hermes or any model API.
        </div>
      ) : (
        agents.map((agent) => <AgentSidebarRow key={agent.id} agent={agent} />)
      )}

      {/* TEMP-agent "on duty" section (2026-08-02, Agents\temp\ presence
          surface) — renders ONLY when something is actually running, no
          empty-state clutter the rest of the day. Deliberately separate from
          the AGENTS block above: these are not seats (see gateway's
          ephemeral.ts module doc comment for why). */}
      {ephemeral.length > 0 && (
        <>
          <div className="sect">ON DUTY — TEMP</div>
          {ephemeral.map((entry) => (
            <EphemeralSidebarRow key={entry.id} entry={entry} />
          ))}
        </>
      )}

      <StudioDock />

      <div style={{ flex: 1 }} />

      <div className="agent self-row">
        <div className="av" style={{ background: 'rgba(30,122,87,.25)' }}>
          ☺
        </div>
        You
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--faint)' }}>you</span>
      </div>
    </div>
  );
}
