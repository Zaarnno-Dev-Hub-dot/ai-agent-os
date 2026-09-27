import type { AdapterManifest } from '@agent-os/shared';

/**
 * Model ids VERIFIED LIVE 2026-08-12 by running
 *   opencode run --format json -m <id> "Reply with ONLY: OK"
 * and confirming a `text` event came back with cost: 0.
 *
 * `opencode/longcat-2.0-free` is on `opencode models` but FAILED twice the
 * same day with `UnknownError / Unexpected server error` — it is NOT listed.
 * Do not add an id on the strength of the models list or a changelog.
 */
export const OPENCODE_MODEL_IDS = [
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/laguna-s-2.1-free',
  'opencode/ling-3.0-tiny-free',
  'opencode/mimo-v2.5-free',
  'opencode/nemotron-3-ultra-free',
] as const;

/**
 * identity.modelPattern (fail-closed).
 *
 * `opencode run --format json` emits NO model field in the live event stream
 * (verified 2026-08-12: step_start / text / step_finish / tool_use / error).
 * The session export (`opencode export <id>`) DOES carry info.model, but this
 * adapter does not read export files — they contain full conversation
 * content. Identity is therefore CONFIG-PINNED (the `-m` we pass) the same
 * way the Codex adapter is. This pattern is arg-injection defense and the
 * fail-closed check on `agent.set-model`, not independent proof of which
 * model answered. The nonce-file proof is the strong half.
 */
// Any `provider/model` id (opencode's own format). Charset-restricted so it
// doubles as an argument-injection guard for the --model flag.
export const OPENCODE_MODEL_PATTERN = '^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$';

export const opencodeManifest: AdapterManifest & { source: string } = {
  id: 'opencode',
  displayName: 'opencode',
  // AdapterManifest['harness'] is a closed union and packages/shared is
  // FROZEN. 'homebrew' is the documented escape hatch (codex + ollama).
  harness: 'homebrew',
  flavor: 'cli-stream',
  avatar: '⬡',
  color: '#F97316',
  // Honest capability set: file (tool:"read") + shell (tool:"bash") were
  // both watched work live 2026-08-12. That makes this seat INELIGIBLE for
  // the attested tier — gateway rejects tools+attested.
  capabilities: ['cli-stream', 'file-tools', 'resume-session'],
  identity: {
    modelPattern: OPENCODE_MODEL_PATTERN,
  },
  trust: 'full',
  // Hosted by the opencode zen catalog. Every verified 2026-08-12 call
  // reported cost: 0. `opencode providers list` showed 0 stored credentials
  // — these free ids answered anyway. Not 'api' (no cited rates, $0
  // observed). Not 'local' (not local weights). Token bar, no dollar line.
  billing: { kind: 'subscription' },
  cliCommand: 'opencode',
  manifestVersion: 1,
  source: 'This machine · opencode CLI',
};
