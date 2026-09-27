import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary } from '@agent-os/shared';
import { useStore } from '../store/gatewayStore';
import { formatTokenCount } from '../lib/tokens';
import { ModelPicker } from './AgentCard';
import { fetchDossier } from '../lib/dossiers';
import { renderDossierMarkdown } from '../lib/markdown';

/**
 * Which physical environment this seat's compute actually runs in (the operator-
 * directed 2026-07-18: "see WHICH ENVIRONMENT each agent is housed in").
 * AgentSummary has no field for this — packages/shared is frozen — so it
 * rides state.sync as an additive per-agent key (gateway/index.ts
 * buildStateSync) and is read here via the same endpoint-typed cast as every
 * other additive field in this repo (AgentCard.tsx's isAttestedSeat /
 * room.rollover precedent). Always present at the gateway (every manifest
 * declares a default); 'unknown' only covers a stale/pre-upgrade snapshot.
 */
function agentSource(agent: AgentSummary): string {
  return (agent as AgentSummary & { source?: string }).source ?? 'unknown';
}

type Tab = 'summary' | 'telemetry' | 'raw' | 'dossier';

/**
 * Agent Dossiers (Wave 7 stretch, M4, docs/DESIGN-agent-dossiers-surface.md):
 * one fetch's worth of state for a single seat's drawer. 'error' covers BOTH
 * "no dossier written yet" and "unknown seat" — the route 404s identically
 * for both (by design, see dossiers.ts) — so this tab renders one honest,
 * unalarming empty state for either, never a distinct "not found" vs "you
 * broke something" message it has no way to tell apart anyway.
 */
interface DossierState {
  status: 'loading' | 'loaded' | 'error';
  markdown?: string;
  mtime?: number;
}

export function InspectPanel() {
  const {
    inspectPanelOpen,
    inspectAgentId,
    agents,
    inspectFrames,
    agentTokenTotals,
    dossiersEnabled,
    toggleInspectPanel,
    setInspectAgent,
  } = useStore();
  const [tab, setTab] = useState<Tab>('summary');
  // Keyed by seatId. GET-only, no live-update wire event for this (design
  // doc: "acceptance freezes it") — fetched once per seat per panel
  // lifetime; requestedDossierAgents (a ref, not state) is the de-dupe guard
  // so the effect below can skip re-fetching without needing dossierByAgent
  // itself in its dependency array (a self-referential dep the effect also
  // writes to would still converge here, but this is the cleaner shape —
  // same eslint-disable precedent as MemoryRail.tsx's search effect).
  const [dossierByAgent, setDossierByAgent] = useState<Record<string, DossierState>>({});
  const requestedDossierAgents = useRef(new Set<string>());

  // ALL hooks run before any conditional return — the early return used to sit
  // above this useMemo, so opening the panel changed the hook count and React
  // threw, unmounting the whole app (blank screen, live incident 2026-07-06).
  const relevantFrames = useMemo(() => {
    if (!inspectAgentId) return inspectFrames;
    return inspectFrames.filter((f) => {
      const p = f.event.payload as Record<string, unknown> | undefined;
      return p && (p.agentId === inspectAgentId || p.senderId === inspectAgentId);
    });
  }, [inspectFrames, inspectAgentId]);

  // Agent Dossiers fetch (Wave 7 stretch, M4): fires once per seat, the
  // first time its Dossier tab is opened. Must run before the early return
  // below (same "all hooks before any conditional return" rule as the
  // useMemo above — see its doc comment for the live incident this guards
  // against).
  useEffect(() => {
    if (tab !== 'dossier' || !inspectAgentId || !dossiersEnabled) return;
    if (requestedDossierAgents.current.has(inspectAgentId)) return;
    requestedDossierAgents.current.add(inspectAgentId);
    setDossierByAgent((prev) => ({ ...prev, [inspectAgentId]: { status: 'loading' } }));
    fetchDossier(inspectAgentId)
      .then((res) => {
        setDossierByAgent((prev) => ({
          ...prev,
          [inspectAgentId]: { status: 'loaded', markdown: res.markdown, mtime: res.mtime },
        }));
      })
      .catch(() => {
        setDossierByAgent((prev) => ({ ...prev, [inspectAgentId]: { status: 'error' } }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, inspectAgentId, dossiersEnabled]);

  if (!inspectPanelOpen) return null;

  const agent = agents.find((a) => a.id === inspectAgentId) ?? null;
  const telemetry = inspectAgentId ? agentTokenTotals.get(inspectAgentId) : undefined;

  return (
    <div className="inspect-panel">
      <div className="inspect-header">
        <div className="inspect-title">
          Inspect {agent ? `— ${agent.displayName}` : '— all agents'}
        </div>
        <button className="cbtn" onClick={toggleInspectPanel} title="Close">
          ✕
        </button>
      </div>

      {agent && (
        <button className="inspect-clear-agent" onClick={() => setInspectAgent(null)}>
          Show all agents
        </button>
      )}

      <div className="inspect-tabs">
        <button className={tab === 'summary' ? 'inspect-tab active' : 'inspect-tab'} onClick={() => setTab('summary')}>
          Live events
        </button>
        {agent && (
          <button
            className={tab === 'telemetry' ? 'inspect-tab active' : 'inspect-tab'}
            onClick={() => setTab('telemetry')}
          >
            Telemetry
          </button>
        )}
        {agent && dossiersEnabled && (
          <button
            className={tab === 'dossier' ? 'inspect-tab active' : 'inspect-tab'}
            onClick={() => setTab('dossier')}
          >
            Dossier
          </button>
        )}
        <button className={tab === 'raw' ? 'inspect-tab active' : 'inspect-tab'} onClick={() => setTab('raw')}>
          Raw frames
        </button>
      </div>

      {agent && (
        <div className="inspect-agent-summary">
          <div className="row">
            <span className="k">Status</span>
            <span className="v">{agent.status}</span>
          </div>
          <div className="row">
            <span className="k">Source</span>
            <span className="v">{agentSource(agent)}</span>
          </div>
          <div className="row">
            <span className="k">Model</span>
            <ModelPicker agent={agent} />
          </div>
          <div className="row">
            <span className="k">Latency</span>
            <span className="v">{agent.health?.latencyMs != null ? `${agent.health.latencyMs} ms` : '—'}</span>
          </div>
          {agent.lastChallenge && (
            <div className="row">
              <span className="k">Last challenge</span>
              <span className="v">
                {agent.lastChallenge.type} · {agent.lastChallenge.success ? 'passed' : 'failed'}
              </span>
            </div>
          )}
        </div>
      )}

      {tab === 'telemetry' && agent && (
        <div className="inspect-telemetry">
          <div className="row">
            <span className="k">Tokens in</span>
            <span className="v">{formatTokenCount(telemetry?.tokensIn ?? 0)}</span>
          </div>
          <div className="row">
            <span className="k">Tokens out</span>
            <span className="v">{formatTokenCount(telemetry?.tokensOut ?? 0)}</span>
          </div>
          <div className="row">
            <span className="k">Latency</span>
            <span className="v">{agent.health?.latencyMs != null ? `${agent.health.latencyMs} ms` : '—'}</span>
          </div>
          {/* cost > 0 is the api-billed proxy under cost.ts's new billing-based
              estimateCostUsd — subscription/local agents always price at $0,
              so this line simply never renders for them (no $0.0000). */}
          {(telemetry?.estimatedCostUsd ?? 0) > 0 && (
            <div className="row">
              <span className="k">Est. cost</span>
              <span className="v">${telemetry!.estimatedCostUsd.toFixed(4)}</span>
            </div>
          )}

          <div className="inspect-telemetry-turns-hdr">Recent turns</div>
          {(!telemetry || telemetry.recentTurns.length === 0) && (
            <div className="empty-hint">No recorded turns yet for this agent.</div>
          )}
          {telemetry &&
            telemetry.recentTurns
              .slice()
              .reverse()
              .map((turn, i) => (
                <div key={`${turn.at}-${i}`} className="inspect-telemetry-turn">
                  <span className="frame-time">{new Date(turn.at).toLocaleTimeString()}</span>
                  <span>
                    {formatTokenCount(turn.tokensIn)} in / {formatTokenCount(turn.tokensOut)} out
                  </span>
                  {turn.costUsd > 0 && <span>${turn.costUsd.toFixed(4)}</span>}
                </div>
              ))}
        </div>
      )}

      {tab === 'dossier' && agent && dossiersEnabled && (
        <DossierTabContent state={dossierByAgent[agent.id]} />
      )}

      {(tab === 'summary' || tab === 'raw') && (
        <div className="inspect-frames">
          {relevantFrames.length === 0 && (
            <div className="empty-hint">No events yet for this scope.</div>
          )}
          {relevantFrames
            .slice()
            .reverse()
            .map((f) => (
              <div key={f.id} className={`frame frame-${f.direction}`}>
                <div className="frame-hdr">
                  <span className={`frame-dir ${f.direction}`}>{f.direction === 'in' ? '⬇' : '⬆'}</span>
                  <span className="frame-type">{f.event.type}</span>
                  <span className="frame-time">{new Date(f.at).toLocaleTimeString()}</span>
                </div>
                {tab === 'raw' && (
                  <pre className="frame-raw">{JSON.stringify(f.event.payload, null, 2)}</pre>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Agent Dossiers tab body (Wave 7 stretch, M4, docs/DESIGN-agent-dossiers-
 * surface.md). Renders through renderDossierMarkdown — the dossier-mode-
 * hardened pass (external img stripped, rel forced; see lib/markdown.ts),
 * never the plain chat renderMarkdown. Read-only: no edit affordance exists
 * here or anywhere in the dashboard (v1 acceptance freezes it).
 */
function DossierTabContent({ state }: { state: DossierState | undefined }) {
  if (!state || state.status === 'loading') {
    return (
      <div className="inspect-dossier">
        <div className="empty-hint">Loading dossier…</div>
      </div>
    );
  }
  if (state.status === 'error' || state.markdown == null) {
    return (
      <div className="inspect-dossier">
        <div className="empty-hint">No dossier for this seat yet.</div>
      </div>
    );
  }
  return (
    <div className="inspect-dossier">
      <div className="dossier-meta">
        Last updated {new Date(state.mtime!).toLocaleString()}
      </div>
      <div
        className="md-body dossier-body"
        dangerouslySetInnerHTML={{ __html: renderDossierMarkdown(state.markdown) }}
      />
    </div>
  );
}
