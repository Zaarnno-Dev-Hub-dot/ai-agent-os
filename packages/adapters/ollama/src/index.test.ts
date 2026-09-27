import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterConfig, AgentEvent, Challenge } from '@agent-os/shared';
import { AdapterError } from '@agent-os/shared';
import { ollamaAdapter, ollamaManifest, getIdentityFromOllamaSession } from './index.js';
import type { AttestedNonceChallenge, AttestedProbeChallenge } from './attestedProtocol.js';

const config: AdapterConfig = {
  transport: { endpoint: 'http://127.0.0.1:11500/v1', model: 'qwen2.5:7b' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Every fetch in these tests hits the same completions endpoint — reply with `content` regardless of the prompt, unless a test wants per-call control. */
function stubChatCompletions(content: string, model = 'qwen2.5:7b') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      jsonResponse({ model, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    )
  );
}

describe('ollamaManifest', () => {
  it('declares the attested verification tier', () => {
    expect(ollamaManifest.verification).toBe('attested');
  });

  it('declares no tool-ish capabilities (that is the whole reason it needs the attested tier)', () => {
    expect(ollamaManifest.capabilities.some((c) => c.toLowerCase().includes('tool'))).toBe(false);
  });

  it('identity.modelPattern accepts well-formed model ids and rejects anything else', () => {
    const re = new RegExp(ollamaManifest.identity.modelPattern, 'i');
    expect(re.test('qwen2.5:7b')).toBe(true);
    expect(re.test('gpt-4o-mini')).toBe(true);
    expect(re.test('openai/gpt-4o')).toBe(true);
    expect(re.test('evil; echo pwned')).toBe(false);
    expect(re.test('')).toBe(false);
  });
});

describe('ollamaAdapter.connect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects when the endpoint responds', async () => {
    stubChatCompletions('OK', 'qwen2.5:7b');
    const session = await ollamaAdapter.connect(config);
    const health = await session.health();
    expect(health.modelId).toBe('qwen2.5:7b');
  });

  it('throws AdapterError(endpoint-down) when the endpoint is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    await expect(ollamaAdapter.connect(config)).rejects.toMatchObject({
      code: 'endpoint-down',
    } satisfies Partial<AdapterError>);
  });

  it('throws AdapterError(handshake-failed) on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'model not found' }, 404)));
    await expect(ollamaAdapter.connect(config)).rejects.toMatchObject({
      code: 'handshake-failed',
    } satisfies Partial<AdapterError>);
  });
});

describe('getIdentityFromOllamaSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the model id captured at connect time', async () => {
    stubChatCompletions('OK', 'llama3.2:3b');
    const session = await ollamaAdapter.connect({ transport: { endpoint: config.transport.endpoint as string, model: 'llama3.2:3b' } });
    const identity = await getIdentityFromOllamaSession(session);
    expect(identity.modelId).toBe('llama3.2:3b');
  });
});

describe('OllamaSession.send / events', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits a token then message-complete for a real turn', async () => {
    stubChatCompletions('hello there');
    const session = await ollamaAdapter.connect(config);
    await session.send({ role: 'user', senderId: 'human', senderName: 'You', content: 'hi' });

    const events: AgentEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === 'message-complete') break;
    }
    expect(events.some((e) => e.type === 'token' && e.delta === 'hello there')).toBe(true);
    expect(events.at(-1)?.type).toBe('message-complete');
  });

  it('reports an error event (not a throw) when the endpoint fails mid-turn', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ model: 'qwen2.5:7b', choices: [{ message: { content: 'OK' } }] });
        throw new TypeError('fetch failed');
      })
    );
    const session = await ollamaAdapter.connect(config);
    await session.send({ role: 'user', senderId: 'human', content: 'hi' });

    const events: AgentEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === 'message-complete') break;
    }
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

describe('OllamaSession.prove — attested challenge kinds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attested-nonce: does the live round trip and reports the raw text back verbatim (does not judge correctness itself)', async () => {
    stubChatCompletions('{"nonce":"atn-whatever"}');
    const session = await ollamaAdapter.connect(config);

    const challenge: AttestedNonceChallenge = {
      type: 'attested-nonce',
      challengeId: 'c1',
      timestamp: Date.now(),
      timeoutMs: 5000,
      nonce: 'atn-whatever',
    };
    const response = await session.prove(challenge as unknown as Challenge);
    expect(response.success).toBe(true);
    expect((response.data as { raw?: string } | undefined)?.raw).toBe('{"nonce":"atn-whatever"}');
  });

  it('attested-probe: does the live round trip and reports the raw text back verbatim', async () => {
    stubChatCompletions('42');
    const session = await ollamaAdapter.connect(config);

    const challenge: AttestedProbeChallenge = {
      type: 'attested-probe',
      challengeId: 'c2',
      timestamp: Date.now(),
      timeoutMs: 5000,
      probeId: 'arithmetic',
      question: 'Reply with ONLY the sum of 20 and 22.',
    };
    const response = await session.prove(challenge as unknown as Challenge);
    expect(response.success).toBe(true);
    expect((response.data as { raw?: string } | undefined)?.raw).toBe('42');
  });

  it('identity-echo: reports the live-reported model id', async () => {
    stubChatCompletions('irrelevant text', 'qwen2.5:7b');
    const session = await ollamaAdapter.connect(config);
    const response = await session.prove({
      type: 'identity-echo',
      challengeId: 'c3',
      timestamp: Date.now(),
      timeoutMs: 5000,
    });
    expect(response.success).toBe(true);
    expect(response.data?.modelId).toBe('qwen2.5:7b');
  });

  it('nonce-file: fails honestly instead of faking a pass (this tier has no tools)', async () => {
    stubChatCompletions('OK');
    const session = await ollamaAdapter.connect(config);
    const response = await session.prove({
      type: 'nonce-file',
      challengeId: 'c4',
      timestamp: Date.now(),
      timeoutMs: 5000,
      noncePath: '/tmp/whatever',
    });
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/not supported by attested-tier tool-less seats/);
  });

  it('capability-probe: fails honestly instead of faking a pass', async () => {
    stubChatCompletions('OK');
    const session = await ollamaAdapter.connect(config);
    const response = await session.prove({
      type: 'capability-probe',
      challengeId: 'c5',
      timestamp: Date.now(),
      timeoutMs: 5000,
      capability: 'http-openai',
    });
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/not supported by attested-tier tool-less seats/);
  });
});
