import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
// Static import is fine despite the vi.mock('fs', ...) below being written
// textually after it — Vitest hoists vi.mock() calls to the very top of the
// file (above every import, regardless of source position), specifically so
// a mocked dependency is in place before the module under test loads it.
import { MemoryIndex } from './memory.js';

/**
 * m-WM-4 (Fable triage ruling, 2026-07-21): "denylist path never unit-tested".
 * Covers memory.ts's privacy-denylist logic (loadPrivacyDenylist /
 * isPrivacyDenylistedPath, both internal — exercised here purely through the
 * public MemoryIndex API) for the three behaviors the ruling names:
 *   1. fail-closed on empty/unreadable/unparseable denylist terms
 *   2. pathPrefixes exclusion
 *   3. the "private/" path-segment convention
 *
 * This is a SEPARATE test file (not added to memory.test.ts) specifically so
 * the `vi.mock('fs', ...)` below — needed to feed loadPrivacyDenylist() a
 * controlled denylist file without ever touching the real, shared
 * Team\specs\privacy-denylist.json on disk — stays scoped to this file only.
 * Vitest gives every test file its own module registry by default, so this
 * mock cannot leak into memory.test.ts's real-fs-based suite.
 */

// Must match memory.ts's PRIVACY_DENYLIST_PATH exactly (that constant is not
// exported — memory.ts has no reason to export a hardcoded absolute path —
// so this is intentionally a literal, not an import).
const DENYLIST_PATH = './config/privacy-denylist.json';

const { denylistState } = vi.hoisted(() => ({
  // null = "file missing" (throws ENOENT, exercising the same catch-branch
  // fail-closed path a real missing file would). 'THROW' = simulate a
  // present-but-unreadable file (e.g. EACCES). A string = the raw file
  // content returned as-is (so a test can feed invalid JSON too).
  denylistState: { content: null as string | 'THROW' | null },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (path === DENYLIST_PATH) {
        if (denylistState.content === null) {
          const err = new Error(`ENOENT: no such file (test stub) '${DENYLIST_PATH}'`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        if (denylistState.content === 'THROW') {
          const err = new Error(`EACCES: permission denied (test stub) '${DENYLIST_PATH}'`) as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return denylistState.content;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

let vaultRoot: string;

function write(relPath: string, content: string) {
  const abs = join(vaultRoot, ...relPath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  denylistState.content = null;
  vaultRoot = mkdtempSync(join(tmpdir(), 'memory-denylist-test-'));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('privacy denylist — fail-closed loading', () => {
  it('indexes nothing when the denylist file has terms: [] (empty terms = fail-closed, not "no restrictions")', () => {
    denylistState.content = JSON.stringify({ terms: [], pathPrefixes: [] });
    write('Memory/Public/Hello.md', '# Hello\n\nOrdinary, otherwise-indexable content.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.size()).toBe(0);
  });

  it('indexes nothing when the denylist file is unparseable JSON (fail-closed, not "ignore and continue")', () => {
    denylistState.content = 'not json {{{';
    write('Memory/Public/Hello.md', '# Hello\n\nOrdinary, otherwise-indexable content.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.size()).toBe(0);
  });

  it('indexes nothing when the denylist file is missing/unreadable (fail-closed, not "run without a denylist")', () => {
    denylistState.content = 'THROW';
    write('Memory/Public/Hello.md', '# Hello\n\nOrdinary, otherwise-indexable content.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.size()).toBe(0);
  });

  it('indexes normally once the denylist file is present with usable terms (control case — proves the above are real fail-closed assertions, not an always-empty vault)', () => {
    denylistState.content = JSON.stringify({ terms: ['zzz-nonmatching-term-xyz'], pathPrefixes: [] });
    write('Memory/Public/Hello.md', '# Hello\n\nOrdinary, otherwise-indexable content.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.size()).toBe(1);
  });
});

describe('privacy denylist — pathPrefixes exclusion', () => {
  it('excludes a note under a denylisted pathPrefix while indexing an unrelated note normally', () => {
    denylistState.content = JSON.stringify({
      terms: ['zzz-nonmatching-term-xyz'],
      pathPrefixes: ['Memory/Public/blocked'],
    });
    write('Memory/Public/blocked/Secret.md', '# Secret\n\nMust never be indexed.');
    write('Memory/Public/Visible.md', '# Visible\n\nMust be indexed normally.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    const paths = index.search('').map((n) => n.path);
    expect(paths).not.toContain('Memory/Public/blocked/Secret.md');
    expect(paths).toContain('Memory/Public/Visible.md');
  });

  it('matches pathPrefixes case-insensitively', () => {
    denylistState.content = JSON.stringify({
      terms: ['zzz-nonmatching-term-xyz'],
      pathPrefixes: ['MEMORY/PUBLIC/BLOCKED'],
    });
    write('Memory/Public/blocked/Secret.md', '# Secret\n\nMust never be indexed.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.search('').map((n) => n.path)).not.toContain('Memory/Public/blocked/Secret.md');
  });
});

describe('privacy denylist — "private/" path-segment convention', () => {
  it('excludes any note under a path segment literally named "private", even outside pathPrefixes', () => {
    denylistState.content = JSON.stringify({ terms: ['zzz-nonmatching-term-xyz'], pathPrefixes: [] });
    write('Memory/Public/private/Secret.md', '# Secret\n\nMust never be indexed (private/ convention).');
    write('Memory/Public/Visible.md', '# Visible\n\nMust be indexed normally.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    const paths = index.search('').map((n) => n.path);
    expect(paths).not.toContain('Memory/Public/private/Secret.md');
    expect(paths).toContain('Memory/Public/Visible.md');
  });

  it('matches the "private" segment case-insensitively', () => {
    denylistState.content = JSON.stringify({ terms: ['zzz-nonmatching-term-xyz'], pathPrefixes: [] });
    write('Memory/Public/Private/Secret.md', '# Secret\n\nMust never be indexed.');

    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.search('').map((n) => n.path)).not.toContain('Memory/Public/Private/Secret.md');
  });
});
