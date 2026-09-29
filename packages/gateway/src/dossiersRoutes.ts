/**
 * Agent Dossiers — dashboard surface v1.1. `GET /api/dossiers/:seatId` only —
 * no create/edit/delete route exists or is planned for v1 ("acceptance
 * freezes it"). Returns RAW MARKDOWN + mtime; the gateway never renders
 * markdown to HTML (F9) — the client renders through the same audited
 * renderMarkdown/DOMPurify path chat already uses, with dossier-mode
 * hardening (packages/ui/src/lib/markdown.ts's renderDossierMarkdown).
 *
 * Context is the SAME threaded-context idiom as every other route file
 * (workshopRoutes.ts, bridge.ts, pollsRoutes.ts) — no module-scoped globals,
 * unit-testable against a throwaway Fastify instance + fake deps.
 */

import { readFileSync, statSync } from 'fs';
import type { FastifyInstance } from 'fastify';
import { resolveDossierPath } from './dossiers.js';

export interface DossiersRouteContext {
  /** Gateway-local config knob (dossiers.ts's dossiersDir()) — threaded rather than read directly so tests can fake it without touching process.env. */
  dossiersDir: () => string | undefined;
  /** The STATIC roster (agents.ts's knownManifestIds()) — see dossiers.ts's isKnownSeatId doc comment for why this is NOT the live connected/VERIFIED agents map. */
  knownManifestIds: () => string[];
}

/**
 * Registered unconditionally (same convention as every other /api/* route in
 * this file set) — when dossiersDir is unset the handler itself 404s on
 * every request, which is indistinguishable from the route not existing at
 * all from a caller's point of view ("Feature absent (not erroring) when
 * dossiersDir unset" — the original design acceptance). REST, loopback trust model,
 * same as every other /api/* route (no new auth system).
 */
export function registerDossiersRoute(fastify: FastifyInstance, ctx: DossiersRouteContext): void {
  fastify.get<{ Params: { seatId: string } }>('/api/dossiers/:seatId', async (req, reply) => {
    const result = resolveDossierPath(ctx.dossiersDir(), req.params.seatId, ctx.knownManifestIds());
    if (!result.ok) {
      // Every failure branch (unconfigured, unknown seat, traversal-shaped
      // seatId, symlink, no dossier written yet) is a plain 404 with the
      // same generic message — see resolveDossierPath's doc comment for why
      // these must be indistinguishable from the outside.
      reply.code(404);
      return { error: 'Dossier not found' };
    }

    let markdown: string;
    let mtime: number;
    try {
      markdown = readFileSync(result.path, 'utf8');
      mtime = statSync(result.path).mtimeMs;
    } catch (e) {
      // TOCTOU: the file could vanish between resolveDossierPath's lstat and
      // this read (another process editing it, an unlikely race) — fail
      // closed as a 404, not a 500; a transient miss is not a server error.
      console.error(`[dossiers] read failed for a path that just resolved: ${(e as Error).message}`);
      reply.code(404);
      return { error: 'Dossier not found' };
    }

    // RAW markdown, verbatim — no server-side rendering (F9). The client is
    // the only place this is ever turned into HTML.
    return { markdown, mtime };
  });
}
