import type { AdapterManifest } from '@agent-os/shared';

/**
 * Model ids VERIFIED LIVE against this account 2026-08-08 by running
 * `codex exec -m <id> --json -s read-only "Reply with ONLY: OK"` for each and
 * confirming a real `agent_message` came back. An id that is not provisioned
 * fails loudly and cheaply — the CLI answers
 * "The '<id>' model is not supported when using Codex with a ChatGPT account"
 * — which is how this list was checked rather than assumed.
 *
 * These are the three "tier" names the operator switches between in the dash
 * (Sol / Luna / Terra). Adding a fourth is a one-line change here plus the
 * matching MODEL_VOCAB entry in packages/gateway/src/modelVocab.ts — verify it
 * with the same one-shot exec first; never add an id on the strength of a
 * changelog or a model's own say-so.
 */
export const CODEX_MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'] as const;

/**
 * Reasoning-effort values passed as `-c model_reasoning_effort="<value>"`.
 * VERIFIED LIVE 2026-08-08 the same way as the model ids above. `high` is also
 * what the operator's own ~/.codex/config.toml already pins, which is where this set
 * was first observed.
 */
export const CODEX_EFFORTS = ['low', 'medium', 'high'] as const;

/**
 * identity.modelPattern (fail-closed, same invariant as every other manifest).
 *
 * IMPORTANT, and deliberately weaker than it looks — read before trusting it:
 * `codex exec --json` (0.147.0-alpha.6.5) emits NO model field anywhere in its
 * event stream (verified live: thread.started / turn.started / item.* /
 * turn.completed all lack one). The only authoritative record of the model a
 * turn actually ran on lives in the rollout logs under ~/.codex/sessions/, and
 * this adapter deliberately DOES NOT read those: they contain full
 * conversation content, and parsing them would create a path for private
 * material to surface in dash surfaces. So identity for this seat is
 * CONFIG-PINNED (the model this adapter passes with `-m`) with the session's
 * own self-report allowed to override it when it looks like a real id — the
 * same self-report shape the claude-code adapter's fetchModelId() already
 * uses. What this pattern therefore buys is arg-injection defense and a
 * fail-closed check on `agent.set-model` values, NOT independent proof of
 * which model answered. The nonce-file proof (real tool use, real filesystem)
 * is unaffected and is the strong half of this seat's verification.
 */
export const CODEX_MODEL_PATTERN = '^(gpt-5|codex|gpt-5\\.6-(sol|luna|terra))';

export const codexManifest: AdapterManifest & { source: string } = {
  id: 'codex',
  displayName: 'Codex',
  // AdapterManifest['harness'] is a closed union — 'hermes' | 'claude-code' |
  // 'grok-build' | 'openclaw' | 'homebrew' — and packages/shared is FROZEN
  // (BUILDER_PROTOCOL rule 7). 'homebrew' is the documented escape hatch for
  // anything outside the four named harnesses (ollama uses it for the same
  // reason). Consequence to know about: relay.ts's CLI_HARNESSES check keys
  // off this field, so a 'homebrew' seat is treated as attachment-URL-only
  // even though this one genuinely has a filesystem. That is a known
  // limitation of not being able to widen the union, recorded in
  // docs/TECH-DEBT.md rather than worked around in the adapter.
  harness: 'homebrew',
  flavor: 'cli-stream',
  avatar: '◎',
  color: '#10a37f',
  // Honest capability set: this seat really does have file + shell tools
  // (verified live — it read a nonce file via its own PowerShell tool call).
  // Note this is what makes it INELIGIBLE for the attested tier by design:
  // gateway/agents.ts's manifestDeclaresTools fails closed on tools+attested.
  capabilities: ['cli-stream', 'file-tools', 'resume-session'],
  identity: {
    modelPattern: CODEX_MODEL_PATTERN,
  },
  trust: 'full',
  // ChatGPT-account auth (~/.codex/auth.json), NOT an OpenAI API key — proven
  // by the CLI's own refusal text on an unprovisioned model ("...when using
  // Codex with a ChatGPT account"). So there are no marginal per-token API
  // dollars to declare here; usage draws on the Codex plan allowance and
  // budgets bind on tokens, exactly like the claude-code seat.
  billing: { kind: 'subscription' },
  cliCommand: 'codex',
  manifestVersion: 1,
  source: 'This machine · Codex CLI → OpenAI',
};
