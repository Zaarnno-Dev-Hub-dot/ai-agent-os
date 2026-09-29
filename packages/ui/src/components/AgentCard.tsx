import { useState } from 'react';
import { AgentStatus, AgentSummary, ClientEvent } from '@agent-os/shared';
import { useStore } from '../store/gatewayStore';
import { getHumanToken } from '../lib/reviewPolicy';

interface StatusStyle {
  bg: string;
  border: string;
  text: string;
}

/**
 * Model vocabulary per harness — kept in sync manually with the gateway's server-side
 * allowlist (packages/gateway/src/modelVocab.ts; this file cannot import it
 * across the UI/gateway package boundary, same reason connect-agent.mjs
 * duplicates deriveSeatId). Gated on `harness` rather than manifest.cliCommand:
 * AgentSummary (the wire-safe projection the UI actually receives —
 * packages/shared is frozen) has no cliCommand field, but harness is an
 * equivalent, already exposed signal — exactly the two harnesses with
 * cliCommand also have their own name as their harness value. One list per
 * MANIFEST, not per seat — every seat of a harness (main or #instance, e.g.
 * grok-build#fast) offers the same model options. grok-build entries verified
 * live 2026-07-08 via `grok models` (CLI 0.2.91).
 */
const MODEL_OPTIONS_BY_MANIFEST: Record<string, string[]> = {
  // 'claude-fable-5' added 2026-07-11 alongside the claude-code#advisor
  // advisor seat — kept in sync with packages/gateway/src/modelVocab.ts.
  // 'claude-opus-5:<effort>' composites (2026-08-08) drive --model + --effort
  // from this one picker — mirrors gateway/modelVocab.ts's list exactly.
  'claude-code': [
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-5:low',
    'claude-opus-5:medium',
    'claude-opus-5:high',
    'claude-opus-5:xhigh',
    'claude-opus-5:max',
  ],
  'grok-build': ['grok-composer-2.5-fast', 'grok-4.5'],
  // Codex (2026-08-08): COMPOSITE '<model>:<effort>' values — the codex
  // adapter splits them back apart, which is how one picker drives both tier
  // and reasoning effort. Mirrors gateway/modelVocab.ts's `codex` list exactly.
  codex: [
    'gpt-5.6-sol:low',
    'gpt-5.6-sol:medium',
    'gpt-5.6-sol:high',
    'gpt-5.6-luna:low',
    'gpt-5.6-luna:medium',
    'gpt-5.6-luna:high',
    'gpt-5.6-terra:low',
    'gpt-5.6-terra:medium',
    'gpt-5.6-terra:high',
  ],
  // OpenCode (2026-08-12): bare verified ids only. Mirrors
  // gateway/modelVocab.ts's `opencode` list exactly. Keyed by manifest id
  // so this list is NOT offered to other 'homebrew' seats (ollama/codex).
  opencode: [
    'opencode/big-pickle',
    'opencode/deepseek-v4-flash-free',
    'opencode/laguna-s-2.1-free',
    'opencode/ling-3.0-tiny-free',
    'opencode/mimo-v2.5-free',
    'opencode/nemotron-3-ultra-free',
  ],
  // Cursor (2026-08-26): mirrors gateway/modelVocab.ts `cursor` list.
  cursor: [
    'auto',
    'composer-1.5',
    'composer-1',
    'gpt-5.1-codex-mini',
    'sonnet-4.5',
    'sonnet-4.5-thinking',
    'opus-4.5',
    'opus-4.5-thinking',
    'grok',
  ],
};

/**
 * Seat id -> manifest id. Seat ids are `manifestId` or `manifestId#instanceId`
 *, so the prefix IS the manifest id.
 *
 * Keyed on this rather than `harness` (which is what this map used until
 * 2026-08-08) because the codex seat has to declare `harness: 'homebrew'` —
 * packages/shared's harness union is frozen and has no 'codex' member — and
 * so does ollama. Keying by harness would have offered Codex's model list to
 * the Ollama seats, which the gateway would then reject server-side: a
 * dropdown showing options that cannot be selected is exactly the
 * painted-status mismatch the comment below guards against.
 */
function manifestIdOf(agent: AgentSummary): string {
  return agent.id.split('#')[0];
}

/** 'gpt-5.6-terra:high' -> 'gpt-5.6-terra · high'; bare ids pass through. */
function modelOptionLabel(value: string): string {
  const idx = value.lastIndexOf(':');
  return idx > 0 ? `${value.slice(0, idx)} · ${value.slice(idx + 1)}` : value;
}

/**
 * Model select for seats whose adapter supports agent.set-model
 * (claude-code, grok-build); a fixed-model label for every other harness
 *. The
 * current value is agent.health.modelId (self-reported from inside the
 * session, same field the read-only Model row already showed) — falls back
 * to the first listed option only when there's no live health report yet
 * (e.g. immediately after connect, before the first proof-of-life echo).
 */
export function ModelPicker({ agent }: { agent: AgentSummary }) {
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const options = MODEL_OPTIONS_BY_MANIFEST[manifestIdOf(agent)];

  if (!options) {
    return <span className="v">{agent.health?.modelId ?? '—'}</span>;
  }

  const current = agent.health?.modelId ?? options[0];
  // The picker always includes the CURRENT modelId even if it's not one of
  // the two listed values (e.g. still on the CLI's account default before
  // any agent.set-model call) — an option list that silently omits the
  // agent's real current value would be a painted-status mismatch the
  // moment the dropdown is opened.
  const selectOptions = options.includes(current) ? options : [current, ...options];

  return (
    <select
      className="model-select"
      value={current}
      onChange={(e) => sendClientEvent({ type: 'agent.set-model', payload: { agentId: agent.id, model: e.target.value } })}
      onClick={(e) => e.stopPropagation()}
      title="Change this seat's pinned model — takes effect next turn"
    >
      {selectOptions.map((m) => (
        <option key={m} value={m}>
          {modelOptionLabel(m)}
        </option>
      ))}
    </select>
  );
}

const STATUS_STYLES: Record<AgentStatus, StatusStyle> = {
  VERIFIED: { bg: 'rgba(63,185,80,.1)', border: 'rgba(63,185,80,.35)', text: '#3fb950' },
  CHALLENGED: { bg: 'rgba(210,153,34,.1)', border: 'rgba(210,153,34,.35)', text: '#d29922' },
  OFFLINE: { bg: 'var(--panel2)', border: 'var(--line)', text: 'var(--faint)' },
  FAILED: { bg: 'rgba(248,81,73,.1)', border: 'rgba(248,81,73,.4)', text: '#f85149' },
  STALE: { bg: 'rgba(210,153,34,.1)', border: 'rgba(210,153,34,.35)', text: '#d29922' },
  CONNECTING: { bg: 'rgba(210,153,34,.1)', border: 'rgba(210,153,34,.35)', text: '#d29922' },
  REGISTERED: { bg: 'var(--panel2)', border: 'var(--line)', text: 'var(--faint)' },
};

/** VERIFIED style, but amber — for attested-tier seats (see isAttestedSeat below), so the badge reads as a distinct tier at a glance rather than the full-tier green. */
const ATTESTED_STYLE: StatusStyle = { bg: 'rgba(210,153,34,.1)', border: 'rgba(210,153,34,.35)', text: '#d29922' };

/**
 * True when `agent`'s manifest declared the tool-less attested verification
 * tier. AgentSummary has no field
 * for this — packages/shared is frozen — so it rides state.sync as an
 * additive per-agent key (gateway/index.ts buildStateSync) and is read here
 * via the same endpoint-typed cast as every other additive field in this
 * repo (room.rollover precedent). Status vocabulary itself is unchanged
 * (the seat really is AgentStatus 'VERIFIED') — this only picks the label/
 * color the badge renders.
 */
function isAttestedSeat(agent: AgentSummary): boolean {
  return (agent as AgentSummary & { verificationBadge?: string }).verificationBadge === 'ATTESTED';
}

function heartbeatLabel(lastHeartbeat: number): string {
  if (!lastHeartbeat) return 'never';
  const deltaMs = Date.now() - lastHeartbeat;
  if (deltaMs < 5000) return 'just now';
  if (deltaMs < 60000) return `${Math.round(deltaMs / 1000)}s ago`;
  if (deltaMs < 3600000) return `${Math.round(deltaMs / 60000)}m ago`;
  return `${Math.round(deltaMs / 3600000)}h ago`;
}

/** Compact sidebar row form of the agent card (mockup 01). */
export function AgentSidebarRow({ agent }: { agent: AgentSummary }) {
  const setInspectAgent = useStore((s) => s.setInspectAgent);
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const saved = useStore((s) => s.savedAgentIds.includes(agent.id));
  const [confirmRemove, setConfirmRemove] = useState(false);

  // "Remove": disconnects the seat (if live), forgets it if it was saved, and
  // drops it from the list. `forget` + humanToken ride as additive fields on
  // the frozen agent.disconnect payload (gateway index.ts).
  const remove = () => {
    sendClientEvent({
      type: 'agent.disconnect',
      payload: { agentId: agent.id, forget: true, humanToken: getHumanToken() },
    } as unknown as ClientEvent);
    setConfirmRemove(false);
  };
  const attested = isAttestedSeat(agent);
  const style = STATUS_STYLES[agent.status] ?? STATUS_STYLES.OFFLINE;
  const badgeLabel =
    agent.status === 'VERIFIED'
      ? attested
        ? 'ATTESTED'
        : 'VERIFIED'
      : agent.status === 'FAILED'
        ? 'FAILED'
        : agent.status === 'OFFLINE' || agent.status === 'REGISTERED'
          ? agent.status
          : agent.status; // CHALLENGED / CONNECTING / STALE shown as-is

  // Attested VERIFIED seats get their own amber badge — distinct at a glance
  // from the green full-tier VERIFIED badge.
  const badgeClass = agent.status !== 'VERIFIED' ? 'obadge' : attested ? 'abadge' : 'vbadge';

  return (
    <div
      className="agent"
      onClick={() => setInspectAgent(agent.id)}
      title={`${agent.displayName} — ${agent.status}${attested ? ' (attested)' : ''}${agent.statusReason ? ': ' + agent.statusReason : ''}`}
    >
      <div className="av" style={{ background: `${agent.color}33` }}>
        {agent.avatar}
      </div>
      {agent.displayName}
      <span className={badgeClass} style={badgeClass === 'obadge' ? { color: style.text, borderColor: style.border } : undefined}>
        {badgeLabel}
      </span>
      {confirmRemove ? (
        <span className="agent-remove-confirm" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="agent-remove-yes" onClick={remove}>
            Remove
          </button>
          <button type="button" className="agent-remove-no" onClick={() => setConfirmRemove(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="agent-remove"
          title={saved ? 'Remove this agent (also forgets it)' : 'Remove this agent'}
          onClick={(e) => {
            e.stopPropagation();
            setConfirmRemove(true);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Full dashboard card form (mockup 03) — for the classic dashboard / fleet view. */
export function AgentCard({ agent }: { agent: AgentSummary }) {
  const setInspectAgent = useStore((s) => s.setInspectAgent);
  const attested = isAttestedSeat(agent);
  const style = agent.status === 'VERIFIED' && attested ? ATTESTED_STYLE : STATUS_STYLES[agent.status] ?? STATUS_STYLES.OFFLINE;
  const statusLabel = agent.status === 'VERIFIED' && attested ? 'ATTESTED' : agent.status;

  return (
    <div className="agent-card" style={{ borderColor: style.border }}>
      <div className="chead">
        <div className="cav" style={{ background: `${agent.color}30` }}>
          {agent.avatar}
        </div>
        <div>
          <div className="cname">{agent.displayName}</div>
          <div className="chns">
            {agent.harness} · {agent.flavor}
          </div>
        </div>
        <div className="status" style={{ borderColor: style.border, background: style.bg, color: style.text }}>
          <span className="sdot" style={{ background: style.text }} />
          {statusLabel}
        </div>
      </div>
      <div className="rows">
        <div className="row">
          <span className="k">Model</span>
          <ModelPicker agent={agent} />
        </div>
        <div className="row">
          <span className="k">Latency</span>
          <span className="v">
            <b>{agent.health?.latencyMs != null ? `${agent.health.latencyMs} ms` : '—'}</b>
          </span>
        </div>
        <div className="row">
          <span className="k">Heartbeat</span>
          <span className="v">{heartbeatLabel(agent.lastHeartbeat)}</span>
        </div>
        <div className="row">
          <span className="k">Trust</span>
          <span className="v" style={agent.trust === 'verify-outputs' ? { color: 'var(--warn)' } : undefined}>
            {agent.trust}
          </span>
        </div>
      </div>
      {agent.lastChallenge && (
        <div className="pol">
          <div className="pol-t">
            PROOF OF LIFE — {agent.lastChallenge.type} —{' '}
            {agent.lastChallenge.success ? 'passed' : `failed: ${agent.lastChallenge.error ?? 'unknown'}`}
            {' '}({agent.lastChallenge.latencyMs}ms)
          </div>
        </div>
      )}
      {agent.statusReason && agent.status === 'FAILED' && (
        <div className="diag">⚠ {agent.statusReason}</div>
      )}
      <div className="btn" onClick={() => setInspectAgent(agent.id)}>
        INSPECT
      </div>
    </div>
  );
}
