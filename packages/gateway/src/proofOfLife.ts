// proofOfLife.ts — periodic seat liveness sweep (2026-07-27, liveness workstream).
//
// WHY THIS FILE EXISTS: lastHeartbeat was stamped only by connectAgent()/
// disconnectAgent() (agents.ts) — no interval ever refreshed it, and isStale()
// in @agent-os/shared has zero production call sites — so every seat's
// lastHeartbeat froze at its connect time. Argus's 2-hour staleness backstop
// (Agents\Argus\argus.mjs, STALE_HEARTBEAT_MS) then flagged the whole fleet
// every ~2h between gateway restarts, its connect-seat repairs reset the clock,
// and its flap guard turned the cycle into the "stale-heartbeat flapping"
// escalations logged since 2026-07-25. This sweep makes lastHeartbeat mean what
// every consumer already assumes it means: "last proven sign of life."
//
// FROZEN-ZONE BOUNDARY: verifier.ts / relay.ts / @agent-os/shared are frozen.
// This is a parallel gateway-side file (same precedent as attestedVerifier.ts):
// it reuses each live session's own health() probe and touches only fields the
// gateway already owns (lastHeartbeat, health). It never flips status — status
// transitions remain the connect/verifier path's job. A seat whose probe fails
// keeps its old lastHeartbeat and goes honestly stale downstream.
//
// TIMEOUT GUARD: a stuck seat probe wedging an endpoint is known debt here
// (dash-watchdog probes /api/state instead of /health for exactly that reason,
// 2026-07-21) — every health() call is raced against a hard timeout so one
// stuck adapter can never wedge the sweep. Seats are probed sequentially on
// purpose: no process/connection storm on a 7-seat fleet, worst case is
// 7 × 15s per sweep, far inside the interval.
//
// G2b ACTIVITY PULL: same "gateway pulls from the session it owns" precedent as health
// above, via an optional AgentSession.activity(). Deliberately NOT a
// client-postable message on any WS: identity here is "which session the
// gateway itself chose to poll," so there is nothing for a foreign caller to
// spoof.
//
// SEPARATE timer from the health sweep, not folded into it (R4 correction —
// the original draft assumed a 20s poller existed to piggyback on; it doesn't,
// AgentSession.health()'s "gateway polls every 20s" docstring was stale, and
// this file's own SWEEP_INTERVAL_MS is 10 minutes. A verb sampled every 10
// minutes would miss nearly every real turn and the activity display would
// permanently show fallback text. Activity gets its own ~30s tick instead —
// same sequential-probe-with-timeout shape as sweepOnce, kept as a distinct
// function so a stuck activity() can never affect the health/lastHeartbeat
// result, and so this file's core liveness contract stays exactly as it was.

import { AgentState } from '@agent-os/shared';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // well under Argus's 2h backstop
const ACTIVITY_SWEEP_INTERVAL_MS = 30_000; // verbs go stale fast; health cadence is too slow for this
const HEALTH_TIMEOUT_MS = 15_000;
const ACTIVITY_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`health() timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function sweepOnce(
  agents: Map<string, AgentState>
): Promise<{ checked: number; ok: number }> {
  let checked = 0;
  let ok = 0;
  for (const [agentId, state] of agents) {
    if (!state.session || state.status !== 'VERIFIED') continue;
    checked += 1;
    try {
      const health = await withTimeout(state.session.health(), HEALTH_TIMEOUT_MS);
      state.health = health;
      if (health.ok) {
        state.lastHeartbeat = Date.now();
        ok += 1;
      }
    } catch (e) {
      console.error(
        `proof-of-life: ${agentId} health probe failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return { checked, ok };
}

export function startProofOfLifeSweep(agents: Map<string, AgentState>): NodeJS.Timeout {
  const timer = setInterval(() => {
    sweepOnce(agents).catch((e) => console.error('proof-of-life sweep failed', e));
  }, SWEEP_INTERVAL_MS);
  // A liveness timer must never be the thing keeping a dying process alive.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** G2b (R4): dedicated ~30s activity-only sweep — see file header for why this isn't folded into sweepOnce. */
export async function sweepActivityOnce(agents: Map<string, AgentState>): Promise<{ checked: number }> {
  let checked = 0;
  for (const [agentId, state] of agents) {
    if (!state.session || state.status !== 'VERIFIED' || !state.session.activity) continue;
    checked += 1;
    try {
      state.activity = await withTimeout(state.session.activity(), ACTIVITY_TIMEOUT_MS);
    } catch (e) {
      console.error(
        `proof-of-life: ${agentId} activity probe failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return { checked };
}

export function startActivitySweep(agents: Map<string, AgentState>): NodeJS.Timeout {
  const timer = setInterval(() => {
    sweepActivityOnce(agents).catch((e) => console.error('activity sweep failed', e));
  }, ACTIVITY_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
