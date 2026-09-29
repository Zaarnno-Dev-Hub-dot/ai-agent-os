import type { AdapterManifest } from '@agent-os/shared';

/**
 * Grok Build ships two documented interfaces for external tools driving it as
 * a service: ACP (Agent Client Protocol) and a headless mode with
 * `streaming-json` output. This adapter implements the headless cli-stream
 * flavor (see index.ts / cliProcess.ts) —  for the
 * ACP-vs-headless spike notes and why cli-stream shipped first.
 *
 * trust: 'verify-outputs' per PRD §3.1 — the operator's observation that Grok Build
 * hallucinates more than the other harnesses. The UI badges its claims until
 * a human reviews them; this is a manifest-level flag, not a code workaround.
 */
/**
 * `source`: which
 * physical environment this seat's compute actually runs in. Same
 * frozen-shared-avoidance idiom as ollama/manifest.ts's
 * `AttestedAdapterManifest`/`verification` — see hermes/manifest.ts's doc
 * comment for the full rationale. grok-build and grok-build#fast are both
 * this SAME manifest, so both read the same static value here.
 */
export const grokBuildManifest: AdapterManifest & { source: string } = {
  id: 'grok-build',
  displayName: 'Grok Build',
  harness: 'grok-build',
  flavor: 'cli-stream',
  avatar: '⚡',
  color: '#1d9bf0',
  capabilities: ['cli-stream', 'file-tools', 'resume-session'],
  identity: {
    modelPattern: '^grok',
  },
  trust: 'verify-outputs',
  // SuperGrok subscription — no marginal per-token dollars; budgets bind on tokens.
  billing: { kind: 'subscription' },
  cliCommand: 'grok',
  manifestVersion: 1,
  source: 'This machine · grok CLI → xAI cloud',
};
