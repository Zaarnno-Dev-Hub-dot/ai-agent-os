import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AdapterManifest, AgentSession, ChallengeResponse } from '@agent-os/shared';
import { isAttestedManifest, manifestDeclaresTools, runAttestedChallenge } from './attestedVerifier.js';
import { createVerifier } from './agents.js';

// ============================================================================
// Pure predicates
// ============================================================================

describe('isAttestedManifest', () => {
  it('is true only when the manifest declares verification: attested', () => {
    expect(isAttestedManifest({ verification: 'attested' } as unknown as AdapterManifest)).toBe(true);
  });

  it('is false for a manifest with no verification field (full tier, implicit)', () => {
    expect(isAttestedManifest({} as AdapterManifest)).toBe(false);
  });
});

describe('manifestDeclaresTools', () => {
  const withCaps = (capabilities: string[]): AdapterManifest =>
    ({ capabilities } as unknown as AdapterManifest);

  it('flags file-tools (claude-code/grok-build)', () => {
    expect(manifestDeclaresTools(withCaps(['cli-stream', 'file-tools', 'resume-session']))).toBe(true);
  });

  it('flags the bare "tools" capability (hermes)', () => {
    expect(manifestDeclaresTools(withCaps(['http-openai', 'runs-api', 'tools']))).toBe(true);
  });

  it('flags session-tools (openclaw)', () => {
    expect(manifestDeclaresTools(withCaps(['ws', 'chat-send', 'session-tools']))).toBe(true);
  });

  it('does not flag a tool-less http-openai manifest (ollama)', () => {
    expect(manifestDeclaresTools(withCaps(['http-openai', 'chat']))).toBe(false);
  });
});

// ============================================================================
// runAttestedChallenge — fake AgentSession, no HTTP. Exercises the REAL
// module (not a stub), same "fake session that passes for real" philosophy
// as agents.test.ts's makeFakeSession for the full-tier path.
// ============================================================================

const attestedManifest: AdapterManifest = {
  id: 'fake-attested',
  displayName: 'Fake Attested',
  harness: 'homebrew',
  flavor: 'http-openai',
  avatar: '🤖',
  color: '#123456',
  capabilities: ['http-openai', 'chat'],
  identity: { modelPattern: '^qwen2\\.5' },
  trust: 'full',
  manifestVersion: 1,
} as unknown as AdapterManifest;

type NonceBehavior = 'echo' | 'wrong' | 'static-mock';
type ProbeBehavior = 'correct' | 'static-mock';

function makeAttestedFakeSession(opts: {
  modelId?: string;
  nonceBehavior?: NonceBehavior;
  probeBehavior?: ProbeBehavior;
  onProve?: (rawType: string) => void;
} = {}): AgentSession {
  const modelId = opts.modelId ?? 'qwen2.5:7b';
  const nonceBehavior = opts.nonceBehavior ?? 'echo';
  const probeBehavior = opts.probeBehavior ?? 'correct';

  return {
    send: async () => undefined,
    events: async function* () {
      /* no relay events needed for these tests */
    },
    prove: async (challenge) => {
      const rawType = (challenge as unknown as { type: string }).type;
      opts.onProve?.(rawType);

      if (rawType === 'attested-nonce') {
        const c = challenge as unknown as { challengeId: string; nonce: string };
        let raw: string;
        if (nonceBehavior === 'echo') raw = JSON.stringify({ nonce: c.nonce });
        else if (nonceBehavior === 'wrong') raw = JSON.stringify({ nonce: 'not-the-real-nonce' });
        else
          raw =
            'I am a helpful AI assistant and I am always happy to help you with whatever you need today!';
        return {
          challengeId: c.challengeId,
          type: 'attested-nonce',
          success: true,
          data: { raw },
          latencyMs: 1,
        } as unknown as ChallengeResponse;
      }

      if (rawType === 'attested-probe') {
        const c = challenge as unknown as {
          challengeId: string;
          probeId: 'arithmetic' | 'string-transform';
          question: string;
        };
        let raw: string;
        if (probeBehavior === 'correct') {
          if (c.probeId === 'arithmetic') {
            const nums = c.question.match(/\d+/g)?.map(Number) ?? [0, 0];
            raw = String(nums[0] + nums[1]);
          } else {
            const m = c.question.match(/"([a-z]+)"/);
            raw = m ? m[1].toUpperCase() : '';
          }
        } else {
          raw = 'I am a static canned responder and this is always my answer, no matter the question.';
        }
        return {
          challengeId: c.challengeId,
          type: 'attested-probe',
          success: true,
          data: { raw },
          latencyMs: 1,
        } as unknown as ChallengeResponse;
      }

      if (challenge.type === 'identity-echo') {
        return {
          challengeId: challenge.challengeId,
          type: 'identity-echo',
          success: true,
          data: { modelId },
          latencyMs: 1,
        };
      }

      return {
        challengeId: challenge.challengeId,
        type: challenge.type,
        success: false,
        error: 'not supported by this fake attested session',
        latencyMs: 1,
      };
    },
    health: async () => ({ ok: true, latencyMs: 1, modelId, sessionAgeMs: 0 }),
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
}

function freshVerifier() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'attested-verifier-test-'));
  return createVerifier(workspaceRoot, async (session) => {
    const h = await session.health();
    return { modelId: h.modelId };
  });
}

describe('runAttestedChallenge', () => {
  it('VERIFIED end-to-end: identity → nonce → arithmetic probe → string-transform probe, all passing', async () => {
    const session = makeAttestedFakeSession();
    const verifier = freshVerifier();

    const result = await runAttestedChallenge('ollama-test', session, attestedManifest, verifier);

    expect(result.status).toBe('VERIFIED');
    expect(result.responses).toHaveLength(4);
    expect(result.responses.map((r) => r.type)).toEqual([
      'identity-echo',
      'attested-nonce',
      'attested-probe',
      'attested-probe',
    ]);
    expect(result.responses.every((r) => r.success)).toBe(true);
  });

  it('FAILED at identity: model id does not match manifest pattern (fail-closed, same as full)', async () => {
    const session = makeAttestedFakeSession({ modelId: 'llama-not-qwen' });
    const verifier = freshVerifier();

    const result = await runAttestedChallenge('ollama-test', session, attestedManifest, verifier);

    expect(result.status).toBe('FAILED');
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].type).toBe('identity-echo');
    expect(result.responses[0].error).toMatch(/Identity mismatch/);
  });

  it('FAILED at nonce: endpoint echoes back the wrong value', async () => {
    const session = makeAttestedFakeSession({ nonceBehavior: 'wrong' });
    const verifier = freshVerifier();

    const result = await runAttestedChallenge('ollama-test', session, attestedManifest, verifier);

    expect(result.status).toBe('FAILED');
    expect(result.responses).toHaveLength(2);
    expect(result.responses[1].error).toMatch(/Nonce mismatch/);
  });

  it('FAILED at nonce with the generic-response detector: a static/mock endpoint answering with prose instead of the structured echo', async () => {
    const session = makeAttestedFakeSession({ nonceBehavior: 'static-mock' });
    const verifier = freshVerifier();

    const result = await runAttestedChallenge('ollama-test', session, attestedManifest, verifier);

    expect(result.status).toBe('FAILED');
    expect(result.responses.at(-1)?.error).toMatch(/Generic-response detector/);
  });

  it('FAILS the probe step: a mock endpoint that always echoes the same canned text regardless of the (randomized) question', async () => {
    const session = makeAttestedFakeSession({ probeBehavior: 'static-mock' });
    const verifier = freshVerifier();

    const result = await runAttestedChallenge('ollama-test', session, attestedManifest, verifier);

    expect(result.status).toBe('FAILED');
    // Passed identity + nonce, failed on the first probe.
    expect(result.responses.map((r) => r.type)).toEqual(['identity-echo', 'attested-nonce', 'attested-probe']);
    expect(result.responses.at(-1)?.error).toMatch(/Canned-responder probe/);
  });

  it('REJECTS a manifest that declares tools + attested — no quiet downgrades, and makes ZERO live calls', async () => {
    const toolyManifest: AdapterManifest = {
      ...attestedManifest,
      capabilities: ['cli-stream', 'file-tools', 'resume-session'],
    };
    const proveSpy = vi.fn();
    const session = makeAttestedFakeSession({ onProve: proveSpy });
    const verifier = freshVerifier();

    const result = await runAttestedChallenge('ollama-test', session, toolyManifest, verifier);

    expect(result.status).toBe('FAILED');
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].error).toMatch(/no quiet downgrades/);
    expect(proveSpy).not.toHaveBeenCalled();
  });
});
