import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  AdapterError,
  type AdapterConfig,
  type AdapterManifest,
  type AgentSession,
  type AgentState,
  type AgentStatus,
  type ChallengeResponse,
  type HealthReport,
  type ProofOfLifeVerifier,
  type ServerEvent,
} from '@agent-os/shared';
import {
  connectAgent,
  deriveSeatId,
  disconnectAgent,
  isTransientChallengeFailure,
  isValidInstanceId,
  manifestSource,
  recordSeatReply,
  registerAdapter,
  resolveAgentSource,
  resolveSshWorkspace,
  runFullChallengeWithTransientRetry,
  runSshCommand,
  seatDisplayName,
  seatLastReplyAt,
} from './agents.js';
import { registerAgentRelay, type RelayDeps } from './relay.js';

// child_process is mocked ONLY for the ssh-workspace remote nonce writer
// tests below — every other test in this file goes through the real fs
// (freshWorkspaceRoot()) and never touches child_process, so this mock is
// inert for them.
vi.mock('child_process', () => ({ spawn: vi.fn() }));
const spawnMock = vi.mocked(spawn);
// ============================================================================
// Pure functions: seat-id derivation, validation, display name
// ============================================================================

describe('deriveSeatId', () => {
  it('collapses to manifestId when instanceId is absent (BACK-COMPAT)', () => {
    expect(deriveSeatId('claude-code')).toBe('claude-code');
    expect(deriveSeatId('claude-code', undefined)).toBe('claude-code');
  });

  it("collapses to manifestId when instanceId is exactly 'main' (BACK-COMPAT)", () => {
    expect(deriveSeatId('claude-code', 'main')).toBe('claude-code');
  });

  it('collapses to manifestId for an empty-string instanceId', () => {
    expect(deriveSeatId('claude-code', '')).toBe('claude-code');
  });

  it('joins manifestId#instanceId for any other slug', () => {
    expect(deriveSeatId('claude-code', 'work')).toBe('claude-code#work');
    expect(deriveSeatId('claude-code', 'test')).toBe('claude-code#test');
    expect(deriveSeatId('grok-build', 'nova')).toBe('grok-build#nova');
  });
});

describe('isValidInstanceId', () => {
  it('accepts lowercase letters, digits, and hyphens up to 16 chars', () => {
    expect(isValidInstanceId('work')).toBe(true);
    expect(isValidInstanceId('a')).toBe(true);
    expect(isValidInstanceId('nova-2')).toBe(true);
    expect(isValidInstanceId('a'.repeat(16))).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidInstanceId('')).toBe(false);
  });

  it('rejects over 16 characters', () => {
    expect(isValidInstanceId('a'.repeat(17))).toBe(false);
  });

  it("rejects '#' (the seat-id separator itself)", () => {
    expect(isValidInstanceId('work#nested')).toBe(false);
    expect(isValidInstanceId('#')).toBe(false);
  });

  it('rejects uppercase, spaces, underscores, and other punctuation', () => {
    expect(isValidInstanceId('Work')).toBe(false);
    expect(isValidInstanceId('my work')).toBe(false);
    expect(isValidInstanceId('my_work')).toBe(false);
    expect(isValidInstanceId('work!')).toBe(false);
    expect(isValidInstanceId('work.two')).toBe(false);
  });
});

describe('seatDisplayName', () => {
  const manifest = { displayName: 'Claude Code' } as AdapterManifest;

  it('uses instanceLabel when given, regardless of instanceId', () => {
    expect(seatDisplayName(manifest, 'work', 'Claude — Nova account')).toBe('Claude — Nova account');
    expect(seatDisplayName(manifest, undefined, 'Custom Label')).toBe('Custom Label');
  });

  it('falls back to the bare manifest displayName for absent/"main" instanceId with no label', () => {
    expect(seatDisplayName(manifest, undefined, undefined)).toBe('Claude Code');
    expect(seatDisplayName(manifest, 'main', undefined)).toBe('Claude Code');
  });

  it('suffixes the instance slug when there is an instanceId but no label', () => {
    expect(seatDisplayName(manifest, 'work', undefined)).toBe('Claude Code — work');
  });
});

describe('resolveAgentSource / manifestSource (2026-07-18 agent info panel)', () => {
  const withSource = { source: 'This machine · Fake Harness' } as unknown as AdapterManifest;
  const bare = {} as AdapterManifest;

  it('uses the manifest default when no override is given', () => {
    expect(resolveAgentSource(withSource, { transport: {} })).toBe('This machine · Fake Harness');
  });

  it('uses config.transport.source when given (a non-blank string) — the per-instance override channel', () => {
    expect(resolveAgentSource(withSource, { transport: { source: 'Remote box · Fake Harness' } })).toBe(
      'Remote box · Fake Harness'
    );
  });

  it('ignores a blank/whitespace-only override, falling back to the manifest default', () => {
    expect(resolveAgentSource(withSource, { transport: { source: '   ' } })).toBe('This machine · Fake Harness');
  });

  it('ignores a non-string override', () => {
    expect(resolveAgentSource(withSource, { transport: { source: 42 } })).toBe('This machine · Fake Harness');
  });

  it('falls back to "unknown" when the manifest declares no source and no override is given', () => {
    expect(resolveAgentSource(bare, { transport: {} })).toBe('unknown');
  });

  it('manifestSource reads the same field back (the post-connect read path buildStateSync uses)', () => {
    expect(manifestSource(withSource)).toBe('This machine · Fake Harness');
    expect(manifestSource(bare)).toBe('unknown');
  });
});

describe('recordSeatReply / seatLastReplyAt (2026-07-28 router-side last-reply surfacing)', () => {
  it('is undefined for a seat that has never had a reply recorded', () => {
    const state = {} as AgentState;
    expect(seatLastReplyAt(state)).toBeUndefined();
  });

  it('records an epoch-ms timestamp as an ISO 8601 string readable back off the same state object', () => {
    const state = {} as AgentState;
    const atMs = Date.parse('2026-07-28T14:00:00.000Z');
    recordSeatReply(state, atMs);
    expect(seatLastReplyAt(state)).toBe('2026-07-28T14:00:00.000Z');
  });

  it('overwrites (not accumulates) on a later call — reflects the MOST RECENT reply only', () => {
    const state = {} as AgentState;
    recordSeatReply(state, Date.parse('2026-07-28T09:00:00.000Z'));
    recordSeatReply(state, Date.parse('2026-07-28T09:05:00.000Z'));
    expect(seatLastReplyAt(state)).toBe('2026-07-28T09:05:00.000Z');
  });

  it('is per-object — recording on one seat state never touches another', () => {
    const seatA = {} as AgentState;
    const seatB = {} as AgentState;
    recordSeatReply(seatA, Date.parse('2026-07-28T09:00:00.000Z'));
    expect(seatLastReplyAt(seatA)).toBe('2026-07-28T09:00:00.000Z');
    expect(seatLastReplyAt(seatB)).toBeUndefined();
  });
});

// ============================================================================
// connectAgent: seat keying end-to-end via a fake adapter/session
// ============================================================================

function freshWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agents-test-'));
}

function fakeHealth(): HealthReport {
  return { ok: true, latencyMs: 5, modelId: 'claude-test', sessionAgeMs: 0 };
}

const fakeManifest: AdapterManifest & { source: string } = {
  id: 'fake-harness',
  displayName: 'Fake Harness',
  harness: 'homebrew',
  flavor: 'ws',
  avatar: '🤖',
  color: '#123456',
  capabilities: ['probe-me'],
  identity: { modelPattern: '^claude' },
  trust: 'full',
  manifestVersion: 1,
  source: 'This machine · Fake Harness',
};

/**
 * Fake AgentSession that passes every challenge for real, without mocking
 * fs: the nonce-file challenge reads back whatever createVerifier's actual
 * writeNonceFile wrote to disk, so the real per-seat workspace directory
 * (workspaceRoot/<agentId>) genuinely gets exercised by these tests.
 */
function makeFakeSession(): AgentSession {
  return {
    send: async () => undefined,
    events: async function* () {
      /* no relay events needed for these tests */
    },
    prove: async (challenge) => {
      if (challenge.type === 'nonce-file') {
        const nonce = await readFile(challenge.noncePath, 'utf8');
        return {
          challengeId: challenge.challengeId,
          type: 'nonce-file',
          success: true,
          data: { nonce },
          latencyMs: 1,
        };
      }
      if (challenge.type === 'identity-echo') {
        return {
          challengeId: challenge.challengeId,
          type: 'identity-echo',
          success: true,
          data: { modelId: 'claude-test' },
          latencyMs: 1,
        };
      }
      return {
        challengeId: challenge.challengeId,
        type: 'capability-probe',
        success: true,
        data: { capability: challenge.capability, result: 'ok' },
        latencyMs: 1,
      };
    },
    health: async () => fakeHealth(),
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
}

/** Registers a fresh fake adapter under its own manifestId so tests don't share registry state. */
function registerFakeAdapter(manifestId: string) {
  registerAdapter(manifestId, {
    adapter: {
      manifest: fakeManifest,
      connect: async () => makeFakeSession(),
    },
    getIdentityFromSession: async () => ({ modelId: 'claude-test', accountId: 'acct-1' }),
  });
}

describe('connectAgent seat keying', () => {
  it('keys the agents map by manifestId when no instanceId is given (BACK-COMPAT)', async () => {
    registerFakeAdapter('fake-harness-bc');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status } = await connectAgent(
      'fake-harness-bc',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(agentId).toBe('fake-harness-bc');
    expect(status).toBe('VERIFIED');
    expect(agents.has('fake-harness-bc')).toBe(true);
    expect(agents.get('fake-harness-bc')?.manifest.displayName).toBe('Fake Harness');
  });

  it('keys the agents map by manifestId#instanceId and gives the seat a suffixed display name', async () => {
    registerFakeAdapter('fake-harness-seat');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status } = await connectAgent(
      'fake-harness-seat',
      { transport: {} },
      agents,
      workspaceRoot,
      undefined,
      { instanceId: 'test' }
    );

    expect(agentId).toBe('fake-harness-seat#test');
    expect(status).toBe('VERIFIED');
    expect(agents.has('fake-harness-seat#test')).toBe(true);
    expect(agents.has('fake-harness-seat')).toBe(false);
    expect(agents.get('fake-harness-seat#test')?.manifest.displayName).toBe('Fake Harness — test');
  });

  it('lets two seats of the SAME manifest connect and coexist under distinct keys', async () => {
    registerFakeAdapter('fake-harness-dual');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const main = await connectAgent('fake-harness-dual', { transport: {} }, agents, workspaceRoot);
    const second = await connectAgent(
      'fake-harness-dual',
      { transport: {} },
      agents,
      workspaceRoot,
      undefined,
      { instanceId: 'test', instanceLabel: 'Dual — test seat' }
    );

    expect(main.agentId).toBe('fake-harness-dual');
    expect(second.agentId).toBe('fake-harness-dual#test');
    expect(agents.size).toBe(2);
    expect(agents.get('fake-harness-dual#test')?.manifest.displayName).toBe('Dual — test seat');
    // The main seat's manifest displayName is untouched by the second seat's label.
    expect(agents.get('fake-harness-dual')?.manifest.displayName).toBe('Fake Harness');
  });

  it("carries the manifest's default source onto the seat when connect() gets no override (2026-07-18 agent info panel)", async () => {
    registerFakeAdapter('fake-harness-source-default');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    await connectAgent('fake-harness-source-default', { transport: {} }, agents, workspaceRoot);

    const stored = agents.get('fake-harness-source-default')?.manifest as (AdapterManifest & { source?: string }) | undefined;
    expect(stored?.source).toBe('This machine · Fake Harness');
  });

  it('applies a per-instance source override from config.transport.source', async () => {
    registerFakeAdapter('fake-harness-source-override');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    await connectAgent(
      'fake-harness-source-override',
      { transport: { source: 'Remote box · Fake Harness (mini)' } },
      agents,
      workspaceRoot,
      undefined,
      { instanceId: 'mini' }
    );

    const stored = agents.get('fake-harness-source-override#mini')?.manifest as
      | (AdapterManifest & { source?: string })
      | undefined;
    expect(stored?.source).toBe('Remote box · Fake Harness (mini)');
  });

  it('two seats of the same manifest can carry DIFFERENT sources when only one supplies an override', async () => {
    registerFakeAdapter('fake-harness-source-dual');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    await connectAgent('fake-harness-source-dual', { transport: {} }, agents, workspaceRoot);
    await connectAgent(
      'fake-harness-source-dual',
      { transport: { source: 'Remote box · Fake Harness (mini)' } },
      agents,
      workspaceRoot,
      undefined,
      { instanceId: 'mini' }
    );

    const main = agents.get('fake-harness-source-dual')?.manifest as (AdapterManifest & { source?: string }) | undefined;
    const mini = agents.get('fake-harness-source-dual#mini')?.manifest as
      | (AdapterManifest & { source?: string })
      | undefined;
    expect(main?.source).toBe('This machine · Fake Harness');
    expect(mini?.source).toBe('Remote box · Fake Harness (mini)');
  });

  it('rejects an invalid instanceId (contains #) before touching the agents map', async () => {
    registerFakeAdapter('fake-harness-invalid');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    await expect(
      connectAgent(
        'fake-harness-invalid',
        { transport: {} },
        agents,
        workspaceRoot,
        undefined,
        { instanceId: 'nested#id' }
      )
    ).rejects.toThrow(/Invalid instanceId/);
    expect(agents.size).toBe(0);
  });

  it('rejects an instanceId over 16 characters', async () => {
    registerFakeAdapter('fake-harness-long');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    await expect(
      connectAgent(
        'fake-harness-long',
        { transport: {} },
        agents,
        workspaceRoot,
        undefined,
        { instanceId: 'a'.repeat(17) }
      )
    ).rejects.toThrow(/Invalid instanceId/);
  });
});

// ============================================================================
// connectAgent: FAILED verification populates statusReason
// ============================================================================

/** Registers a fake adapter whose session reports an identity that never matches fakeManifest's '^claude' pattern — fails CLOSED at the identity-echo challenge, same as a real impostor/misconfigured harness. */
function registerFailingIdentityAdapter(manifestId: string) {
  registerAdapter(manifestId, {
    adapter: {
      manifest: fakeManifest,
      connect: async () => makeFakeSession(),
    },
    getIdentityFromSession: async () => ({ modelId: 'grok-3', accountId: 'acct-1' }),
  });
}

describe('connectAgent statusReason on FAILED', () => {
  it('surfaces the failing challenge error as statusReason, not undefined', async () => {
    registerFailingIdentityAdapter('fake-harness-failid');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status, statusReason } = await connectAgent(
      'fake-harness-failid',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(status).toBe('FAILED');
    expect(statusReason).toBeTruthy();
    expect(statusReason).toMatch(/Identity mismatch/);
    // Same value must land on the stored AgentState (what toAgentSummary later reads).
    expect(agents.get(agentId)?.statusReason).toBe(statusReason);
    expect(agents.get(agentId)?.status).toBe('FAILED');
  });

  it('leaves statusReason undefined on a clean VERIFIED connect', async () => {
    registerFakeAdapter('fake-harness-verified-reason');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { status, statusReason } = await connectAgent(
      'fake-harness-verified-reason',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(status).toBe('VERIFIED');
    expect(statusReason).toBeUndefined();
  });

  it('re-surfaces the stored statusReason on a duplicate-connect return for an already-FAILED seat', async () => {
    registerFailingIdentityAdapter('fake-harness-dup-failed');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const first = await connectAgent('fake-harness-dup-failed', { transport: {} }, agents, workspaceRoot);
    expect(first.status).toBe('FAILED');

    // FAILED is explicitly excluded from the duplicate-connect guard (agents.ts),
    // so this second call re-runs the full challenge rather than short-circuiting —
    // assert it still lands on the same FAILED status with a populated reason.
    const second = await connectAgent('fake-harness-dup-failed', { transport: {} }, agents, workspaceRoot);
    expect(second.status).toBe('FAILED');
    expect(second.statusReason).toBeTruthy();
  });
});

// ============================================================================
// connectAgent: ollama attested tier, REAL adapter + REAL attestedVerifier
// path, HTTP mocked. This registers no fake adapter — 'ollama' is registered in
// adaptersByManifestId exactly like every production seat, so this is the
// actual connectAgent -> runAttestedChallenge -> ollama adapter -> prove()
// path a real Mini connection goes through, with only fetch() mocked
// (per the build brief: "tests use mocks" for the endpoint).
// ============================================================================

/** A minimal live-Ollama-shaped mock: reads the actual prompt sent and answers each attested-tier challenge correctly, so the happy path exercises real prompt parsing on both sides instead of a fixed canned string. */
function ollamaLikeFetchMock(model = 'qwen2.5:7b') {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content: string }> };
    const prompt = body.messages?.[0]?.content ?? '';
    const reply = (content: string) =>
      new Response(JSON.stringify({ model, choices: [{ message: { content } }] }), { status: 200 });

    const nonceMatch = prompt.match(/\{"nonce":"([^"]+)"\}/);
    if (nonceMatch) return reply(`{"nonce":"${nonceMatch[1]}"}`);

    const arithMatch = prompt.match(/sum of (\d+) and (\d+)/);
    if (arithMatch) return reply(String(Number(arithMatch[1]) + Number(arithMatch[2])));

    const wordMatch = prompt.match(/"([a-z]+)" in ALL UPPERCASE/);
    if (wordMatch) return reply(wordMatch[1].toUpperCase());

    return reply('OK'); // connect-time handshake / an ordinary chat turn
  });
}

describe('connectAgent — ollama attested tier (real adapter, mocked HTTP endpoint)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('VERIFIED-attested through the REAL connectAgent -> attestedVerifier -> ollama adapter path (no bypasses); badge tier is ATTESTED', async () => {
    vi.stubGlobal('fetch', ollamaLikeFetchMock());
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status, statusReason } = await connectAgent(
      'ollama',
      { transport: { endpoint: 'http://127.0.0.1:11500/v1', model: 'qwen2.5:7b' } },
      agents,
      workspaceRoot,
      undefined,
      { instanceId: 'qwen' }
    );

    expect(agentId).toBe('ollama#qwen');
    expect(status).toBe('VERIFIED');
    expect(statusReason).toBeUndefined();

    const state = agents.get(agentId)!;
    expect(state.challengeHistory.map((r) => r.type)).toEqual([
      'identity-echo',
      'attested-nonce',
      'attested-probe',
      'attested-probe',
    ]);
    expect(state.challengeHistory.every((r) => r.success)).toBe(true);
    // Same additive-field cast idiom gateway/index.ts's buildStateSync uses
    // to derive the UI's ATTESTED badge — assert the tier really is on the
    // manifest that ends up on state (not just the adapter registry's copy).
    expect((state.manifest as unknown as { verification?: string }).verification).toBe('attested');
  });

  it('a static mock endpoint that always echoes the same canned text regardless of the question FAILS the probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: 'qwen2.5:7b',
              choices: [{ message: { content: 'I am a static mock and this is always my answer.' } }],
            }),
            { status: 200 }
          )
      )
    );
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { status, statusReason } = await connectAgent(
      'ollama',
      { transport: { endpoint: 'http://127.0.0.1:11500/v1', model: 'qwen2.5:7b' } },
      agents,
      workspaceRoot,
      undefined,
      { instanceId: 'static-mock-test' }
    );

    expect(status).toBe('FAILED');
    expect(statusReason).toBeTruthy();
  });

  it('a manifest declaring tools + attested is REJECTED before any live call (no quiet downgrades)', async () => {
    const proveSpy = vi.fn();
    const toolyAttestedManifest = {
      id: 'fake-attested-with-tools',
      displayName: 'Fake Attested+Tools',
      harness: 'homebrew',
      flavor: 'http-openai',
      avatar: '🤖',
      color: '#123456',
      capabilities: ['cli-stream', 'file-tools'],
      identity: { modelPattern: '^fake' },
      trust: 'full',
      verification: 'attested',
      manifestVersion: 1,
    } as unknown as AdapterManifest;

    registerAdapter('fake-attested-with-tools', {
      adapter: {
        manifest: toolyAttestedManifest,
        connect: async () => ({
          send: async () => undefined,
          events: async function* () {
            /* unused */
          },
          prove: async (c) => {
            proveSpy();
            return { challengeId: c.challengeId, type: c.type, success: true, latencyMs: 1 };
          },
          health: async () => fakeHealth(),
          interrupt: async () => undefined,
          dispose: async () => undefined,
        }),
      },
      getIdentityFromSession: async () => ({ modelId: 'fake-model' }),
    });

    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { status, statusReason } = await connectAgent(
      'fake-attested-with-tools',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(status).toBe('FAILED');
    expect(statusReason).toMatch(/no quiet downgrades/);
    expect(proveSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// connectAgent: adapter.connect() failure (binary-not-found, auth-missing,
// etc.) fails the seat FAST to FAILED instead of leaving it stuck at
// CONNECTING
// ============================================================================

/** Registers a fake adapter whose connect() rejects the way a real adapter does on a missing binary (see claude-code's verifyBinaryAndAuth). */
function registerBinaryNotFoundAdapter(manifestId: string) {
  registerAdapter(manifestId, {
    adapter: {
      manifest: fakeManifest,
      connect: async () => {
        throw new AdapterError(
          'binary-not-found',
          "'claude' was not found (checked as file path and on PATH)",
          'Install the Claude Code CLI and log in once outside this app.'
        );
      },
    },
    getIdentityFromSession: async () => ({ modelId: 'claude-test' }),
  });
}

describe('connectAgent adapter.connect() failure', () => {
  it('flips the seat to FAILED with the adapter error as statusReason, instead of throwing', async () => {
    registerBinaryNotFoundAdapter('fake-harness-nobinary');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status, statusReason } = await connectAgent(
      'fake-harness-nobinary',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(status).toBe('FAILED');
    expect(statusReason).toMatch(/not found/);
    // The same value must land on the stored AgentState, not just the return
    // value — state.sync and agent.status (and scripts/connect-agent.mjs,
    // which waits on agent.status FAILED/VERIFIED/OFFLINE) read from here.
    expect(agents.get(agentId)?.status).toBe('FAILED');
    expect(agents.get(agentId)?.statusReason).toBe(statusReason);
    expect(agents.get(agentId)?.session).toBeUndefined();
  });

  it('does not leave the seat stuck at CONNECTING (the exact bug: the map entry existed but was never updated)', async () => {
    registerBinaryNotFoundAdapter('fake-harness-nobinary-2');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    await connectAgent('fake-harness-nobinary-2', { transport: {} }, agents, workspaceRoot);

    expect(agents.get('fake-harness-nobinary-2')?.status).not.toBe('CONNECTING');
  });

  it('surfaces a plain (non-AdapterError) connect() rejection the same way', async () => {
    registerAdapter('fake-harness-plainerror', {
      adapter: {
        manifest: fakeManifest,
        connect: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:9999');
        },
      },
      getIdentityFromSession: async () => ({ modelId: 'claude-test' }),
    });
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { status, statusReason } = await connectAgent(
      'fake-harness-plainerror',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(status).toBe('FAILED');
    expect(statusReason).toMatch(/ECONNREFUSED/);
  });
});

// ============================================================================
// disconnectAgent: graceful seat teardown — the inverse of connectAgent
// (the gap the loop-lite smoke test surfaced: agent.disconnect was a no-op)
// ============================================================================

interface DisposeTrackingSession extends AgentSession {
  disposeCalls: number;
}

/** A fake session whose dispose() is counted; optionally made to reject. */
function makeDisposeTrackingSession(opts: { disposeThrows?: boolean } = {}): DisposeTrackingSession {
  const session: DisposeTrackingSession = {
    disposeCalls: 0,
    send: async () => undefined,
    events: async function* () {
      /* no relay events needed */
    },
    prove: async () => ({ challengeId: 'x', type: 'identity-echo', success: true, latencyMs: 1 }),
    health: async () => fakeHealth(),
    interrupt: async () => undefined,
    dispose: async () => {
      session.disposeCalls++;
      if (opts.disposeThrows) throw new Error('adapter dispose blew up');
    },
  };
  return session;
}

/** A VERIFIED seat state wrapping the given session — mirrors what connectAgent leaves in the agents map. */
function verifiedSeat(session: AgentSession, overrides: Partial<AgentState> = {}): AgentState {
  return {
    manifest: fakeManifest,
    config: { transport: {} },
    status: 'VERIFIED',
    lastHeartbeat: Date.now(),
    health: fakeHealth(),
    assignedRooms: ['room-1'],
    challengeHistory: [],
    session,
    ...overrides,
  };
}

/** Minimal RelayDeps sufficient to register a worker (empty event stream never touches the rest). */
function makeRelayDeps(agents: Map<string, AgentState>): RelayDeps {
  return {
    db: {} as RelayDeps['db'],
    dataDir: '/tmp/unused',
    agents,
    rooms: new Map(),
    messages: new Map(),
    roomRelay: new Map(),
    globalCost: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} },
    broadcast: (_event: ServerEvent) => undefined,
    agentDisplayName: (agentId: string) => agentId,
  };
}

describe('disconnectAgent', () => {
  it('disposes the session and flips a VERIFIED seat to OFFLINE', async () => {
    const agents = new Map<string, AgentState>();
    const session = makeDisposeTrackingSession();
    agents.set('hermes', verifiedSeat(session));

    const result = await disconnectAgent('hermes', agents);

    expect(result).toEqual({ ok: true, agentId: 'hermes', status: 'OFFLINE' });
    expect(session.disposeCalls).toBe(1);
    const state = agents.get('hermes')!;
    expect(state.status).toBe('OFFLINE');
    // Live handle and health are cleared so nothing treats the seat as live.
    expect(state.session).toBeUndefined();
    expect(state.health).toBeUndefined();
    expect(state.statusReason).toBeUndefined();
  });

  it('leaves room membership intact so a later reconnect restores its rooms', async () => {
    const agents = new Map<string, AgentState>();
    agents.set('hermes', verifiedSeat(makeDisposeTrackingSession(), { assignedRooms: ['room-1', 'room-2'] }));

    await disconnectAgent('hermes', agents);

    expect(agents.get('hermes')!.assignedRooms).toEqual(['room-1', 'room-2']);
  });

  it('is a no-op (ok: false) for an unknown seat', async () => {
    const agents = new Map<string, AgentState>();

    const result = await disconnectAgent('nobody', agents);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nobody');
    expect(result.status).toBeUndefined();
  });

  it('is a no-op (ok: false) for a seat that has no live session', async () => {
    const agents = new Map<string, AgentState>();
    // Already OFFLINE from a prior disconnect: the session handle was cleared.
    agents.set('hermes', verifiedSeat(makeDisposeTrackingSession(), { status: 'OFFLINE', session: undefined }));

    const result = await disconnectAgent('hermes', agents);

    expect(result.ok).toBe(false);
    // Status is untouched — no second transition, nothing to dispose.
    expect(agents.get('hermes')!.status).toBe('OFFLINE');
  });

  it('does not double-dispose on a repeated disconnect of the same seat', async () => {
    const agents = new Map<string, AgentState>();
    const session = makeDisposeTrackingSession();
    agents.set('hermes', verifiedSeat(session));

    await disconnectAgent('hermes', agents);
    const second = await disconnectAgent('hermes', agents);

    expect(second.ok).toBe(false);
    expect(session.disposeCalls).toBe(1);
  });

  it('swallows a dispose() that throws and still ends OFFLINE', async () => {
    const agents = new Map<string, AgentState>();
    const session = makeDisposeTrackingSession({ disposeThrows: true });
    agents.set('hermes', verifiedSeat(session));

    const result = await disconnectAgent('hermes', agents);

    expect(result).toEqual({ ok: true, agentId: 'hermes', status: 'OFFLINE' });
    expect(session.disposeCalls).toBe(1);
    expect(agents.get('hermes')!.status).toBe('OFFLINE');
  });

  it('unregisters the relay worker without error when one is registered', async () => {
    const agents = new Map<string, AgentState>();
    const session = makeDisposeTrackingSession();
    agents.set('hermes', verifiedSeat(session));
    // Register a live worker (empty event stream) exactly as connectAgent does
    // for a VERIFIED seat, then prove disconnect tears it down cleanly.
    registerAgentRelay('hermes', session, makeRelayDeps(agents), 'full');

    const result = await disconnectAgent('hermes', agents);

    expect(result.ok).toBe(true);
    expect(session.disposeCalls).toBe(1);
  });

  it('tears down a real VERIFIED seat end-to-end (connect → disconnect)', async () => {
    registerFakeAdapter('fake-harness-disconnect');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status } = await connectAgent(
      'fake-harness-disconnect',
      { transport: {} },
      agents,
      workspaceRoot
    );
    expect(status).toBe('VERIFIED');

    const result = await disconnectAgent(agentId, agents);

    expect(result).toEqual({ ok: true, agentId, status: 'OFFLINE' });
    expect(agents.get(agentId)!.status).toBe('OFFLINE');
    expect(agents.get(agentId)!.session).toBeUndefined();
  });
});

// ============================================================================
// Verifier transient retry — 2026-07-05 grok problem+json blip caused a
// false FAILED on a single attempt. isTransientChallengeFailure classifies,
// runFullChallengeWithTransientRetry wraps the shared verifier call with ONE
// retry when the failure classifies transient.
// ============================================================================

function challengeResponse(overrides: Partial<ChallengeResponse> = {}): ChallengeResponse {
  return {
    challengeId: 'ch-1',
    type: 'nonce-file',
    success: false,
    latencyMs: 5,
    ...overrides,
  };
}

describe('isTransientChallengeFailure', () => {
  it('is false for a successful response', () => {
    expect(isTransientChallengeFailure(challengeResponse({ success: true, error: undefined }))).toBe(false);
  });

  it('is false when there is no error string at all', () => {
    expect(isTransientChallengeFailure(challengeResponse({ error: undefined }))).toBe(false);
  });

  it('classifies an application/problem+json body as transient (grok 7/5 incident)', () => {
    expect(
      isTransientChallengeFailure(
        challengeResponse({ error: 'Nonce challenge failed: upstream returned application/problem+json' })
      )
    ).toBe(true);
  });

  it('classifies a 5xx status mention as transient', () => {
    expect(isTransientChallengeFailure(challengeResponse({ error: 'Capability probe failed: 503 Service Unavailable' }))).toBe(
      true
    );
    expect(isTransientChallengeFailure(challengeResponse({ error: 'request failed with 502 Bad Gateway' }))).toBe(true);
  });

  it('classifies a timeout as transient', () => {
    expect(isTransientChallengeFailure(challengeResponse({ error: 'nonce-file timed out after 120000ms' }))).toBe(true);
  });

  it('classifies a network error as transient', () => {
    expect(isTransientChallengeFailure(challengeResponse({ error: 'Identity echo failed: fetch failed' }))).toBe(true);
    expect(isTransientChallengeFailure(challengeResponse({ error: 'connect ECONNRESET 127.0.0.1:443' }))).toBe(true);
    expect(isTransientChallengeFailure(challengeResponse({ error: 'socket hang up' }))).toBe(true);
  });

  it('is NOT transient for a genuine identity mismatch', () => {
    expect(
      isTransientChallengeFailure(
        challengeResponse({
          type: 'identity-echo',
          error: 'Identity mismatch: model "grok-3" does not match manifest pattern /^claude/i',
        })
      )
    ).toBe(false);
  });

  it('is NOT transient for a genuine nonce mismatch', () => {
    expect(
      isTransientChallengeFailure(
        challengeResponse({ error: 'Nonce mismatch: agent did not return the contents of /tmp/pol-abc.txt' })
      )
    ).toBe(false);
  });

  it('is NOT transient for the generic-response (impostor) detector', () => {
    expect(
      isTransientChallengeFailure(
        challengeResponse({
          error: 'Generic-response detector: agent answered with prose instead of the nonce file contents — placeholder/impostor suspected',
        })
      )
    ).toBe(false);
  });
});

describe('runFullChallengeWithTransientRetry', () => {
  function fakeVerifier(
    results: Array<{ status: AgentStatus; responses: ChallengeResponse[] }>
  ): ProofOfLifeVerifier {
    let call = 0;
    return {
      runFullChallenge: vi.fn(async () => {
        const result = results[Math.min(call, results.length - 1)];
        call++;
        return result;
      }),
    } as unknown as ProofOfLifeVerifier;
  }

  const manifest = { identity: { modelPattern: '^claude' } } as AdapterManifest;
  const session = {} as AgentSession;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries ONCE and returns the successful second attempt after a transient failure', async () => {
    const transientFail = {
      status: 'FAILED' as AgentStatus,
      responses: [
        challengeResponse({ success: true, type: 'identity-echo' }),
        challengeResponse({ type: 'nonce-file', error: 'Nonce challenge failed: application/problem+json' }),
      ],
    };
    const success = {
      status: 'VERIFIED' as AgentStatus,
      responses: [
        challengeResponse({ success: true, type: 'identity-echo' }),
        challengeResponse({ success: true, type: 'nonce-file' }),
        challengeResponse({ success: true, type: 'capability-probe' }),
      ],
    };
    const verifier = fakeVerifier([transientFail, success]);

    const resultPromise = runFullChallengeWithTransientRetry(verifier, 'agent-1', session, manifest);
    // Let the classification + first attempt's microtasks resolve, then fast-forward the backoff.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.status).toBe('VERIFIED');
    expect(verifier.runFullChallenge).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a genuine verification mismatch (wrong nonce / identity fail)', async () => {
    const mismatch = {
      status: 'FAILED' as AgentStatus,
      responses: [
        challengeResponse({
          type: 'identity-echo',
          error: 'Identity mismatch: model "grok-3" does not match manifest pattern /^claude/i',
        }),
      ],
    };
    const verifier = fakeVerifier([mismatch]);

    const result = await runFullChallengeWithTransientRetry(verifier, 'agent-1', session, manifest);

    expect(result.status).toBe('FAILED');
    expect(result.responses[0].error).toMatch(/Identity mismatch/);
    expect(verifier.runFullChallenge).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a clean VERIFIED result (nothing to retry)', async () => {
    const success = {
      status: 'VERIFIED' as AgentStatus,
      responses: [challengeResponse({ success: true })],
    };
    const verifier = fakeVerifier([success]);

    const result = await runFullChallengeWithTransientRetry(verifier, 'agent-1', session, manifest);

    expect(result.status).toBe('VERIFIED');
    expect(verifier.runFullChallenge).toHaveBeenCalledTimes(1);
  });

  it('returns the second attempt result even when it ALSO fails (no third attempt)', async () => {
    const transientFail = {
      status: 'FAILED' as AgentStatus,
      responses: [challengeResponse({ error: 'network error: fetch failed' })],
    };
    const stillFailingButTransient = {
      status: 'FAILED' as AgentStatus,
      responses: [challengeResponse({ error: '503 Service Unavailable' })],
    };
    const verifier = fakeVerifier([transientFail, stillFailingButTransient]);

    const resultPromise = runFullChallengeWithTransientRetry(verifier, 'agent-1', session, manifest);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    // Second attempt's result is final — no third call even though it's also transient-shaped.
    expect(result.status).toBe('FAILED');
    expect(result.responses[0].error).toBe('503 Service Unavailable');
    expect(verifier.runFullChallenge).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Remote-workspace nonce writer (hermes#remote seat, 2026-07-18): a seat's
// transport may declare `workspace: {kind:'ssh', host, dir}` to redirect
// ONLY that seat's nonce-file challenge onto an SSH-reachable machine
// instead of this laptop's local workspaceRoot. child_process is mocked
// (see top of file) so these tests never shell out to a real `ssh` binary.
// ============================================================================

describe('resolveSshWorkspace (transport.workspace parsing)', () => {
  it('parses a complete {kind:"ssh", host, dir} workspace', () => {
    const config: AdapterConfig = {
      transport: { workspace: { kind: 'ssh', host: 'macmini', dir: '/Users/z/agent-os-nonce' } },
    };
    expect(resolveSshWorkspace(config)).toEqual({
      kind: 'ssh',
      host: 'macmini',
      dir: '/Users/z/agent-os-nonce',
    });
  });

  it('trims whitespace off host and dir', () => {
    const config: AdapterConfig = {
      transport: { workspace: { kind: 'ssh', host: '  macmini  ', dir: '  /a/b  ' } },
    };
    expect(resolveSshWorkspace(config)).toEqual({ kind: 'ssh', host: 'macmini', dir: '/a/b' });
  });

  it('returns undefined when no workspace is declared (every seat before hermes#remote)', () => {
    expect(resolveSshWorkspace({ transport: {} })).toBeUndefined();
    expect(resolveSshWorkspace({ transport: { source: 'Remote box · Hermes app' } })).toBeUndefined();
  });

  it('returns undefined for a non-"ssh" kind', () => {
    expect(
      resolveSshWorkspace({ transport: { workspace: { kind: 'local', host: 'macmini', dir: '/a' } } })
    ).toBeUndefined();
  });

  it('returns undefined when host or dir is missing, blank, or non-string', () => {
    expect(resolveSshWorkspace({ transport: { workspace: { kind: 'ssh', dir: '/a' } } })).toBeUndefined();
    expect(
      resolveSshWorkspace({ transport: { workspace: { kind: 'ssh', host: '   ', dir: '/a' } } })
    ).toBeUndefined();
    expect(resolveSshWorkspace({ transport: { workspace: { kind: 'ssh', host: 'macmini' } } })).toBeUndefined();
    expect(
      resolveSshWorkspace({ transport: { workspace: { kind: 'ssh', host: 42, dir: '/a' } } })
    ).toBeUndefined();
  });

  it('returns undefined for a non-object workspace value (malformed config degrades to local, not a throw)', () => {
    expect(resolveSshWorkspace({ transport: { workspace: 'macmini' } })).toBeUndefined();
    expect(resolveSshWorkspace({ transport: { workspace: null } })).toBeUndefined();
  });
});

/** Minimal fake ChildProcess: an EventEmitter with stdin/stderr/kill, matching everything runSshCommand touches. */
function makeFakeSshChild(behavior: { exitCode?: number | null; stderr?: string; hang?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = { write: vi.fn(() => true), end: vi.fn() };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  if (!behavior.hang) {
    queueMicrotask(() => {
      if (behavior.stderr) child.stderr.emit('data', Buffer.from(behavior.stderr));
      child.emit('exit', behavior.exitCode ?? 0);
    });
  }
  return child;
}

describe('runSshCommand (ssh transport primitive)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns ssh with BatchMode=yes + ConnectTimeout and resolves {code:0} on a clean exit', async () => {
    spawnMock.mockReturnValue(makeFakeSshChild({ exitCode: 0 }) as unknown as ReturnType<typeof spawn>);

    const result = await runSshCommand('macmini', "mkdir -p '/tmp/x'");

    expect(result).toEqual({ code: 0, stderr: '' });
    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'macmini', "mkdir -p '/tmp/x'"],
      expect.any(Object)
    );
  });

  it('pipes `input` to stdin and never places it in the spawned argv', async () => {
    const child = makeFakeSshChild({ exitCode: 0 });
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    await runSshCommand('macmini', "cat > '/tmp/x/seat.nonce'", { input: 'super-secret-nonce-value' });

    expect(child.stdin.write).toHaveBeenCalledWith('super-secret-nonce-value');
    expect(child.stdin.end).toHaveBeenCalled();
    const [, args] = spawnMock.mock.calls[0];
    expect((args as string[]).join(' ')).not.toContain('super-secret-nonce-value');
  });

  it('surfaces a non-zero exit as {code, stderr} rather than throwing', async () => {
    spawnMock.mockReturnValue(
      makeFakeSshChild({ exitCode: 255, stderr: 'Permission denied (publickey).' }) as unknown as ReturnType<
        typeof spawn
      >
    );

    const result = await runSshCommand('macmini', "mkdir -p '/tmp/x'");

    expect(result.code).toBe(255);
    expect(result.stderr).toContain('Permission denied');
  });

  it('fails cleanly — does not hang — when the remote command never exits, bounded by timeoutMs', async () => {
    const child = makeFakeSshChild({ hang: true });
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const result = await runSshCommand('macmini', "cat > '/tmp/x/stuck.nonce'", { timeoutMs: 30 });

    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/timed out/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('connectAgent with an ssh workspace transport (hermes#remote remote nonce writer, end-to-end)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  /** Every ssh call in this suite succeeds (exit 0); captures each remote command string and any stdin content sent to it. */
  function mockSuccessfulSsh(): { commands: string[]; stdinWrites: string[] } {
    const commands: string[] = [];
    const stdinWrites: string[] = [];
    spawnMock.mockImplementation((_cmd, args) => {
      const remoteCommand = String((args as string[])[(args as string[]).length - 1]);
      commands.push(remoteCommand);
      const child = makeFakeSshChild({ exitCode: 0 });
      const originalWrite = child.stdin.write;
      child.stdin.write = vi.fn((data: string) => {
        stdinWrites.push(data);
        return originalWrite(data);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    return { commands, stdinWrites };
  }

  /**
   * A fake session that plays the part of the real Mini-housed agent: it
   * doesn't have local fs access to the (remote-looking) noncePath, so
   * instead of reading it back like `makeFakeSession` does, it "reads" the
   * nonce this test's mocked ssh write already captured — standing in for
   * an SSH read the real agent would perform against `ws.host`.
   */
  function makeSshAwareFakeSession(stdinWrites: string[]): AgentSession {
    return {
      send: async () => undefined,
      events: async function* () {
        /* no relay events needed for these tests */
      },
      prove: async (challenge) => {
        if (challenge.type === 'nonce-file') {
          return {
            challengeId: challenge.challengeId,
            type: 'nonce-file',
            success: true,
            data: { nonce: stdinWrites[stdinWrites.length - 1] },
            latencyMs: 1,
          };
        }
        if (challenge.type === 'identity-echo') {
          return {
            challengeId: challenge.challengeId,
            type: 'identity-echo',
            success: true,
            data: { modelId: 'claude-test' },
            latencyMs: 1,
          };
        }
        return {
          challengeId: challenge.challengeId,
          type: 'capability-probe',
          success: true,
          data: { capability: challenge.capability, result: 'ok' },
          latencyMs: 1,
        };
      },
      health: async () => fakeHealth(),
      interrupt: async () => undefined,
      dispose: async () => undefined,
    };
  }

  it('VERIFIED: writes and removes the nonce over SSH, never touching the local workspaceRoot, nonce never in argv', async () => {
    const { commands, stdinWrites } = mockSuccessfulSsh();
    registerAdapter('fake-harness-ssh-ws', {
      adapter: { manifest: fakeManifest, connect: async () => makeSshAwareFakeSession(stdinWrites) },
      getIdentityFromSession: async () => ({ modelId: 'claude-test', accountId: 'acct-1' }),
    });
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { agentId, status } = await connectAgent(
      'fake-harness-ssh-ws',
      { transport: { workspace: { kind: 'ssh', host: 'macmini', dir: '/Users/z/agent-os-nonce' } } },
      agents,
      workspaceRoot
    );

    expect(status).toBe('VERIFIED');
    expect(agentId).toBe('fake-harness-ssh-ws');

    // mkdir -p, cat > (write), rm -f (cleanup) — three ssh round-trips, all to the declared host.
    expect(commands).toHaveLength(3);
    expect(commands[0]).toMatch(/^mkdir -p '\/Users\/z\/agent-os-nonce'$/);
    expect(commands[1]).toMatch(/^cat > '\/Users\/z\/agent-os-nonce\/fake-harness-ssh-ws-.+\.nonce'$/);
    expect(commands[2]).toMatch(/^rm -f '\/Users\/z\/agent-os-nonce\/fake-harness-ssh-ws-.+\.nonce'$/);
    for (const call of spawnMock.mock.calls) {
      expect(call[0]).toBe('ssh');
      expect(call[1]).toContain('macmini');
    }

    // The nonce traveled over stdin exactly once, and never appears in any argv passed to spawn.
    expect(stdinWrites).toHaveLength(1);
    expect(stdinWrites[0]).toMatch(/^pol-/);
    const allArgv = spawnMock.mock.calls.map((c) => (c[1] as string[]).join(' ')).join('\n');
    expect(allArgv).not.toContain(stdinWrites[0]);
  });

  it('FAILS the challenge cleanly (not a hang) when the SSH nonce write fails, e.g. an auth/connect error', async () => {
    spawnMock.mockImplementation((_cmd, args) => {
      const remoteCommand = String((args as string[])[(args as string[]).length - 1]);
      if (remoteCommand.startsWith('mkdir')) {
        return makeFakeSshChild({ exitCode: 0 }) as unknown as ReturnType<typeof spawn>;
      }
      // The write itself (`cat > ...`) fails — e.g. the remote host is unreachable or the key is rejected.
      return makeFakeSshChild({
        exitCode: 255,
        stderr: 'Permission denied (publickey).',
      }) as unknown as ReturnType<typeof spawn>;
    });
    registerFakeAdapter('fake-harness-ssh-ws-fail');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { status, statusReason } = await connectAgent(
      'fake-harness-ssh-ws-fail',
      { transport: { workspace: { kind: 'ssh', host: 'macmini', dir: '/Users/z/agent-os-nonce' } } },
      agents,
      workspaceRoot
    );

    expect(status).toBe('FAILED');
    expect(statusReason).toMatch(/remote nonce write failed/);
  });

  it('a seat with NO workspace declared is unaffected — connects via the local fs writer, never calls ssh', async () => {
    registerFakeAdapter('fake-harness-no-ssh-ws');
    const agents = new Map<string, AgentState>();
    const workspaceRoot = freshWorkspaceRoot();

    const { status } = await connectAgent(
      'fake-harness-no-ssh-ws',
      { transport: {} },
      agents,
      workspaceRoot
    );

    expect(status).toBe('VERIFIED');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
