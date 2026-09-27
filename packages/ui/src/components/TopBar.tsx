import { useEffect, useState } from 'react';
import { useStore } from '../store/gatewayStore';
import { useVoiceStore } from '../store/voiceStore';
import { isTTSSupported } from '../lib/voice';
import { StatusDot } from './StatusDot';
import { formatTokenCount } from '../lib/tokens';

/**
 * Global voice/rate setting (docs/DESIGN-voice-v1.md "Output (TTS)" — "single
 * global setting (localStorage), default system voice"). A small local
 * popover rather than a full rail, since unlike Polls/Files/Memory/Inspect
 * this has no room-scoped content of its own — same open/close-on-outside-
 * click shape as Sidebar's room-kebab menus (RoomRow), reusing .room-menu.
 * Hidden entirely when TTS is unsupported — nothing here would do anything.
 */
function VoiceSettingsPill() {
  const rate = useVoiceStore((s) => s.rate);
  const voiceURI = useVoiceStore((s) => s.voiceURI);
  const setRate = useVoiceStore((s) => s.setRate);
  const setVoiceURI = useVoiceStore((s) => s.setVoiceURI);
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (!open || typeof speechSynthesis === 'undefined') return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    // Chromium loads the voice list asynchronously — this event fires once
    // it's actually populated (the first load() call above can legitimately
    // return an empty array on a fresh page load).
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  if (!isTTSSupported()) return null;

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="pill"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide voice settings' : 'Voice settings — read-aloud rate & voice'}
      >
        🔊 Voice
      </button>
      {open && (
        <div className="room-menu" style={{ minWidth: 220, padding: '10px' }}>
          <div className="room-menu-label">Voice settings</div>
          <label style={{ display: 'block', fontSize: 11.5, color: 'var(--faint)', marginBottom: 4 }}>
            Rate: {rate.toFixed(2)}x
          </label>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <label style={{ display: 'block', fontSize: 11.5, color: 'var(--faint)', margin: '8px 0 4px' }}>Voice</label>
          <select
            className="side-input"
            value={voiceURI ?? ''}
            onChange={(e) => setVoiceURI(e.target.value || null)}
          >
            <option value="">System default</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const {
    connected,
    agents,
    rooms,
    activeRoomId,
    budgetWarningByRoom,
    roomTokenTotals,
    sidebarCollapsed,
    toggleSidebar,
    inspectPanelOpen,
    toggleInspectPanel,
    filesRailOpen,
    toggleFilesRail,
    memoryRailOpen,
    toggleMemoryRail,
    memoryPinnedByRoom,
    pollsRailOpen,
    togglePollsRail,
    polls,
    sendClientEvent,
  } = useStore();
  const openPollCount = polls.filter((p) => p.status === 'open').length;
  const verifiedCount = agents.filter((a) => a.status === 'VERIFIED').length;
  const failedCount = agents.filter((a) => a.status === 'FAILED' || a.status === 'OFFLINE').length;
  const totalKnown = agents.length;
  const fleetHealthPct = totalKnown === 0 ? 0 : Math.round((verifiedCount / totalKnown) * 100);
  const room = rooms.find((r) => r.id === activeRoomId);
  const percent = room ? budgetWarningByRoom.get(room.id) ?? 0 : 0;
  const tokenCap = room?.budgetCap?.tokens;
  const totals = room ? roomTokenTotals.get(room.id) : undefined;
  const tokensUsed = (totals?.tokensIn ?? 0) + (totals?.tokensOut ?? 0);
  // cost > 0 is the api-billed proxy under the new cost.ts (estimateCostUsd
  // returns 0 for every non-'api' billing kind — see cost.ts) — this is
  // exactly the signal the docs spec calls for: USD only when it's real
  // money, never a painted $0.0000 for subscription/local agents.
  const spentUsd = totals?.estimatedCostUsd ?? 0;
  const fillPct = tokenCap ? Math.min(100, Math.max(percent, (tokensUsed / tokenCap) * 100)) : 0;
  // Pinned-notes chips (docs/DESIGN-memory-read.md): current room's pins,
  // derived client-side from every memory.note event's pinnedInRooms field
  // (see gatewayStore's memory.note handling) — no separate fetch needed.
  const pinnedHere = room ? memoryPinnedByRoom.get(room.id) : undefined;
  const pinnedEntries = pinnedHere ? Array.from(pinnedHere.entries()) : [];

  // Wake fleet: POST /api/fleet/wake reconnects every saved agent that is not VERIFIED.
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeHint, setWakeHint] = useState<string | null>(null);

  async function wakeFleet() {
    if (wakeBusy) return;
    setWakeBusy(true);
    setWakeHint('Reconnecting saved agents…');
    try {
      const res = await fetch('/api/fleet/wake', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        verified?: number;
        agentsTotal?: number;
        failed?: Array<{ id: string }>;
        saved?: number;
      };
      if (res.status === 409) {
        setWakeHint(body.message ?? 'Wake already in progress');
        return;
      }
      if (!res.ok) {
        setWakeHint(body.message ?? body.error ?? `Wake failed (HTTP ${res.status})`);
        return;
      }
      const failIds = (body.failed ?? []).map((f) => f.id).join(', ');
      const bits = [
        body.saved === 0 ? 'No saved agents yet — use + Add agent' : body.ok ? 'Fleet OK' : 'Fleet partial',
        typeof body.verified === 'number' && typeof body.agentsTotal === 'number'
          ? `${body.verified}/${body.agentsTotal} verified`
          : null,
        failIds ? `failed: ${failIds}` : null,
      ].filter(Boolean);
      setWakeHint(bits.join(' · ') || 'Wake finished');
    } catch (e) {
      setWakeHint(e instanceof Error ? e.message : 'Wake request failed');
    } finally {
      setWakeBusy(false);
      // Clear hint after a few seconds so the bar doesn't stay noisy.
      window.setTimeout(() => setWakeHint(null), 12_000);
    }
  }

  return (
    <div className="topbar">
      {/* Brand mark lives in the Sidebar header; the top bar is status-only. */}
      <div className="pill">
        <StatusDot status={connected ? 'VERIFIED' : 'OFFLINE'} />
        {connected ? 'Gateway connected' : 'Gateway offline'}
      </div>
      <div className="pill">
        {totalKnown === 0 ? 'No agents registered' : `${verifiedCount}/${totalKnown} agents verified`}
      </div>
      {totalKnown > 0 && <div className="pill">Fleet health {fleetHealthPct}%</div>}
      <button
        type="button"
        className="pill"
        onClick={wakeFleet}
        disabled={wakeBusy || !connected}
        title={
          wakeBusy
            ? 'Reconnecting saved agents…'
            : 'Wake fleet — reconnect every saved agent that is not verified'
        }
      >
        {wakeBusy ? '⏳ Waking…' : '⚡ Wake fleet'}
        {!wakeBusy && failedCount > 0 && <span className="pill-badge">{failedCount}</span>}
      </button>
      {wakeHint && (
        <div className="pill" title={wakeHint} style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {wakeHint}
        </div>
      )}
      {pinnedEntries.length > 0 && (
        <div className="pinned-chips" title={`Pinned vault notes for ${room?.name}`}>
          {pinnedEntries.map(([path, title]) => (
            <span key={path} className="pinned-chip">
              <span className="pinned-chip-title">{title}</span>
              <button
                type="button"
                className="pinned-chip-x"
                title="Unpin from this room"
                onClick={() =>
                  room && sendClientEvent({ type: 'memory.unpin-note', payload: { roomId: room.id, path } })
                }
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="spacer" />
      {room && (tokenCap != null || tokensUsed > 0) && (
        <div className="meter" title={`Room token budget for ${room.name}`}>
          <div className="lbl">
            <span>ROOM TOKENS — {room.name.toUpperCase()}</span>
            <span>
              {tokenCap != null
                ? `${formatTokenCount(tokensUsed)} / ${formatTokenCount(tokenCap)} tok`
                : `${formatTokenCount(tokensUsed)} tok`}
            </span>
          </div>
          {tokenCap != null && (
            <div className="bar">
              <div className="fill" style={{ width: `${fillPct}%` }} />
            </div>
          )}
          {/* USD only when it's real money (api-billed agents) — never a painted $0.0000. */}
          {spentUsd > 0 && <div className="meter-usd">${spentUsd.toFixed(2)} est.</div>}
        </div>
      )}
      <button
        className="pill"
        onClick={togglePollsRail}
        title={pollsRailOpen ? 'Hide polls rail' : 'Show polls rail — decisions waiting on you'}
      >
        🗳 Polls
        {openPollCount > 0 && <span className="pill-badge">{openPollCount}</span>}
      </button>
      <button
        className="pill"
        onClick={toggleFilesRail}
        title={filesRailOpen ? 'Hide files rail' : 'Show files rail'}
      >
        📎 Files
      </button>
      <button
        className="pill"
        onClick={toggleMemoryRail}
        title={memoryRailOpen ? 'Hide memory panel' : 'Show memory panel — search & pin vault notes'}
      >
        🧠 Memory
      </button>
      <button
        className="pill"
        onClick={toggleInspectPanel}
        title={inspectPanelOpen ? 'Hide inspect panel' : 'Show inspect panel'}
      >
        ⚙ Inspect
      </button>
      <VoiceSettingsPill />
      <button
        className="pill"
        onClick={toggleSidebar}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? '▶' : '◀'}
      </button>
    </div>
  );
}
