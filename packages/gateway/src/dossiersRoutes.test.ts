import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDossiersRoute, type DossiersRouteContext } from './dossiersRoutes.js';

/**
 * A TEMP COPY of the live seeded convention file's content
 * (Team/dossiers/grok-build.md, verbatim as of 2026-07-09) — embedded here
 * rather than read from the live path at test time, per the task brief
 * ("don't depend on the live path in tests"): this suite must still pass
 * (and never touch/corrupt the real vault file) on a machine, clone, or CI
 * runner where that path doesn't exist. Exercises the exact real-world shape
 * this route has to handle: a top-level heading, dated bullet entries with
 * out-of-tree relative markdown links (`../../Projects/...`), no images.
 */
const seededGrokBuildMarkdown = [
  '# Dossier: grok-build (Grok Composer + #fast "Grok 4.5" instance)',
  '',
  'Current model: Grok 4.5 (#fast instance) / Composer (main seat), as of 2026-07.',
  '',
  '## Strengths',
  '',
  '- 2026-07-09 · Fable · [GATE-wave6](../../Projects/agent-os/docs/GATE-2026-07-09-wave6.md):',
  '  where its free review actually landed (voice branch), it independently found',
  '  the same 2 dictation defects Fable\'s review found. Review quality is real —',
  '  worth the wake-up when the bridge delivers it.',
  '',
  '## Gotchas',
  '',
  '- 2026-07-09 · Fable · [TECH-DEBT Wave 7 queue](../../Projects/agent-os/docs/TECH-DEBT.md):',
  '  #fast instance currently connects but fails nonce/capability verification',
  '  after a gateway restart — its CLI turns end "stopReason: Cancelled". Don\'t',
  '  assign it review work until the Wave 7 fix lands; the main Composer seat',
  '  verifies fine.',
  '',
].join('\n');

const ROSTER = ['hermes', 'claude-code', 'grok-build', 'openclaw', 'ollama'];

interface Harness {
  fastify: FastifyInstance;
  baseUrl: string;
  fixtureRoot: string;
  dossiersDirPath: string;
  setDir: (dir: string | undefined) => void;
}

async function buildHarness(): Promise<Harness> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dossiers-route-test-'));
  const dossiersDirPath = join(fixtureRoot, 'dossiers');
  mkdirSync(dossiersDirPath, { recursive: true });

  let currentDir: string | undefined = dossiersDirPath;
  const ctx: DossiersRouteContext = {
    dossiersDir: () => currentDir,
    knownManifestIds: () => ROSTER,
  };

  const fastify = Fastify({ logger: false });
  registerDossiersRoute(fastify, ctx);
  const baseUrl = await fastify.listen({ port: 0, host: '127.0.0.1' });

  return {
    fastify,
    baseUrl,
    fixtureRoot,
    dossiersDirPath,
    setDir: (dir) => {
      currentDir = dir;
    },
  };
}

async function getDossier(baseUrl: string, seatId: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/dossiers/${encodeURIComponent(seatId)}`);
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

describe('GET /api/dossiers/:seatId', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.fastify.close();
    rmSync(h.fixtureRoot, { recursive: true, force: true });
  });

  it('returns 404, not erroring, when dossiersDir is unset — feature absent by default', async () => {
    h.setDir(undefined);
    const { status, json } = await getDossier(h.baseUrl, 'grok-build');
    expect(status).toBe(404);
    expect(json.error).toBeTruthy();
  });

  it('returns raw markdown + mtime for a seeded dossier, untouched (no server-side rendering, F9)', async () => {
    const raw = '# Grok Build\n\n<script>alert(1)</script>\n\n- 2026-07-09 · Fable: a tip.\n';
    writeFileSync(join(h.dossiersDirPath, 'grok-build.md'), raw, 'utf8');

    const { status, json } = await getDossier(h.baseUrl, 'grok-build');
    expect(status).toBe(200);
    // Byte-for-byte identical, including the raw <script> tag — the gateway
    // must never sanitize/render; that is entirely the client's job.
    expect(json.markdown).toBe(raw);
    expect(typeof json.mtime).toBe('number');
    expect(json.mtime).toBeGreaterThan(0);
  });

  it('resolves an instance-suffixed seatId to the SAME manifest-level dossier (F11)', async () => {
    const raw = '# Grok Build\n';
    writeFileSync(join(h.dossiersDirPath, 'grok-build.md'), raw, 'utf8');

    const { status, json } = await getDossier(h.baseUrl, 'grok-build#judge');
    expect(status).toBe(200);
    expect(json.markdown).toBe(raw);
  });

  it('404s for a seat outside the static roster', async () => {
    const { status } = await getDossier(h.baseUrl, 'not-a-real-harness');
    expect(status).toBe(404);
  });

  it('404s for a path-traversal-shaped seatId (roster-rejected before any path math)', async () => {
    const { status } = await getDossier(h.baseUrl, '..%2f..%2fetc%2fpasswd');
    expect(status).toBe(404);
  });

  it('404s for a roster-valid seat with no dossier written yet (honest empty state)', async () => {
    const { status } = await getDossier(h.baseUrl, 'ollama');
    expect(status).toBe(404);
  });

  it('404s (never serves the target) when the manifest-named file is a symlink', async () => {
    const secretPath = join(h.fixtureRoot, 'secret.txt');
    writeFileSync(secretPath, 'never serve this', 'utf8');
    symlinkSync(secretPath, join(h.dossiersDirPath, 'grok-build.md'), 'file');

    const { status, json } = await getDossier(h.baseUrl, 'grok-build');
    expect(status).toBe(404);
    expect(JSON.stringify(json)).not.toContain('never serve this');
  });

  it('is GET-only — POST to the same path is rejected (v1 acceptance: "no editing from the dashboard")', async () => {
    const res = await fetch(`${h.baseUrl}/api/dossiers/grok-build`, { method: 'POST' });
    // Fastify's default for an unregistered method on a registered path is
    // 404 (no route matches POST + this path — only GET was ever
    // registered); either way, it must NOT succeed.
    expect(res.status).not.toBe(200);
  });

  it('renders the seeded grok-build.md shape end to end: bare seatId AND its #instance both resolve, raw and byte-identical (design doc acceptance)', async () => {
    writeFileSync(join(h.dossiersDirPath, 'grok-build.md'), seededGrokBuildMarkdown, 'utf8');

    const bare = await getDossier(h.baseUrl, 'grok-build');
    expect(bare.status).toBe(200);
    expect(bare.json.markdown).toBe(seededGrokBuildMarkdown);
    // Out-of-tree relative links (../../Projects/...) travel through
    // untouched — the gateway does no link rewriting/resolution; degrading
    // them to plain, non-erroring text is entirely lib/markdown.ts's job on
    // the client, exercised separately (this only proves the gateway hands
    // the client the raw bytes to do that with).
    expect(bare.json.markdown).toContain('../../Projects/agent-os/docs/GATE-2026-07-09-wave6.md');

    const instanced = await getDossier(h.baseUrl, 'grok-build#fast');
    expect(instanced.status).toBe(200);
    expect(instanced.json.markdown).toBe(seededGrokBuildMarkdown);
  });
});
