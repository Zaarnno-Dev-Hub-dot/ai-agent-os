/**
 * Live proof-of-life gate runner (`npm run gate [adapter-ids...]`).
 *
 * Connects each requested adapter through the REAL gateway path
 * (connectAgent -> adapter.connect -> ProofOfLifeVerifier.runFullChallenge)
 * and prints per-challenge results. No mocks, no shortcuts: a PASS here is
 * the same code path the gateway runs when the UI connects an agent.
 *
 * Defaults to the Phase 1 gate trio: hermes, claude-code, grok-build.
 */
import { join } from 'path';
import type { AdapterConfig, AgentState } from '@agent-os/shared';
import { resolveHermesAdapterConfig } from '@agent-os/adapters-hermes';
import { connectAgent } from '../packages/gateway/src/agents.js';

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ['hermes', 'claude-code', 'grok-build'];
const workspaceRoot = join(process.cwd(), 'data', 'workspaces');
const agents = new Map<string, AgentState>();

let allVerified = true;

for (const id of targets) {
  const t0 = Date.now();
  console.log(`\n=== ${id} ===`);
  try {
    let cfg: AdapterConfig = { transport: {}, workspace: join(workspaceRoot, id) };
    if (id === 'hermes') {
      cfg = await resolveHermesAdapterConfig(cfg);
    }
    const { agentId, status } = await connectAgent(id, cfg, agents, workspaceRoot);
    const state = agents.get(agentId);
    for (const r of state?.challengeHistory ?? []) {
      const line = `  ${r.type}: ${r.success ? 'PASS' : 'FAIL'} (${r.latencyMs}ms)`;
      console.log(r.error ? `${line} — ${r.error}` : line);
    }
    console.log(`  => ${status} in ${Date.now() - t0}ms`);
    if (status !== 'VERIFIED') allVerified = false;
  } catch (e) {
    allVerified = false;
    console.log(`  => CONNECT FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

for (const [, state] of agents) {
  await state.session?.dispose().catch(() => undefined);
}

console.log(`\nGATE ${allVerified ? 'PASS' : 'FAIL'} — ${targets.join(', ')}`);
process.exit(allVerified ? 0 : 1);
