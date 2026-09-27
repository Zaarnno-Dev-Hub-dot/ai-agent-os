import { useEffect, useMemo, useState } from 'react';
import type { ClientEvent } from '@agent-os/shared';
import { useStore } from '../store/gatewayStore';
import {
  AGENT_PRESETS,
  buildTransport,
  missingRequired,
  pickSeat,
  type AgentPreset,
} from '../lib/agentPresets';

/** Renders `code` spans in a setup step. */
function SetupStep({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <li>
      {parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </li>
  );
}

function PresetTile({ preset, onPick }: { preset: AgentPreset; onPick: () => void }) {
  return (
    <button type="button" className="preset-tile" onClick={onPick} title={preset.blurb}>
      <span className="av" style={{ background: `${preset.color}33` }}>
        {preset.avatar}
      </span>
      <span className="preset-name">{preset.name}</span>
    </button>
  );
}

interface Pending {
  seatId: string;
  at: number;
}

function AgentForm({ preset, onBack, onDone }: { preset: AgentPreset; onBack: () => void; onDone: () => void }) {
  const agents = useStore((s) => s.agents);
  const errorToast = useStore((s) => s.errorToast);
  const sendClientEvent = useStore((s) => s.sendClientEvent);
  const [name, setName] = useState(preset.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(preset.fields.map((f) => [f.key, f.defaultValue ?? '']))
  );
  const [remember, setRemember] = useState(true);
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);

  const agent = pending ? agents.find((a) => a.id === pending.seatId) : undefined;
  const connectError =
    pending && errorToast && errorToast.code === 'agent.connect' && errorToast.at >= pending.at ? errorToast.message : '';
  const busy = !!pending && !connectError && agent?.status !== 'VERIFIED' && agent?.status !== 'FAILED';

  useEffect(() => {
    if (agent?.status !== 'VERIFIED') return;
    const t = setTimeout(onDone, 1500);
    return () => clearTimeout(t);
  }, [agent?.status, onDone]);

  const connect = () => {
    const missing = missingRequired(preset, values);
    if (missing) {
      setFormError(`${missing.label} is required.`);
      return;
    }
    setFormError('');
    const label = name.trim() || preset.name;
    const { seatId, instanceId } = pickSeat(preset.manifestId, label, agents);
    const sent = sendClientEvent({
      type: 'agent.connect',
      payload: {
        manifestId: preset.manifestId,
        instanceId,
        instanceLabel: label,
        config: { transport: buildTransport(preset, values) },
        // Additive field read by the gateway (index.ts agent.connect).
        remember,
      },
    } as unknown as ClientEvent);
    if (!sent) {
      setFormError('Not connected to the gateway — is it running?');
      return;
    }
    setPending({ seatId, at: Date.now() });
  };

  return (
    <div className="add-agent-form">
      <button type="button" className="add-agent-back" onClick={onBack}>
        ← All agents
      </button>
      <div className="add-agent-title">
        <span className="av" style={{ background: `${preset.color}33` }}>
          {preset.avatar}
        </span>
        <div>
          <div className="preset-name">{preset.name}</div>
          <div className="add-agent-blurb">{preset.blurb}</div>
        </div>
      </div>
      <ol className="add-agent-setup">
        {preset.setup.map((step) => (
          <SetupStep key={step} text={step} />
        ))}
      </ol>
      {preset.quickFills && (
        <div className="quick-fills">
          {preset.quickFills.map((q) => (
            <button
              key={q.label}
              type="button"
              className="sect-add-btn"
              onClick={() => setValues((v) => ({ ...v, ...q.values }))}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      <label className="add-agent-label">
        Name
        <input className="side-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      {preset.fields.map((field) => (
        <div key={field.key}>
          <label className="add-agent-label">
            {field.label}
            <input
              className="side-input"
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
            />
          </label>
          {field.help && <div className="add-agent-help">{field.help}</div>}
        </div>
      ))}
      <label className="add-agent-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember — reconnect automatically when the gateway starts
      </label>
      <button type="button" className="side-connect-btn" disabled={busy} onClick={connect}>
        {busy ? 'Connecting…' : agent?.status === 'FAILED' || connectError ? 'Try again' : 'Connect'}
      </button>
      {formError && <div className="add-agent-error">{formError}</div>}
      {pending && !formError && (
        <div className="add-agent-status">
          {connectError ? (
            <span className="add-agent-error">{connectError}</span>
          ) : agent?.status === 'VERIFIED' ? (
            <span className="add-agent-ok">✓ Connected and verified — say hi in any room.</span>
          ) : agent?.status === 'FAILED' ? (
            <span className="add-agent-error">{agent.statusReason ?? 'Verification failed.'}</span>
          ) : (
            <span>Connecting and running the proof-of-life check… (CLI agents can take up to a minute)</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Sidebar "+ Add agent" flow: pick a preset, fill two or three fields, connect. */
export function AddAgentPanel({ onClose }: { onClose: () => void }) {
  const [presetId, setPresetId] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const preset = useMemo(() => AGENT_PRESETS.find((p) => p.id === presetId), [presetId]);

  if (preset) return <AgentForm preset={preset} onBack={() => setPresetId(null)} onDone={onClose} />;

  const main = AGENT_PRESETS.filter((p) => !p.more);
  const more = AGENT_PRESETS.filter((p) => p.more);
  return (
    <div className="add-agent">
      <div className="preset-grid">
        {main.map((p) => (
          <PresetTile key={p.id} preset={p} onPick={() => setPresetId(p.id)} />
        ))}
        {showMore && more.map((p) => <PresetTile key={p.id} preset={p} onPick={() => setPresetId(p.id)} />)}
      </div>
      <div className="add-agent-footer">
        {!showMore && more.length > 0 && (
          <button type="button" className="add-agent-back" onClick={() => setShowMore(true)}>
            More agents…
          </button>
        )}
        <a
          className="add-agent-back"
          href="https://github.com/Zaarnno-Dev-Hub-dot/ai-agent-os/blob/main/docs/ADDING-AGENTS.md"
          target="_blank"
          rel="noreferrer"
        >
          Bring your own →
        </a>
      </div>
    </div>
  );
}
