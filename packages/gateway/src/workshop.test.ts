import { describe, expect, it } from 'vitest';
import type { Room } from '@agent-os/shared';
import {
  buildUnifiedDiff,
  findWorkshopRoom,
  isUtf8Text,
  isValidSeatId,
  isValidTaskSlug,
  MAX_TARGETS,
  parseManifest,
  validateRepoPath,
  validateWorkspacePath,
  WORKSHOP_ROOM_NAME,
} from './workshop.js';

/**
 * Wave 6, docs/DESIGN-workshop-flow.md: every validation rule listed in the
 * design doc's "Validation" section gets its own test here, against the pure
 * functions directly — no fs/fastify/git needed for any of this (the
 * fs-backed end-to-end propose/apply flow is workshopRoutes.test.ts).
 */

describe('validateRepoPath — allowlist', () => {
  it('accepts packages/ui/src/*', () => {
    const r = validateRepoPath('packages/ui/src/App.tsx');
    expect(r.ok).toBe(true);
  });
  it('accepts packages/gateway/src/* (excluding relay.ts)', () => {
    const r = validateRepoPath('packages/gateway/src/newFeature.ts');
    expect(r.ok).toBe(true);
  });
  it('accepts docs/*', () => {
    const r = validateRepoPath('docs/DESIGN-something.md');
    expect(r.ok).toBe(true);
  });
  it('accepts the exact data/dock-apps.json single-file allowlist entry', () => {
    const r = validateRepoPath('data/dock-apps.json');
    expect(r.ok).toBe(true);
  });
  it('rejects a path not in the v1 allowlist', () => {
    const r = validateRepoPath('README.md');
    expect(r.ok).toBe(false);
    const r2 = validateRepoPath('packages/adapters/claude-code/src/index.ts');
    expect(r2.ok).toBe(false);
    const r3 = validateRepoPath('package.json');
    expect(r3.ok).toBe(false);
  });
  it('rejects data/ paths other than the one exact allowlisted file', () => {
    const r = validateRepoPath('data/polls.json');
    expect(r.ok).toBe(false);
  });
});

describe('validateRepoPath — DENY always wins, even inside an allowed prefix', () => {
  it('rejects packages/shared/ (frozen, BINDING)', () => {
    const r = validateRepoPath('packages/shared/src/types.ts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/frozen/i);
  });
  it('rejects packages/gateway/src/relay.ts exactly (frozen, BINDING) while sibling files under the same prefix are allowed', () => {
    const relay = validateRepoPath('packages/gateway/src/relay.ts');
    expect(relay.ok).toBe(false);
    if (!relay.ok) expect(relay.error).toMatch(/frozen/i);
    const sibling = validateRepoPath('packages/gateway/src/relayWindow.ts');
    expect(sibling.ok).toBe(true);
  });
  it('rejects scripts/', () => {
    const r = validateRepoPath('scripts/gate-live.mts');
    expect(r.ok).toBe(false);
  });
  it('a sibling directory that merely SHARES A PREFIX STRING with an allowed dir does not falsely match (prefix-boundary check)', () => {
    // "packages/gateway/src-evil/x" must NOT match the "packages/gateway/src/" allowlist prefix.
    const r = validateRepoPath('packages/gateway/src-evil/x.ts');
    expect(r.ok).toBe(false);
  });
});

describe('validateRepoPath — traversal / absolute / drive / malformed (fail-closed structural checks)', () => {
  it('rejects ".." traversal, including an attempt to escape an allowed prefix into a denied one', () => {
    expect(validateRepoPath('packages/gateway/src/../../shared/src/types.ts').ok).toBe(false);
    expect(validateRepoPath('docs/../../../etc/passwd').ok).toBe(false);
    expect(validateRepoPath('..').ok).toBe(false);
  });
  it('rejects an absolute path', () => {
    expect(validateRepoPath('/etc/passwd').ok).toBe(false);
  });
  it('rejects a Windows drive letter', () => {
    expect(validateRepoPath('C:/Windows/System32/x').ok).toBe(false);
    expect(validateRepoPath('c:/Windows/System32/x').ok).toBe(false);
  });
  it('rejects backslashes (POSIX-only wire format)', () => {
    expect(validateRepoPath('packages\\gateway\\src\\x.ts').ok).toBe(false);
  });
  it('rejects empty segments (double slash / trailing slash)', () => {
    expect(validateRepoPath('packages/gateway//src/x.ts').ok).toBe(false);
    expect(validateRepoPath('docs/').ok).toBe(false);
  });
  it('rejects a bare "." segment', () => {
    expect(validateRepoPath('docs/./x.md').ok).toBe(false);
  });
  it('rejects empty/whitespace/non-string input', () => {
    expect(validateRepoPath('').ok).toBe(false);
    expect(validateRepoPath('   ').ok).toBe(false);
    expect(validateRepoPath(undefined).ok).toBe(false);
    expect(validateRepoPath(42).ok).toBe(false);
  });
});

describe('validateRepoPath — dotfiles/.git denied always', () => {
  it('rejects a .git segment anywhere in the path', () => {
    expect(validateRepoPath('packages/gateway/src/.git/config').ok).toBe(false);
  });
  it('rejects a dotfile even under an otherwise-allowed prefix', () => {
    expect(validateRepoPath('docs/.hidden-notes.md').ok).toBe(false);
    expect(validateRepoPath('packages/ui/src/.env').ok).toBe(false);
  });
});

describe('validateRepoPath — case sensitivity fails closed', () => {
  it('a case-scrambled deny-list path is still rejected (falls through to "not in allowlist", not silently allowed)', () => {
    const r = validateRepoPath('Packages/Shared/x.ts');
    expect(r.ok).toBe(false);
  });
});

describe('validateWorkspacePath', () => {
  it('accepts a plain relative path', () => {
    expect(validateWorkspacePath('src/App.tsx').ok).toBe(true);
  });
  it('rejects traversal/absolute/drive/backslash exactly like repoPath structural checks', () => {
    expect(validateWorkspacePath('../../etc/passwd').ok).toBe(false);
    expect(validateWorkspacePath('/etc/passwd').ok).toBe(false);
    expect(validateWorkspacePath('C:/Windows/x').ok).toBe(false);
    expect(validateWorkspacePath('a\\b').ok).toBe(false);
  });
  it('does NOT apply the repoPath dotfile ban — a draft file named with a leading dot is fine (it never leaves the seat draft dir on its own)', () => {
    expect(validateWorkspacePath('.env.draft').ok).toBe(true);
  });
});

describe('parseManifest', () => {
  const validTarget = { workspacePath: 'a.md', repoPath: 'docs/a.md' };

  it('accepts a well-formed manifest', () => {
    const r = parseManifest({ title: 'Add a thing', description: 'why', targets: [validTarget] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.title).toBe('Add a thing');
      expect(r.manifest.targets).toHaveLength(1);
    }
  });
  it('trims title/description and drops an empty description', () => {
    const r = parseManifest({ title: '  Add a thing  ', description: '   ', targets: [validTarget] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.title).toBe('Add a thing');
      expect(r.manifest.description).toBeUndefined();
    }
  });
  it('rejects a non-object root', () => {
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest('hello').ok).toBe(false);
    expect(parseManifest(['a']).ok).toBe(false);
  });
  it('rejects a missing/empty title', () => {
    expect(parseManifest({ targets: [validTarget] }).ok).toBe(false);
    expect(parseManifest({ title: '   ', targets: [validTarget] }).ok).toBe(false);
  });
  it('rejects a missing or empty targets array', () => {
    expect(parseManifest({ title: 'X' }).ok).toBe(false);
    expect(parseManifest({ title: 'X', targets: [] }).ok).toBe(false);
    expect(parseManifest({ title: 'X', targets: 'not-an-array' }).ok).toBe(false);
  });
  it(`rejects more than ${MAX_TARGETS} targets (the file-count cap)`, () => {
    const targets = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => ({ workspacePath: `f${i}.md`, repoPath: `docs/f${i}.md` }));
    const r = parseManifest({ title: 'Too many', targets });
    expect(r.ok).toBe(false);
  });
  it(`accepts exactly ${MAX_TARGETS} targets (boundary)`, () => {
    const targets = Array.from({ length: MAX_TARGETS }, (_, i) => ({ workspacePath: `f${i}.md`, repoPath: `docs/f${i}.md` }));
    const r = parseManifest({ title: 'Exactly the cap', targets });
    expect(r.ok).toBe(true);
  });
  it('rejects a target missing workspacePath or repoPath', () => {
    expect(parseManifest({ title: 'X', targets: [{ repoPath: 'docs/a.md' }] }).ok).toBe(false);
    expect(parseManifest({ title: 'X', targets: [{ workspacePath: 'a.md' }] }).ok).toBe(false);
    expect(parseManifest({ title: 'X', targets: ['not-an-object'] }).ok).toBe(false);
  });
});

describe('isValidTaskSlug', () => {
  it('accepts simple slugs', () => {
    expect(isValidTaskSlug('add-dark-mode')).toBe(true);
    expect(isValidTaskSlug('feature_123')).toBe(true);
    expect(isValidTaskSlug('a')).toBe(true);
  });
  it('rejects empty, whitespace, and non-strings', () => {
    expect(isValidTaskSlug('')).toBe(false);
    expect(isValidTaskSlug('   ')).toBe(false);
    expect(isValidTaskSlug(undefined)).toBe(false);
    expect(isValidTaskSlug(123)).toBe(false);
  });
  it('rejects a leading hyphen (could be misread as a flag)', () => {
    expect(isValidTaskSlug('-x')).toBe(false);
  });
  it('rejects path separators, dots, and spaces', () => {
    expect(isValidTaskSlug('a/b')).toBe(false);
    expect(isValidTaskSlug('a.b')).toBe(false);
    expect(isValidTaskSlug('a b')).toBe(false);
    expect(isValidTaskSlug('../etc')).toBe(false);
  });
  it('rejects over 80 chars', () => {
    expect(isValidTaskSlug('a'.repeat(81))).toBe(false);
    expect(isValidTaskSlug('a'.repeat(80))).toBe(true);
  });
});

describe('isValidSeatId', () => {
  it('accepts real seatId shapes seen in data/workspaces (including the # instance suffix)', () => {
    expect(isValidSeatId('hermes')).toBe(true);
    expect(isValidSeatId('claude-code')).toBe(true);
    expect(isValidSeatId('grok-build#fast')).toBe(true);
    expect(isValidSeatId('hermes#judge')).toBe(true);
  });
  it('rejects traversal attempts (seatId is interpolated directly into a filesystem path)', () => {
    expect(isValidSeatId('../../etc')).toBe(false);
    expect(isValidSeatId('..')).toBe(false);
    expect(isValidSeatId('a/b')).toBe(false);
    expect(isValidSeatId('a\\b')).toBe(false);
    expect(isValidSeatId('.')).toBe(false);
  });
  it('rejects empty/non-string/overlong', () => {
    expect(isValidSeatId('')).toBe(false);
    expect(isValidSeatId(undefined)).toBe(false);
    expect(isValidSeatId('a'.repeat(81))).toBe(false);
  });
});

describe('isUtf8Text', () => {
  it('accepts plain ASCII and multi-byte unicode text', () => {
    expect(isUtf8Text(Buffer.from('hello world', 'utf8'))).toBe(true);
    expect(isUtf8Text(Buffer.from('héllo — wörld 🎉', 'utf8'))).toBe(true);
  });
  it('accepts an empty file', () => {
    expect(isUtf8Text(Buffer.alloc(0))).toBe(true);
  });
  it('rejects a buffer containing a NUL byte (git\'s own binary heuristic)', () => {
    expect(isUtf8Text(Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]))).toBe(false);
  });
  it('rejects an invalid UTF-8 byte sequence (a lone continuation byte)', () => {
    expect(isUtf8Text(Buffer.from([0xff, 0xfe, 0x00, 0x01]))).toBe(false);
  });
  it('rejects a truncated multi-byte sequence', () => {
    // 0xE2 0x82 is the start of a 3-byte sequence (€ is E2 82 AC) with the final byte missing.
    expect(isUtf8Text(Buffer.from([0x61, 0xe2, 0x82]))).toBe(false);
  });
});

describe('buildUnifiedDiff', () => {
  it('a brand-new file (oldText undefined) shows every line as an addition against /dev/null', () => {
    const { diff, truncated } = buildUnifiedDiff('docs/new.md', undefined, 'line one\nline two\n');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/docs/new.md');
    expect(diff).toContain('+line one');
    expect(diff).toContain('+line two');
    expect(diff).not.toContain('-line');
    expect(truncated).toBe(false);
  });

  it('identical content produces an honest "no textual changes" body', () => {
    const { diff, truncated } = buildUnifiedDiff('docs/same.md', 'a\nb\nc\n', 'a\nb\nc\n');
    expect(diff).toContain('no textual changes');
    expect(truncated).toBe(false);
  });

  it('a modified line shows both the removal and the addition with correct hunk line numbers', () => {
    const oldText = 'one\ntwo\nthree\nfour\nfive\n';
    const newText = 'one\ntwo\nTHREE\nfour\nfive\n';
    const { diff } = buildUnifiedDiff('docs/mod.md', oldText, newText);
    expect(diff).toContain('-three');
    expect(diff).toContain('+THREE');
    expect(diff).toMatch(/@@ -1,5 \+1,5 @@/);
  });

  it('a pure addition at the end reports the new lines as additions with correct counts', () => {
    const oldText = 'a\nb\n';
    const newText = 'a\nb\nc\nd\n';
    const { diff } = buildUnifiedDiff('docs/append.md', oldText, newText);
    expect(diff).toContain('+c');
    expect(diff).toContain('+d');
  });

  it('truncates to maxLines with an honest "+N more" note, and sets truncated=true', () => {
    const newText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const { diff, truncated } = buildUnifiedDiff('docs/big.md', undefined, newText, 10);
    const lines = diff.split('\n');
    // The note is appended AFTER the maxLines slice (the human gets the full
    // 10 lines of real content, never one fewer to make room for the note).
    expect(lines.length).toBe(11);
    expect(truncated).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/\+\d+ more lines?\)/);
  });

  it('does not truncate when the diff fits within maxLines', () => {
    const { truncated } = buildUnifiedDiff('docs/small.md', undefined, 'a\nb\n', 400);
    expect(truncated).toBe(false);
  });

  it('handles large inputs (beyond the LCS fast-path threshold) without hanging, via the bounded prefix/suffix fallback', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const oldText = big.join('\n') + '\n';
    const changed = [...big];
    changed[1000] = 'CHANGED';
    const newText = changed.join('\n') + '\n';
    const start = Date.now();
    const { diff } = buildUnifiedDiff('docs/huge.md', oldText, newText, 100_000);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(diff).toContain('-line 1000');
    expect(diff).toContain('+CHANGED');
  });

  it('a trailing-newline-only difference shows no diff (documented fidelity trade-off — never used to construct a patch)', () => {
    const { diff } = buildUnifiedDiff('docs/eof.md', 'a\nb', 'a\nb\n');
    expect(diff).toContain('no textual changes');
  });
});

describe('findWorkshopRoom', () => {
  function room(over: Partial<Room>): Room {
    return {
      id: over.id ?? 'r1',
      name: over.name ?? 'Some Room',
      type: 'group',
      memberIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCap: 12,
      ...over,
    };
  }

  it('finds the Workshop room by exact name among other rooms', () => {
    const rooms = new Map<string, Room>([
      ['a', room({ id: 'a', name: 'General' })],
      ['b', room({ id: 'b', name: WORKSHOP_ROOM_NAME })],
    ]);
    expect(findWorkshopRoom(rooms)?.id).toBe('b');
  });

  it('returns undefined when absent', () => {
    const rooms = new Map<string, Room>([['a', room({ id: 'a', name: 'General' })]]);
    expect(findWorkshopRoom(rooms)).toBeUndefined();
  });

  it('ignores an archived Workshop room (same convention as findApprovalsRoom)', () => {
    const rooms = new Map<string, Room>([['b', room({ id: 'b', name: WORKSHOP_ROOM_NAME, archivedAt: Date.now() })]]);
    expect(findWorkshopRoom(rooms)).toBeUndefined();
  });
});
