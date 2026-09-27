import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterConfig } from '@agent-os/shared';
import { chatCompletion, endpointOf, modelOf } from './httpClient.js';

const baseConfig: AdapterConfig = {
  transport: { endpoint: 'http://127.0.0.1:11500/v1', model: 'qwen2.5:7b' },
};

describe('endpointOf / modelOf', () => {
  it('throws a clear error when transport.endpoint is missing', () => {
    expect(() => endpointOf({ transport: {} })).toThrow(/transport.endpoint is required/);
  });

  it('throws a clear error when transport.model is missing', () => {
    expect(() => modelOf({ transport: {} })).toThrow(/transport.model is required/);
  });

  it('strips a trailing slash from the endpoint', () => {
    expect(endpointOf({ transport: { endpoint: 'http://x:1/v1/' } })).toBe('http://x:1/v1');
  });
});

describe('chatCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the OpenAI-compatible shape and extracts text/model/usage from the response', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          model: 'qwen2.5:7b',
          choices: [{ message: { content: 'hello there' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion(baseConfig, [{ role: 'user', content: 'hi' }]);

    expect(capturedUrl).toBe('http://127.0.0.1:11500/v1/chat/completions');
    expect(capturedBody.model).toBe('qwen2.5:7b');
    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('hello there');
    expect(result.reportedModel).toBe('qwen2.5:7b');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it('throws a descriptive error when the endpoint is unreachable (network failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    await expect(chatCompletion(baseConfig, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /Endpoint unreachable/
    );
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('model not found', { status: 404 }))
    );

    await expect(chatCompletion(baseConfig, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /Endpoint returned 404/
    );
  });

  it('throws a descriptive error on a non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 }))
    );

    await expect(chatCompletion(baseConfig, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /non-JSON body/
    );
  });

  it('returns empty text (not a throw) when choices are missing — caller decides what that means', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ model: 'qwen2.5:7b' }), { status: 200 }))
    );

    const result = await chatCompletion(baseConfig, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('');
  });
});
