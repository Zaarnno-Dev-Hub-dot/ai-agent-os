import type { AdapterManifest } from '@agent-os/shared';

/**
 * Verification-tier extension (docs/DESIGN-seat-verification-tiers.md).
 * packages/shared's AdapterManifest has no `verification` field — it is
 * FROZEN (BUILDER_PROTOCOL rule 7) — so the tier lives on a locally widened
 * type in this leaf adapter package instead. Anything reading `.verification`
 * off a plain `AdapterManifest`-typed value (gateway/agents.ts,
 * gateway/attestedVerifier.ts, gateway/index.ts's state.sync, the UI) casts
 * to this shape at the point of use. Same endpoint-typed-cast idiom already
 * used for room.rollover / state.sync additive fields elsewhere in this repo
 * (docs/TECH-DEBT.md "room.rollover is typed at the endpoints, not in
 * shared") — the object literal below satisfies this WIDER interface, not
 * AdapterManifest directly, so TypeScript's excess-property check never
 * fires; the value is still perfectly assignable to a plain
 * `AgentAdapter['manifest']: AdapterManifest` slot because it's a strict
 * superset.
 */
export interface AttestedAdapterManifest extends AdapterManifest {
  verification: 'attested';
  /**
   * `source`:
   * which physical environment this seat's compute actually runs in — same
   * frozen-shared-avoidance idiom as `verification` above, read at the
   * gateway via agents.ts's resolveAgentSource (same cast idiom as
   * attestedVerifier.ts's isAttestedManifest reads `verification`).
   */
  source: string;
}

/**
 * identity.modelPattern (fail-closed, same invariant as every other
 * manifest): matches only the two model tags this seat pair is provisioned
 * for (design doc "seats ollama#qwen + ollama#tiny"). Ollama's
 * /v1/chat/completions response echoes the requested tag verbatim in its
 * `model` field (verified read-only against the live reality-check endpoint
 * during this build), so anchoring on the family name with an optional
 * `:tag` suffix is tight without hardcoding the exact pulled tag string.
 * A model outside this pattern fails identity CLOSED, exactly like `full`.
 */
// Default for seats connected without a per-seat transport.modelPattern (the
// dashboard's Add agent panel always sets one from the model you type): any
// well-formed model id, charset-restricted.
export const OLLAMA_MODEL_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/-]*$';

export const ollamaManifest: AttestedAdapterManifest = {
  id: 'ollama',
  displayName: 'Model API',
  // AdapterManifest['harness'] is a closed union — 'hermes' | 'claude-code' |
  // 'grok-build' | 'openclaw' | 'homebrew' — with no 'ollama' member
  // (packages/shared frozen). 'homebrew' is the existing escape hatch for
  // anything outside the four named harnesses. Nothing gateway/UI-side
  // branches on 'homebrew' in a way that misfires for a tool-less
  // http-openai seat — relay.ts's CLI_HARNESSES check (the one place harness
  // gates behavior) treats any non-CLI harness as attachment-url-only, which
  // is exactly correct here (this transport has no filesystem to copy into).
  harness: 'homebrew',
  flavor: 'http-openai',
  avatar: '◈',
  color: '#6b8f71',
  // Deliberately no tool-ish capability strings (see gateway/agents.ts
  // manifestDeclaresTools, which fails CLOSED on manifests that declare
  // tools + attested). This is a bare completions endpoint: no file, shell,
  // or tool access — the whole reason it needs the attested tier at all.
  capabilities: ['http-openai', 'chat'],
  identity: {
    modelPattern: OLLAMA_MODEL_PATTERN,
  },
  trust: 'full',
  // No marginal per-token dollars — your own hardware, $0 tier
  // (design doc "Router/cost: attested Ollama seats are billing.kind:
  // 'local'").
  billing: { kind: 'local' },
  verification: 'attested',
  manifestVersion: 1,
  // ollama#qwen and ollama#tiny are both this SAME manifest, so both read
  // this same static value — no per-instance override needed for today's
  // roster (their seats-roster.json entries don't set config.transport.source).
  source: 'OpenAI-compatible HTTP endpoint',
};
