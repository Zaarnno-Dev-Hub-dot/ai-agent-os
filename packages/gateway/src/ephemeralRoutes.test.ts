import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { EphemeralPresenceRegistry } from './ephemeral.js';
import { registerEphemeralRoutes } from './ephemeralRoutes.js';

/**
 * Real Fastify instance on an EPHEMERAL OS-assigned port (port: 0) — same
 * "never touch 4110" harness shape as escalateRoutes.test.ts/bridge.test.ts.
 */
async function buildServer() {
  const registry = new EphemeralPresenceRegistry();
  let changeCount = 0;
  const fastify = Fastify({ logger: false });
  registerEphemeralRoutes(fastify, { registry, onChange: () => { changeCount += 1; } });
  const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
  return { fastify, registry, address, getChangeCount: () => changeCount };
}

describe('POST /presence/temp/start and /presence/temp/end', () => {
  let ctx: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    ctx = await buildServer();
  });

  afterEach(async () => {
    await ctx.fastify.close();
  });

  it('start: valid body upserts into the registry and calls onChange', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'printify-daily-abc', label: 'printify-daily', kind: 'temp', ttlMs: 300_000, meta: { jobSlug: 'printify-daily' } }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.entry.id).toBe('printify-daily-abc');
    expect(ctx.registry.list()).toHaveLength(1);
    expect(ctx.getChangeCount()).toBe(1);
  });

  it('start: missing id -> 400, registry untouched, no onChange call', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x', kind: 'temp', ttlMs: 1000 }),
    });
    expect(res.status).toBe(400);
    expect(ctx.registry.list()).toHaveLength(0);
    expect(ctx.getChangeCount()).toBe(0);
  });

  it('start: wrong kind -> 400', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a', label: 'x', kind: 'seat', ttlMs: 1000 }),
    });
    expect(res.status).toBe(400);
  });

  it('start: missing ttlMs -> 400', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a', label: 'x', kind: 'temp' }),
    });
    expect(res.status).toBe(400);
  });

  it('start: unknown meta key -> 400 (unknown fields rejected, not silently dropped)', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a', label: 'x', kind: 'temp', ttlMs: 1000, meta: { evil: 'x' } }),
    });
    expect(res.status).toBe(400);
    expect(ctx.registry.list()).toHaveLength(0);
  });

  it('end: removes an existing entry and calls onChange', async () => {
    ctx.registry.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 60_000);
    const res = await fetch(`${ctx.address}/presence/temp/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.removed).toBe(true);
    expect(ctx.registry.list()).toHaveLength(0);
    expect(ctx.getChangeCount()).toBe(1);
  });

  it('end: unknown id -> 200 with removed:false, no onChange call (idempotent, never an error)', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'never-existed' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.removed).toBe(false);
    expect(ctx.getChangeCount()).toBe(0);
  });

  it('end: missing id -> 400', async () => {
    const res = await fetch(`${ctx.address}/presence/temp/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
