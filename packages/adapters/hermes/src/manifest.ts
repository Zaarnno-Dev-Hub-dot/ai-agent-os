import type { AdapterManifest } from '@agent-os/shared';

/**
 * `source`: which
 * physical environment this seat's compute actually runs in. packages/shared's
 * AdapterManifest has no `source` field — it is FROZEN — so this is a locally-widened type, same idiom as ollama/manifest.ts's
 * `AttestedAdapterManifest`/`verification`. Read at the gateway via an
 * endpoint-typed cast (agents.ts's resolveAgentSource, same idiom as
 * attestedVerifier.ts's isAttestedManifest); overridable per-seat via
 * `config.transport.source` (see agents.ts) for a future second seat of this
 * harness on a different machine.
 */
export const hermesManifest: AdapterManifest & { source: string } = {
  id: 'hermes',
  displayName: 'Hermes',
  harness: 'hermes',
  flavor: 'http-openai',
  avatar: '☤',
  color: '#1e7a57',
  capabilities: ['http-openai', 'runs-api', 'tools'],
  identity: {
    modelPattern: '^hermes',
  },
  trust: 'full',
  billing: { kind: 'local' },
  defaultPort: 8642,
  manifestVersion: 1,
  source: 'This machine · Hermes app (:8642)',
};