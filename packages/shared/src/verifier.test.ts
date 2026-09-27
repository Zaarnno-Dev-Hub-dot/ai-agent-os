/**
 * Proof-of-Life Verifier tests.
 * The scenarios mirror the failure modes of dashboard attempts #1–7:
 * impostor "agents" that are bare LLM APIs behind a chat window.
 */
import { describe, it, expect } from 'vitest';
import { ProofOfLifeVerifier, VerifierDeps } from './verifier';
import { AdapterManifest, AgentSession, Challenge, ChallengeResponse } from './types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    id: 'hermes',
    displayName: 'Hermes',
    harness: 'hermes',
    flavor: 'http-openai',
    avatar: '☤',
    color: '#c9a35c',
    capabilities: ['read-workspace'],
    identity: { modelPattern: '^hermes-\\d' },
    trust: 'full',
    manifestVersion: 1,
    ...overrides,
  };
}

/** In-memory "workspace" a real session can read from and an impostor cannot. */
function makeWorld() {
  const files = new Map<string, string>();
  const deps: VerifierDeps = {
    writeNonceFile: async (agentId, nonce) => {
      const path = `/ws/${agentId}/pol-${files.size}.txt`;
      files.set(path, nonce);
      return path;
    },
    removeNonceFile: async (path) => {
      files.delete(path);
    },
    probeCapability: async () => ({ ok: true, capability: 'read-workspace' }),
    getIdentityFromSession: async (session) => (session as FakeSession).identity,
  };
  return { files, deps };
}

interface FakeSession extends AgentSession {
  identity: { modelId: string; accountId?: string };
  seenChallenges: Challenge[];
}

function makeSession(
  identity: { modelId: string; accountId?: string },
  prove: (challenge: Challenge, seen: Challenge[]) => Promise<ChallengeResponse>
): FakeSession {
  const seenChallenges: Challenge[] = [];
  const session: FakeSession = {
    identity,
    seenChallenges,
    send: async () => undefined,
    events: () => (async function* () {})(),
    prove: async (challenge) => {
      seenChallenges.push(challenge);
      return prove(challenge, seenChallenges);
    },
    health: async () => ({ ok: true, latencyMs: 5, modelId: identity.modelId, sessionAgeMs: 1000 }),
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
  return session;
}

/** A REAL agent: reads the nonce from the (fake) filesystem at the given path. */
function honestSession(files: Map<string, string>, identity = { modelId: 'hermes-4', accountId: 'nous-sub' }) {
  return makeSession(identity, async (challenge) => {
    if (challenge.type !== 'nonce-file') throw new Error('unexpected');
    const contents = files.get(challenge.noncePath);
    return {
      challengeId: challenge.challengeId,
      type: 'nonce-file',
      success: true,
      data: { nonce: contents ?? '' },
      latencyMs: 3,
    };
  });
}

function makeVerifier(deps: VerifierDeps, timeoutMs = 200) {
  return new ProofOfLifeVerifier(
    {
      workspaceRoot: '/ws',
      challengeTimeoutMs: timeoutMs,
      heartbeatIntervalMs: 20_000,
      staleThreshold: 2,
      proofOfLifeIntervalHours: 24,
    },
    deps
  );
}

// ---------------------------------------------------------------------------
// The security invariant that failed in the previous draft
// ---------------------------------------------------------------------------

describe('nonce challenge — no-leak invariant', () => {
  it('never includes the nonce value in the challenge payload sent to the agent', async () => {
    const { files, deps } = makeWorld();
    const session = honestSession(files);
    const verifier = makeVerifier(deps);

    const result = await verifier.runChallenge('hermes', session, makeManifest(), 'nonce-file');
    expect(result.success).toBe(true);

    const challenge = session.seenChallenges[0]!;
    expect(challenge.type).toBe('nonce-file');
    // The payload must carry the path and must NOT carry the nonce in any field.
    expect((challenge as { noncePath?: string }).noncePath).toBeTruthy();
    const nonce = result.data!.nonce!;
    expect(nonce.length).toBeGreaterThan(10);
    expect(JSON.stringify(challenge)).not.toContain(nonce);
  });

  it('FAILS an echo impostor that reflects whatever the challenge contains', async () => {
    const { deps } = makeWorld();
    // Attempt #7's ghost: echoes challenge fields back without touching disk.
    const impostor = makeSession({ modelId: 'hermes-4' }, async (challenge) => ({
      challengeId: challenge.challengeId,
      type: 'nonce-file',
      success: true,
      data: { nonce: (challenge as { nonce?: string }).nonce ?? '' },
      latencyMs: 1,
    }));
    const result = await makeVerifier(deps).runChallenge('hermes', impostor, makeManifest(), 'nonce-file');
    expect(result.success).toBe(false);
  });

  it('flags prose answers via the generic-response detector', async () => {
    const { deps } = makeWorld();
    const impostor = makeSession({ modelId: 'hermes-4' }, async (challenge) => ({
      challengeId: challenge.challengeId,
      type: 'nonce-file',
      success: true,
      data: { text: 'I have successfully completed the verification challenge and confirmed my identity as requested.' },
      latencyMs: 1,
    }));
    const result = await makeVerifier(deps).runChallenge('hermes', impostor, makeManifest(), 'nonce-file');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Generic-response detector/);
  });

  it('cleans up the nonce file after the challenge', async () => {
    const { files, deps } = makeWorld();
    await makeVerifier(deps).runChallenge('hermes', honestSession(files), makeManifest(), 'nonce-file');
    expect(files.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Identity echo
// ---------------------------------------------------------------------------

describe('identity echo', () => {
  it('passes an honest Claude Code session reporting a sonnet model', async () => {
    const { files, deps } = makeWorld();
    const manifest = makeManifest({
      id: 'claude-code',
      harness: 'claude-code',
      identity: { modelPattern: '^(claude|sonnet|opus|haiku)' },
    });
    const session = honestSession(files, { modelId: 'sonnet-5', accountId: 'local-login' });
    const result = await makeVerifier(deps).runChallenge('claude-code', session, manifest, 'identity-echo');
    expect(result.success).toBe(true);
    expect(result.data?.modelId).toBe('sonnet-5');
  });

  it('FAILS a "hermes-clone" whose model id does not match the manifest pattern', async () => {
    const { files, deps } = makeWorld();
    // The old substring check passed this impostor because "hermes-clone" contains "hermes".
    const session = honestSession(files, { modelId: 'hermes-clone' });
    const result = await makeVerifier(deps).runChallenge('hermes', session, makeManifest(), 'identity-echo');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Identity mismatch/);
  });

  it('fails CLOSED on an invalid manifest pattern', async () => {
    const { files, deps } = makeWorld();
    const manifest = makeManifest({ identity: { modelPattern: '([' } });
    const result = await makeVerifier(deps).runChallenge('hermes', honestSession(files), manifest, 'identity-echo');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid identity pattern/);
  });
});

// ---------------------------------------------------------------------------
// Full sequence, timeouts, rotation
// ---------------------------------------------------------------------------

describe('full challenge sequence', () => {
  it('VERIFIES an honest agent end-to-end', async () => {
    const { files, deps } = makeWorld();
    const { status, responses } = await makeVerifier(deps).runFullChallenge(
      'hermes',
      honestSession(files),
      makeManifest()
    );
    expect(status).toBe('VERIFIED');
    expect(responses.map((r) => r.type)).toEqual(['identity-echo', 'nonce-file', 'capability-probe']);
    expect(responses.every((r) => r.success)).toBe(true);
  });

  it('stops at the first failure and returns FAILED', async () => {
    const { files, deps } = makeWorld();
    const session = honestSession(files, { modelId: 'gpt-generic' }); // wrong identity
    const { status, responses } = await makeVerifier(deps).runFullChallenge('hermes', session, makeManifest());
    expect(status).toBe('FAILED');
    expect(responses).toHaveLength(1);
  });

  it('fails a session that hangs past the challenge timeout', async () => {
    const { deps } = makeWorld();
    const hung = makeSession({ modelId: 'hermes-4' }, () => new Promise(() => undefined));
    const result = await makeVerifier(deps, 60).runChallenge('hermes', hung, makeManifest(), 'nonce-file');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

describe('challenge rotation', () => {
  const r = (type: ChallengeResponse['type']): ChallengeResponse => ({
    challengeId: 'x',
    type,
    success: true,
    latencyMs: 1,
  });

  it('prioritizes nonce-file when it has not run recently', () => {
    const { deps } = makeWorld();
    const v = makeVerifier(deps);
    expect(v.getNextChallengeType([])).toBe('nonce-file');
    expect(v.getNextChallengeType([r('identity-echo'), r('capability-probe'), r('identity-echo')])).toBe('nonce-file');
  });

  it('rotates to the least-recently-used type otherwise', () => {
    const { deps } = makeWorld();
    const v = makeVerifier(deps);
    expect(v.getNextChallengeType([r('identity-echo'), r('nonce-file'), r('capability-probe')])).toBe('nonce-file');
    expect(v.getNextChallengeType([r('nonce-file'), r('capability-probe'), r('nonce-file')])).toBe('identity-echo');
  });
});

describe('staleness', () => {
  it('marks stale after the configured missed heartbeats', () => {
    const { deps } = makeWorld();
    const v = makeVerifier(deps);
    expect(v.isStale(Date.now())).toBe(false);
    expect(v.isStale(Date.now() - 19_000)).toBe(false);
    expect(v.isStale(Date.now() - 41_000)).toBe(true);
  });
});
