import type { AdapterManifest } from '@agent-os/shared';

/**
 * `source`: which
 * physical environment this seat's compute actually runs in. Same
 * frozen-shared-avoidance idiom as ollama/manifest.ts's
 * `AttestedAdapterManifest`/`verification` — see hermes/manifest.ts's doc
 * comment for the full rationale. claude-code and claude-code#advisor are
 * both this SAME manifest (only displayName differs per seat, per
 * agents.ts's connectAgent), so both read the same static value here —
 * no per-instance override needed for today's roster.
 */
export const claudeCodeManifest: AdapterManifest & { source: string } = {
  id: 'claude-code',
  displayName: 'Claude Code',
  harness: 'claude-code',
  flavor: 'cli-stream',
  avatar: '✦',
  color: '#d97757',
  capabilities: ['cli-stream', 'file-tools', 'resume-session'],
  identity: {
    modelPattern: '^(claude|sonnet|opus|haiku|fable)',
  },
  trust: 'full',
  // Claude Max plan — no marginal per-token dollars; budgets bind on tokens.
  billing: { kind: 'subscription' },
  cliCommand: 'claude',
  manifestVersion: 1,
  source: 'This machine · Claude Code CLI → Anthropic cloud',
};
