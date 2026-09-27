/**
 * POST /presence/temp/start and POST /presence/temp/end — the ONLY way
 * anything outside the gateway process touches the ephemeral presence
 * registry (ephemeral.ts). REST, loopback trust model — same convention as
 * every other /api/* route in this file set (escalateRoutes.ts, bridge.ts,
 * pollsRoutes.ts: "the gateway binds 127.0.0.1 and trusts local callers;
 * this endpoint invents no new auth system"). Not under /api/ because this
 * lane is deliberately NOT part of the agents/rooms/polls surface those
 * routes share — see ephemeral.ts's module doc comment for why temps are a
 * separate lane from seats.
 *
 * Validation style matches the rest of this codebase (escalateRoutes.ts,
 * bridge.ts): plain typeof/trim checks + a 400 on anything malformed, no
 * schema library — there is no zod (or any other validation library) as a
 * dependency anywhere in this repo (checked package.json across every
 * workspace before writing this), so introducing one here would be a new,
 * unreviewed dependency rather than "following an existing pattern".
 *
 * Context is the same threaded-context idiom as every other route file — no
 * module-scoped globals, unit-testable against a throwaway Fastify instance.
 */

import type { FastifyInstance } from 'fastify';
import type { EphemeralAnnounceInput, EphemeralMeta, EphemeralPresenceRegistry } from './ephemeral.js';

export interface EphemeralRouteContext {
  registry: EphemeralPresenceRegistry;
  /** Called after a mutation that should reach every open tab — index.ts wires this to `() => broadcast(buildStateSync())`. Not called for a request that fails validation (nothing changed). */
  onChange: () => void;
}

const KIND_TEMP = 'temp' as const;
const MAX_ID_LEN = 200;
const MAX_LABEL_LEN = 200;
const MAX_META_VALUE_LEN = 200;
const MAX_META_KEYS = 10;
const KNOWN_META_KEYS = new Set(['role', 'jobSlug', 'tempId']);

function isNonBlankString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

/**
 * Validates the optional `meta` object: plain string-valued keys only,
 * capped in count and per-value length so a malformed/hostile caller can't
 * balloon the in-memory registry or the state.sync payload. Unknown keys are
 * REJECTED (not silently dropped) — "reject unknown/missing fields cleanly
 * with 400" per the design note — except that the known meta keys
 * (role/jobSlug/tempId) are the only ones ever produced by the intended
 * caller (run-queue.mjs), so this stays a closed, reviewable shape.
 */
function validateMeta(value: unknown): { ok: true; meta?: EphemeralMeta } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'meta must be an object' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_META_KEYS) {
    return { ok: false, error: `meta may have at most ${MAX_META_KEYS} keys` };
  }
  const meta: EphemeralMeta = {};
  for (const [key, v] of entries) {
    if (!KNOWN_META_KEYS.has(key)) {
      return { ok: false, error: `meta.${key} is not a recognized field (expected one of: ${[...KNOWN_META_KEYS].join(', ')})` };
    }
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > MAX_META_VALUE_LEN) {
      return { ok: false, error: `meta.${key} must be a string of at most ${MAX_META_VALUE_LEN} chars` };
    }
    meta[key] = v;
  }
  return { ok: true, meta: entries.length > 0 ? meta : undefined };
}

export function registerEphemeralRoutes(fastify: FastifyInstance, ctx: EphemeralRouteContext): void {
  fastify.post<{ Body: Record<string, unknown> }>('/presence/temp/start', async (req, reply) => {
    const body = req.body ?? {};

    if (!isNonBlankString(body.id, MAX_ID_LEN)) {
      reply.code(400);
      return { error: 'id is required (non-blank string, max 200 chars)' };
    }
    if (!isNonBlankString(body.label, MAX_LABEL_LEN)) {
      reply.code(400);
      return { error: 'label is required (non-blank string, max 200 chars)' };
    }
    if (body.kind !== KIND_TEMP) {
      reply.code(400);
      return { error: `kind must be "${KIND_TEMP}"` };
    }
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs)) {
      reply.code(400);
      return { error: 'ttlMs is required (finite number, milliseconds)' };
    }
    const metaResult = validateMeta(body.meta);
    if (!metaResult.ok) {
      reply.code(400);
      return { error: metaResult.error };
    }

    const input: EphemeralAnnounceInput = {
      id: body.id.trim(),
      label: body.label.trim(),
      kind: KIND_TEMP,
      meta: metaResult.meta,
    };
    const stored = ctx.registry.announce(input, body.ttlMs);
    ctx.onChange();

    reply.code(200);
    return { ok: true, entry: stored };
  });

  fastify.post<{ Body: Record<string, unknown> }>('/presence/temp/end', async (req, reply) => {
    const body = req.body ?? {};
    if (!isNonBlankString(body.id, MAX_ID_LEN)) {
      reply.code(400);
      return { error: 'id is required (non-blank string, max 200 chars)' };
    }

    const removed = ctx.registry.clear(body.id.trim());
    if (removed) ctx.onChange();

    reply.code(200);
    return { ok: true, removed };
  });
}
