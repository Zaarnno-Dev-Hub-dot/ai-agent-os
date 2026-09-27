import type { AdapterManifest } from '@agent-os/shared';

/**
 * Model ids allowed for agent.set-model / the dash picker.
 *
 * `auto` is Cursor's documented default (Paperclip cursor-local adapter).
 * Other ids are common Cursor Agent catalog names from Paperclip's fallback
 * list — they are NOT live-verified on this laptop yet (auth blocked the
 * 2026-08-26 probe). Re-run `agent --list-models` once CURSOR_API_KEY works
 * and prune/add before treating any id as proven.
 */
export const CURSOR_MODEL_IDS = [
  'auto',
  'composer-1.5',
  'composer-1',
  'gpt-5.1-codex-mini',
  'sonnet-4.5',
  'sonnet-4.5-thinking',
  'opus-4.5',
  'opus-4.5-thinking',
  'grok',
] as const;

/**
 * Fail-closed identity.modelPattern — arg-injection defense + set-model check.
 * Anchored; never `.*`. Config-pinned model (stream may not always self-report).
 */
export const CURSOR_MODEL_PATTERN = '^[a-z0-9][a-z0-9._-]*$';

export const cursorManifest: AdapterManifest & { source: string } = {
  id: 'cursor',
  displayName: 'Cursor',
  // Closed harness union in frozen packages/shared — new vendor = homebrew.
  harness: 'homebrew',
  flavor: 'cli-stream',
  avatar: '▋',
  color: '#7C3AED',
  // FILE+SHELL claimed by agent --help ("Has access to all tools, including
  // write and shell"). Live watch deferred until auth clears; declare full
  // tier so nonce-file runs. If tools prove absent, demote — never fake.
  capabilities: ['cli-stream', 'file-tools', 'resume-session'],
  identity: {
    modelPattern: CURSOR_MODEL_PATTERN,
  },
  trust: 'full',
  // Plan / API key auth (CURSOR_API_KEY=crsr_…). Not per-token rates cited
  // here — subscription-shaped for budget UI (token bar, no dollar line).
  billing: { kind: 'subscription' },
  cliCommand: 'agent',
  manifestVersion: 1,
  source:
    'This machine · Cursor Agent CLI via WSL (cursor.com/install) → api2.cursor.sh',
};
