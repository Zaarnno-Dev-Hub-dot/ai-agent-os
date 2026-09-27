import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterConfig } from '@agent-os/shared';
import { hermesAdapter } from './index.js';

/**
 * Regression test for Milestone C item 5a (docs/DESIGN-token-budgets.md §3):
 * hermes's send() must rotate to a fresh session_id EVERY chat turn instead
 * of reusing config.sessionId, because hermes's session_id accumulates the
 * whole conversation server-side (root cause of the 220k/78k/58k tokens-in
 * growth in RELAY-SMOKE-2026-07-04). Mocks fetch end-to-end through the
 * exported hermesAdapter (HermesSession itself is not exported) and asserts
 * consecutive turns post different session_id values, both derived from the
 * configured base sessionId.
 */
describe('HermesSession.send session rotation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a fresh session_id per turn instead of the static config.sessionId', async () => {
    const runBodies: Array<Record<string, unknown>> = [];

    function sseResponse(): Response {
      const body = `data: ${JSON.stringify({ event: 'run.completed' })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/health/detailed')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'hermes-test' }] }), { status: 200 });
      }
      if (u.endsWith('/v1/runs')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        runBodies.push(body);
        return new Response(JSON.stringify({ run_id: `run-${runBodies.length}` }), { status: 200 });
      }
      if (u.includes('/events')) {
        return sseResponse();
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const config: AdapterConfig = {
      transport: { apiKey: 'test-key' },
      sessionId: 'base-session',
    };

    const session = await hermesAdapter.connect(config);
    await session.send({ role: 'user', senderId: 'human', content: 'first turn' });
    // send() kicks off the SSE pump without awaiting it; give the mocked
    // stream a tick to deliver run.completed and clear activeRunId before
    // the next turn (mirrors the relay's real usage: it waits for
    // message-complete before enqueuing the next job for the same worker).
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.send({ role: 'user', senderId: 'human', content: 'second turn' });

    expect(runBodies).toHaveLength(2);
    const [first, second] = runBodies;
    expect(first.session_id).not.toBe(second.session_id);
    // Format: <base>-<startedAt ms>-turn-<n>. The startedAt segment is what
    // keeps a reconnected session's "-turn-1" from colliding with (and
    // re-inheriting the server-side history of) the previous connection's
    // "-turn-1" — see the reviewer note in send().
    expect(first.session_id).toMatch(/^base-session-\d+-turn-1$/);
    expect(second.session_id).toMatch(/^base-session-\d+-turn-2$/);
    expect(first.session_id).not.toBe('base-session');
    expect(second.session_id).not.toBe('base-session');
  });
});
