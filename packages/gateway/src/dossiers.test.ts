import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DOSSIERS_DIR_ENV,
  dossierFilename,
  dossiersDir,
  isKnownSeatId,
  resolveDossierPath,
  splitSeatId,
} from './dossiers.js';

const ROSTER = ['hermes', 'claude-code', 'grok-build', 'openclaw', 'ollama'];

describe('dossiersDir', () => {
  const original = process.env[DOSSIERS_DIR_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[DOSSIERS_DIR_ENV];
    else process.env[DOSSIERS_DIR_ENV] = original;
  });

  it('is undefined when the env var is unset — feature hidden by default', () => {
    delete process.env[DOSSIERS_DIR_ENV];
    expect(dossiersDir()).toBeUndefined();
  });

  it('is undefined for a whitespace-only value', () => {
    process.env[DOSSIERS_DIR_ENV] = '   ';
    expect(dossiersDir()).toBeUndefined();
  });

  it('returns the trimmed value when set', () => {
    process.env[DOSSIERS_DIR_ENV] = '  C:\\dossiers  ';
    expect(dossiersDir()).toBe('C:\\dossiers');
  });
});

describe('splitSeatId', () => {
  it('parses a bare manifestId (no instance)', () => {
    expect(splitSeatId('grok-build')).toEqual({ manifestId: 'grok-build' });
  });

  it('parses manifestId#instanceId', () => {
    expect(splitSeatId('grok-build#judge')).toEqual({ manifestId: 'grok-build', instanceId: 'judge' });
  });

  it('rejects empty string', () => {
    expect(splitSeatId('')).toBeNull();
  });

  it('rejects more than one #', () => {
    expect(splitSeatId('grok-build#judge#extra')).toBeNull();
  });

  it('rejects an empty manifestId or instanceId segment', () => {
    expect(splitSeatId('#judge')).toBeNull();
    expect(splitSeatId('grok-build#')).toBeNull();
  });
});

describe('isKnownSeatId', () => {
  it('accepts a known bare manifestId', () => {
    expect(isKnownSeatId('grok-build', ROSTER)).toBe(true);
  });

  it('accepts a known manifestId with a well-formed instance slug', () => {
    expect(isKnownSeatId('grok-build#judge', ROSTER)).toBe(true);
    expect(isKnownSeatId('claude-code#work', ROSTER)).toBe(true);
  });

  it('rejects an unknown manifestId', () => {
    expect(isKnownSeatId('not-a-real-harness', ROSTER)).toBe(false);
  });

  it('rejects a known manifestId with a malformed instance slug', () => {
    expect(isKnownSeatId('grok-build#UPPER', ROSTER)).toBe(false); // instance slugs are lowercase-only
    expect(isKnownSeatId('grok-build#has space', ROSTER)).toBe(false);
    expect(isKnownSeatId(`grok-build#${'a'.repeat(17)}`, ROSTER)).toBe(false); // over the 16-char cap
  });

  it('rejects a path-traversal-shaped seatId — the manifestId half is simply not in the roster', () => {
    expect(isKnownSeatId('../../etc/passwd', ROSTER)).toBe(false);
    expect(isKnownSeatId('..%2f..%2fetc', ROSTER)).toBe(false);
  });
});

describe('dossierFilename', () => {
  it('derives <manifestId>.md, dropping any instance suffix (F11: one file per manifest)', () => {
    expect(dossierFilename('grok-build')).toBe('grok-build.md');
    expect(dossierFilename('grok-build#judge')).toBe('grok-build.md');
    expect(dossierFilename('claude-code#work')).toBe('claude-code.md');
  });

  it('throws on a malformed seatId (programmer error — callers must validate first)', () => {
    expect(() => dossierFilename('')).toThrow();
    expect(() => dossierFilename('a#b#c')).toThrow();
  });
});

describe('resolveDossierPath', () => {
  let fixtureRoot: string;
  let dossiersDirPath: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'dossiers-test-'));
    dossiersDirPath = join(fixtureRoot, 'dossiers');
    mkdirSync(dossiersDirPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('reports not-configured when dossiersDirRaw is undefined', () => {
    const result = resolveDossierPath(undefined, 'grok-build', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('reports unknown-seat for a seatId outside the roster — BEFORE any path is built (F10)', () => {
    const result = resolveDossierPath(dossiersDirPath, 'not-a-real-harness', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'unknown-seat' });
  });

  it('reports unknown-seat for a traversal-shaped seatId — the same 404 shape as any other unknown seat', () => {
    const result = resolveDossierPath(dossiersDirPath, '../../etc/passwd', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'unknown-seat' });
  });

  it('reports not-found when the dossiers dir itself does not exist on disk', () => {
    const result = resolveDossierPath(join(fixtureRoot, 'nope'), 'grok-build', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports not-found for a roster-valid seat with no dossier file written yet (honest empty state, not a rejection)', () => {
    const result = resolveDossierPath(dossiersDirPath, 'ollama', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports not-a-file when the manifest-named entry is a directory', () => {
    mkdirSync(join(dossiersDirPath, 'ollama.md'));
    const result = resolveDossierPath(dossiersDirPath, 'ollama', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'not-a-file' });
  });

  it('resolves a real dossier file for a bare manifestId', () => {
    writeFileSync(join(dossiersDirPath, 'grok-build.md'), '# Grok Build\n\nTips go here.\n', 'utf8');
    const result = resolveDossierPath(dossiersDirPath, 'grok-build', ROSTER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith('grok-build.md')).toBe(true);
    }
  });

  it('resolves the SAME file for an instance-suffixed seatId of the same manifest (F11)', () => {
    writeFileSync(join(dossiersDirPath, 'grok-build.md'), '# Grok Build\n', 'utf8');
    const bare = resolveDossierPath(dossiersDirPath, 'grok-build', ROSTER);
    const instanced = resolveDossierPath(dossiersDirPath, 'grok-build#judge', ROSTER);
    expect(bare.ok && instanced.ok && bare.path === instanced.path).toBe(true);
  });

  it('rejects a symlinked dossier file rather than following it (F10)', () => {
    // The threat: an agent (or anything with write access to the dossiers
    // dir) plants a symlink named <manifestId>.md pointing somewhere the
    // gateway should never read from and never disclose the contents of.
    const secretPath = join(fixtureRoot, 'not-a-dossier-secret.txt');
    writeFileSync(secretPath, 'super secret, never serve this', 'utf8');
    symlinkSync(secretPath, join(dossiersDirPath, 'grok-build.md'), 'file');

    const result = resolveDossierPath(dossiersDirPath, 'grok-build', ROSTER);
    expect(result).toEqual({ ok: false, reason: 'symlink' });
  });

  it('containment (defense-in-depth): a manifest id list containing a path-escaping entry is still caught by the realpath check', () => {
    // agents.ts's real registry keys can never contain a path separator (see
    // dossiers.ts's doc comment on isKnownSeatId), so this scenario is
    // unreachable via the real route today — this test exercises
    // resolveDossierPath's LAST-LINE containment check directly, in case
    // that invariant is ever violated upstream. `knownManifestIds` here
    // stands in for "an attacker-controlled manifest id list"; a real file
    // two directories above the (nested) dossiers dir is the escape target.
    const nestedDossiersDir = join(fixtureRoot, 'a', 'b');
    mkdirSync(nestedDossiersDir, { recursive: true });
    const outsideFile = join(fixtureRoot, 'evil.md');
    writeFileSync(outsideFile, 'should never be served', 'utf8');

    const escapee = '../../evil';
    const result = resolveDossierPath(nestedDossiersDir, escapee, [escapee]);
    // The one UNACCEPTABLE outcome is ok:true — assert the specific reason
    // too, so this test fails loudly (not just "some rejection, whatever")
    // if the containment check itself ever regresses.
    expect(result).toEqual({ ok: false, reason: 'escapes-root' });
  });
});
