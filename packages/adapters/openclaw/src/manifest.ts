import type { AdapterManifest } from '@agent-os/shared';

/**
 * OpenClaw's model is user-configured per gateway install (docs.openclaw.ai —
 * `agents.list` returns "effective model and runtime metadata" that varies by
 * deployment; there is no fixed OpenClaw model family the way there is for
 * Claude Code or Grok Build). A permissive-to-everything pattern like
 * '.*openclaw|.*' would defeat the identity-echo challenge (it fails CLOSED
 * on non-matching ids, not on matching everything) — that is exactly the
 * painted-status hole PRD §4 exists to prevent.
 *
 * Default pattern below covers the model families we know OpenClaw can be
 * configured to front (Anthropic/OpenAI/Hermes/xAI/Meta/Alibaba). The Add
 * Agent wizard (Phase 3) MUST let the operator override `identity.modelPattern` at
 * onboarding to the actual configured model for his OpenClaw install — this
 * default is a starting point, not the final word for any real deployment.
 */
export const OPENCLAW_DEFAULT_MODEL_PATTERN = '^(openclaw|claude|gpt|hermes|grok|llama|qwen)';

/**
 * `source`: which
 * physical environment this seat's compute actually runs in. Same
 * frozen-shared-avoidance idiom as ollama/manifest.ts's
 * `AttestedAdapterManifest`/`verification` — see hermes/manifest.ts's doc
 * comment for the full rationale. Not in today's seats-roster.json (no live
 * OpenClaw deployment yet), but every manifest carries a non-empty default
 * so a future seat renders one immediately; deployment-dependent like
 * modelPattern/billing above — overridable per-instance via
 * config.transport.source once a real deployment's actual host is known.
 */
export const openclawManifest: AdapterManifest & { source: string } = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  harness: 'openclaw',
  flavor: 'ws',
  avatar: '🦞',
  color: '#7c3aed',
  capabilities: ['ws', 'chat-send', 'session-tools'],
  identity: {
    // Transport-configurable: see resolveOpenClawAdapterConfig — a real
    // onboarding flow overrides this via transport.modelPattern once the operator
    // (or the wizard) knows the model his OpenClaw gateway actually fronts.
    modelPattern: OPENCLAW_DEFAULT_MODEL_PATTERN,
  },
  trust: 'full',
  // Deployment-dependent: OpenClaw fronts whatever model its operator
  // configured, so there is no fixed per-token rate to declare here (same
  // reasoning as modelPattern above). 'subscription' is the honest default —
  // token bar, no invented dollars — until the Add Agent wizard (Milestone D)
  // lets an operator override billing (including 'api' + real rates) at
  // onboarding time for their specific deployment.
  billing: { kind: 'subscription' },
  defaultPort: 18789,
  manifestVersion: 1,
  source: 'This machine · OpenClaw gateway (:18789)',
};
