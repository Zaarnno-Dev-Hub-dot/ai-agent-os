import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import {
  MemoryIndex,
  buildPinnedContextBlock,
  extractWikilinkTargets,
  loadPins,
  pinNote,
  redactSections,
  resolveVaultPath,
  roomsPinning,
  savePins,
  unpinNote,
  withPinnedContext,
  MAX_PINNED_NOTES,
  MAX_PINNED_NOTE_CHARS,
} from './memory.js';

/**
 * Fixture vault built fresh per test run under the OS temp dir — real vault
 * content must never be a test dependency (it changes daily). Mirrors just
 * enough of the real shape to exercise every
 * rule: indexed dirs, excluded dirs, PII files, frontmatter + fallback,
 * and a Secrets section to redact.
 */
let vaultRoot: string;

function write(relPath: string, content: string) {
  const abs = join(vaultRoot, ...relPath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'memory-vault-test-'));

  // Indexed: Memory/Incidents (with frontmatter).
  write(
    'Memory/Incidents/2026-01-01_Sample-Incident.md',
    [
      '---',
      'scope: public',
      'author: Fable',
      'added: 2026-01-01',
      'summary: |',
      '  A sample incident used for testing search ranking and rendering.',
      '---',
      '',
      '# INC-2026-01-01 — Sample Incident',
      '',
      'Body text mentioning incident twice: incident report filed.',
    ].join('\n')
  );

  // Indexed: Memory/Projects (NO frontmatter — exercises the fallback path).
  write(
    'Memory/Projects/No-Frontmatter-Project.md',
    ['# No Frontmatter Project', '', 'This project note has no frontmatter block at all.'].join('\n')
  );

  // Indexed: Memory/Daily.
  write('Memory/Daily/2026-01-02.md', ['# Daily 2026-01-02', '', 'Nothing much happened.'].join('\n'));

  // Indexed: Memory/Public.
  write('Memory/Public/Public.md', ['# Public', '', 'Public memory entry point.'].join('\n'));

  // Indexed: Memory/Agents.
  write('Memory/Agents/Librarian.md', ['# Librarian', '', 'Agent note.'].join('\n'));

  // Indexed: Playbooks/ (top-level, not under Memory/).
  write('Playbooks/Builder-Conduct.md', ['# Builder Conduct', '', 'Standing playbook body.'].join('\n'));

  // Indexed: root files.
  write('README.md', ['# Vault README', '', 'Top-level readme body.'].join('\n'));
  write('memory.md', ['# Memory Usage', '', 'Usage instructions body.'].join('\n'));
  write('INDEX.md', ['# Index', '', 'Index body.'].join('\n'));

  // A note with a Secrets section to redact, plus surrounding content that
  // must survive. Title deliberately avoids the word "Secrets" itself, so
  // "the redacted keyword never appears in the output" is a meaningful
  // substring assertion rather than one that would also trip on the note's
  // own (legitimate, non-redacted) title.
  write(
    'Memory/Projects/Has-Secrets.md',
    [
      '# Vault Config Notes',
      '',
      'This is visible intro content.',
      '',
      '## Secrets',
      '',
      'api_key=super-secret-value',
      'Should never be rendered or pinned.',
      '',
      '## Next Steps',
      '',
      'This trailing section must survive redaction.',
    ].join('\n')
  );

  // A note with an API Access section (different heading spelling, still redacted) nested under a level-1 heading.
  write(
    'Memory/Projects/Has-Api-Access.md',
    [
      '# Deploy Notes',
      '',
      'Intro paragraph.',
      '',
      '### API Access',
      '',
      'token=abc123',
      '',
      '### Credentials',
      '',
      'password=hunter2',
      '',
      '## Unrelated Section',
      '',
      'Survives redaction.',
    ].join('\n')
  );

  // EXCLUDED: Memory/Review — must never appear in search results.
  write('Memory/Review/Pending-Fact.md', ['# Pending Fact', '', 'incident mention that must not surface.'].join('\n'));

  // EXCLUDED: Memory/Inbox — uncurated.
  write('Memory/Inbox/Raw-Note.md', ['# Raw Note', '', 'incident mention that must not surface.'].join('\n'));

  // EXCLUDED: .obsidian app metadata.
  write('.obsidian/workspace.md', ['# Workspace', '', 'App metadata, not memory.'].join('\n'));

  // EXCLUDED (not in the allowlist at all): Memory/skills, Hermes/, User/.
  write('Memory/skills/Some-Skill.md', ['# Some Skill', '', 'Not in the allowlisted dirs.'].join('\n'));
  write('Hermes/Technical-Memory.md', ['# Technical Memory', '', 'Not in the allowlisted dirs.'].join('\n'));

  // PII: User/Profile.md and Memory/user-profile.md — excluded from pin/render/search entirely.
  write('User/Profile.md', ['# User Profile', '', 'PII content.'].join('\n'));
  write('Memory/user-profile.md', ['# User Profile (Consolidated)', '', 'PII content.'].join('\n'));

  // Non-.md file in an indexed dir — must be ignored, not crash the walk.
  write('Memory/Incidents/notes.txt', 'plain text, not markdown');
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('MemoryIndex — indexing + exclusions', () => {
  it('indexes only the allowlisted dirs/files, skipping excluded, PII, non-md, and non-allowlisted paths', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    const all = index.search('').map((n) => n.path);

    // Everything expected to be indexed IS indexed.
    expect(all).toContain('Memory/Incidents/2026-01-01_Sample-Incident.md');
    expect(all).toContain('Memory/Projects/No-Frontmatter-Project.md');
    expect(all).toContain('Memory/Daily/2026-01-02.md');
    expect(all).toContain('Memory/Public/Public.md');
    expect(all).toContain('Memory/Agents/Librarian.md');
    expect(all).toContain('Playbooks/Builder-Conduct.md');
    expect(all).toContain('README.md');
    expect(all).toContain('memory.md');
    expect(all).toContain('INDEX.md');

    // Excluded governance dirs never appear.
    expect(all).not.toContain('Memory/Review/Pending-Fact.md');
    expect(all).not.toContain('Memory/Inbox/Raw-Note.md');
    expect(all.some((p) => p.startsWith('.obsidian/'))).toBe(false);

    // Not-allowlisted dirs never appear, even though they hold .md files.
    expect(all.some((p) => p.startsWith('Memory/skills/'))).toBe(false);
    expect(all.some((p) => p.startsWith('Hermes/'))).toBe(false);

    // PII files never appear.
    expect(all).not.toContain('User/Profile.md');
    expect(all).not.toContain('Memory/user-profile.md');

    // Non-markdown file in an indexed dir is ignored, and did not crash the walk.
    expect(all).not.toContain('Memory/Incidents/notes.txt');
  });

  it('never returns Memory/Review or Memory/Inbox notes from search, even when the query matches their content', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    const results = index.search('incident').map((n) => n.path);
    expect(results).not.toContain('Memory/Review/Pending-Fact.md');
    expect(results).not.toContain('Memory/Inbox/Raw-Note.md');
    // Sanity: the search mechanism itself does work (the allowed incident note matches).
    expect(results).toContain('Memory/Incidents/2026-01-01_Sample-Incident.md');
  });

  it('get() never resolves PII or excluded paths, even by exact path', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    expect(index.get('User/Profile.md')).toBeUndefined();
    expect(index.get('Memory/user-profile.md')).toBeUndefined();
    expect(index.get('Memory/Review/Pending-Fact.md')).toBeUndefined();
    expect(index.get('Memory/Inbox/Raw-Note.md')).toBeUndefined();
  });

  it('parses frontmatter when present and falls back to filename + first paragraph without erroring when absent', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    const withFm = index.get('Memory/Incidents/2026-01-01_Sample-Incident.md');
    expect(withFm).toBeDefined();
    expect(withFm!.summary).toContain('sample incident used for testing');

    const withoutFm = index.get('Memory/Projects/No-Frontmatter-Project.md');
    expect(withoutFm).toBeDefined();
    expect(withoutFm!.title).toBe('No Frontmatter Project');
    expect(withoutFm!.summary).toContain('This project note has no frontmatter block at all.');
  });

  it('re-indexing picks up a newly added file without restarting the process', () => {
    // Distinctive nonsense token — a real English phrase would risk matching
    // some OTHER word in the shared fixture set via the OR-of-tokens search
    // (e.g. "note"), which would make this assertion about the fixture's
    // contents rather than about reindex() picking up new files.
    const token = 'zzyxquorplenoodle';
    const index = new MemoryIndex(vaultRoot);
    index.reindex();
    expect(index.search(token)).toHaveLength(0);

    write('Memory/Public/Late-Addition.md', ['# Late Addition', '', `mentions ${token} in its body.`].join('\n'));
    index.reindex();

    const results = index.search(token);
    expect(results.map((n) => n.path)).toContain('Memory/Public/Late-Addition.md');
  });
});

describe('redactSections', () => {
  it('removes a "## Secrets" section (heading + body) while preserving surrounding content', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();
    const note = index.get('Memory/Projects/Has-Secrets.md');
    expect(note).toBeDefined();

    expect(note!.markdown).toContain('This is visible intro content.');
    expect(note!.markdown).toContain('This trailing section must survive redaction.');
    expect(note!.markdown).not.toContain('Secrets');
    expect(note!.markdown).not.toContain('super-secret-value');
    expect(note!.markdown).not.toContain('Should never be rendered or pinned.');
  });

  it('redacts "API Access" and "Credentials" headings (case/spelling variants), stopping at the next same-or-shallower heading', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();
    const note = index.get('Memory/Projects/Has-Api-Access.md');
    expect(note).toBeDefined();

    expect(note!.markdown).toContain('Intro paragraph.');
    expect(note!.markdown).not.toContain('API Access');
    expect(note!.markdown).not.toContain('token=abc123');
    expect(note!.markdown).not.toContain('Credentials');
    expect(note!.markdown).not.toContain('password=hunter2');
    // The level-2 "Unrelated Section" is shallower than the level-3 redacted
    // headings, so it must end the redaction and survive.
    expect(note!.markdown).toContain('Unrelated Section');
    expect(note!.markdown).toContain('Survives redaction.');
  });

  it('is heading-match based, not a blanket keyword filter — prose mentioning "secret" outside a Secrets heading is untouched', () => {
    const body = ['# Notes', '', 'We keep this token secret from outsiders.', '', '## Discussion', 'More text.'].join(
      '\n'
    );
    const redacted = redactSections(body);
    expect(redacted).toContain('We keep this token secret from outsiders.');
  });

  it('is a no-op on content with no redacted headings', () => {
    const body = ['# Plain Note', '', 'Nothing sensitive here.'].join('\n');
    expect(redactSections(body)).toBe(body);
  });
});

describe('resolveVaultPath — path traversal rejection', () => {
  it('resolves a plain in-vault relative path', () => {
    const resolved = resolveVaultPath(vaultRoot, 'Memory/Incidents/2026-01-01_Sample-Incident.md');
    expect(resolved).not.toBeNull();
    expect(resolved).toContain('Memory');
  });

  it('rejects ../ traversal attempting to escape the vault root', () => {
    expect(resolveVaultPath(vaultRoot, '../../.env')).toBeNull();
    expect(resolveVaultPath(vaultRoot, '..\\..\\.env')).toBeNull();
    expect(resolveVaultPath(vaultRoot, '../outside.md')).toBeNull();
  });

  it('rejects an absolute path pointing outside the vault', () => {
    expect(resolveVaultPath(vaultRoot, 'C:\\Windows\\System32\\drivers\\etc\\hosts')).toBeNull();
    expect(resolveVaultPath(vaultRoot, '/etc/passwd')).toBeNull();
  });

  it('rejects a path containing a null byte', () => {
    expect(resolveVaultPath(vaultRoot, 'Memory/Incidents/foo.md\0.txt')).toBeNull();
  });

  it('rejects empty/non-string input', () => {
    expect(resolveVaultPath(vaultRoot, '')).toBeNull();
  });

  it('accepts a deeply nested but still in-vault path', () => {
    const nested = `Memory${sep}Incidents${sep}2026-01-01_Sample-Incident.md`;
    expect(resolveVaultPath(vaultRoot, nested)).not.toBeNull();
  });
});

describe('MemoryIndex.search — ranking', () => {
  it('ranks a title hit above a body-only hit for the same query term', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();

    // "Librarian" appears in the title of Memory/Agents/Librarian.md, and
    // "incident" appears only in the body of the Incidents sample note (not
    // its title). Search a term that hits the Incidents note's BODY and
    // compare against a distinct query hitting a TITLE, using the shared
    // ranking contract instead: build a synthetic pair via two notes that
    // share a token, one in title, one only in body.
    const results = index.search('incident');
    const incidentNote = results.find((r) => r.path === 'Memory/Incidents/2026-01-01_Sample-Incident.md');
    expect(incidentNote).toBeDefined();
    // "incident" is in the title (filename "Sample-Incident" -> "Sample Incident")
    // AND the body twice — it should be the top (or only) result among allowed notes.
    expect(results[0].path).toBe('Memory/Incidents/2026-01-01_Sample-Incident.md');
  });

  it('title hit outranks a note with more raw body occurrences but no title hit', () => {
    // Build an isolated fixture for this test to keep the ranking assertion
    // exact and independent of the shared vault's other fixtures.
    const localRoot = mkdtempSync(join(tmpdir(), 'memory-vault-ranking-'));
    try {
      mkdirSync(join(localRoot, 'Memory', 'Public'), { recursive: true });
      writeFileSync(
        join(localRoot, 'Memory', 'Public', 'Zephyr-Title-Hit.md'),
        ['# Zephyr Title Hit', '', 'One mention of zephyr here.'].join('\n')
      );
      writeFileSync(
        join(localRoot, 'Memory', 'Public', 'Body-Only.md'),
        [
          '# Body Only Note',
          '',
          'zephyr zephyr zephyr zephyr zephyr — many body mentions of the word but never in the title.',
        ].join('\n')
      );

      const index = new MemoryIndex(localRoot);
      index.reindex();
      const results = index.search('zephyr');
      expect(results[0].path).toBe('Memory/Public/Zephyr-Title-Hit.md');
      expect(results[1].path).toBe('Memory/Public/Body-Only.md');
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('breaks ties by recency (mtime descending) when title/body hit counts are equal', async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'memory-vault-recency-'));
    try {
      mkdirSync(join(localRoot, 'Memory', 'Public'), { recursive: true });
      const olderPath = join(localRoot, 'Memory', 'Public', 'Older-Quokka.md');
      const newerPath = join(localRoot, 'Memory', 'Public', 'Newer-Quokka.md');
      writeFileSync(olderPath, ['# Older Quokka', '', 'quokka mention.'].join('\n'));
      // Ensure a real filesystem mtime gap.
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(newerPath, ['# Newer Quokka', '', 'quokka mention.'].join('\n'));

      const index = new MemoryIndex(localRoot);
      index.reindex();
      const results = index.search('quokka');
      expect(results.map((r) => r.path)).toEqual(['Memory/Public/Newer-Quokka.md', 'Memory/Public/Older-Quokka.md']);
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty array for a query matching nothing', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();
    expect(index.search('zzz-no-such-token-zzz')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const index = new MemoryIndex(vaultRoot);
    index.reindex();
    const lower = index.search('incident').map((n) => n.path);
    const upper = index.search('INCIDENT').map((n) => n.path);
    expect(upper).toEqual(lower);
  });
});

describe('pins persistence + roomsPinning', () => {
  it('pinNote adds a path, is idempotent, and unpinNote removes it', () => {
    let pins = {};
    pins = pinNote(pins, 'room-1', 'Memory/Public/Public.md');
    expect(pins).toEqual({ 'room-1': ['Memory/Public/Public.md'] });

    // Idempotent: pinning the same path twice does not duplicate it.
    pins = pinNote(pins, 'room-1', 'Memory/Public/Public.md');
    expect(pins).toEqual({ 'room-1': ['Memory/Public/Public.md'] });

    pins = unpinNote(pins, 'room-1', 'Memory/Public/Public.md');
    expect(pins).toEqual({ 'room-1': [] });
  });

  it('unpinNote on a path that was never pinned is a no-op', () => {
    const pins = { 'room-1': ['Memory/Public/Public.md'] };
    const result = unpinNote(pins, 'room-1', 'Memory/Public/Other.md');
    expect(result).toEqual(pins);
  });

  it('roomsPinning returns every room a path is pinned in', () => {
    const pins = {
      'room-1': ['Memory/Public/Public.md'],
      'room-2': ['Memory/Public/Public.md', 'Memory/Agents/Librarian.md'],
      'room-3': ['Memory/Agents/Librarian.md'],
    };
    expect(roomsPinning(pins, 'Memory/Public/Public.md').sort()).toEqual(['room-1', 'room-2']);
    expect(roomsPinning(pins, 'Memory/Agents/Librarian.md').sort()).toEqual(['room-2', 'room-3']);
    expect(roomsPinning(pins, 'Memory/Nowhere.md')).toEqual([]);
  });

  it('savePins + loadPins round-trip through data/memory-pins.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-pins-data-'));
    try {
      const pins = { 'room-1': ['Memory/Public/Public.md'] };
      savePins(dataDir, pins);
      const loaded = loadPins(dataDir);
      expect(loaded).toEqual(pins);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loadPins tolerates a missing or corrupt file instead of throwing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memory-pins-missing-'));
    try {
      expect(loadPins(dataDir)).toEqual({});

      writeFileSync(join(dataDir, 'memory-pins.json'), 'not json {{{');
      expect(loadPins(dataDir)).toEqual({});
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('buildPinnedContextBlock / withPinnedContext — outbound compose helper', () => {
  it('returns empty string when the room has no pins', () => {
    const block = buildPinnedContextBlock({}, 'room-1', () => undefined);
    expect(block).toBe('');
    expect(withPinnedContext('hello', block)).toBe('hello');
  });

  it('prepends a "[Pinned context: <title>]" block per pinned note, in pin order', () => {
    const pins = { 'room-1': ['a.md', 'b.md'] };
    const notes: Record<string, { title: string; markdown: string }> = {
      'a.md': { title: 'Alpha Note', markdown: 'alpha body' },
      'b.md': { title: 'Beta Note', markdown: 'beta body' },
    };
    const block = buildPinnedContextBlock(pins, 'room-1', (p) => notes[p]);
    expect(block).toBe('[Pinned context: Alpha Note]\nalpha body\n\n[Pinned context: Beta Note]\nbeta body');

    const composed = withPinnedContext('the actual outbound message', block);
    expect(composed.startsWith('[Pinned context: Alpha Note]')).toBe(true);
    expect(composed.endsWith('the actual outbound message')).toBe(true);
  });

  it('caps at MAX_PINNED_NOTES notes even when more are pinned', () => {
    const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const pins = { 'room-1': paths };
    const notes: Record<string, { title: string; markdown: string }> = Object.fromEntries(
      paths.map((p) => [p, { title: p, markdown: `body of ${p}` }])
    );
    const block = buildPinnedContextBlock(pins, 'room-1', (p) => notes[p]);
    const titleCount = (block.match(/\[Pinned context:/g) ?? []).length;
    expect(titleCount).toBe(MAX_PINNED_NOTES);
    expect(block).not.toContain('d.md');
    expect(block).not.toContain('e.md');
  });

  it('truncates each note to MAX_PINNED_NOTE_CHARS characters of its markdown', () => {
    const longBody = 'x'.repeat(MAX_PINNED_NOTE_CHARS + 500);
    const pins = { 'room-1': ['long.md'] };
    const block = buildPinnedContextBlock(pins, 'room-1', () => ({ title: 'Long Note', markdown: longBody }));
    // Header line + truncated body + ellipsis.
    const bodyPart = block.split('\n').slice(1).join('\n');
    expect(bodyPart.length).toBeLessThanOrEqual(MAX_PINNED_NOTE_CHARS + 1); // +1 for the trailing ellipsis char
    expect(bodyPart.endsWith('…')).toBe(true);
  });

  it('skips a pinned path that no longer resolves (e.g. re-indexed away) without throwing', () => {
    const pins = { 'room-1': ['gone.md', 'still-here.md'] };
    const notes: Record<string, { title: string; markdown: string }> = {
      'still-here.md': { title: 'Still Here', markdown: 'present' },
    };
    const block = buildPinnedContextBlock(pins, 'room-1', (p) => notes[p]);
    expect(block).toBe('[Pinned context: Still Here]\npresent');
  });

  it('applies caps on the POST-redaction markdown a caller passes in (redaction is the caller\'s job before calling getNote)', () => {
    // This helper is deliberately redaction-agnostic — it trusts getNote() to
    // already return redacted markdown (the real call site wires index.get(),
    // whose markdown field is always post-redactSections()). Verify the
    // contract by feeding pre-redacted content through and confirming no
    // further transformation happens beyond truncation.
    const pins = { 'room-1': ['note.md'] };
    const markdown = 'visible content only, secrets already removed by the caller';
    const block = buildPinnedContextBlock(pins, 'room-1', () => ({ title: 'Note', markdown }));
    expect(block).toContain(markdown);
  });
});

describe('redactSections — adversarial heading variants (7/7 review findings)', () => {
  it('redacts a heading with trailing punctuation ("## Secrets:")', () => {
    const body = '# Note\n\n## Secrets:\napi_key=leak1\n\n## Safe\nvisible';
    const out = redactSections(body);
    expect(out).not.toContain('leak1');
    expect(out).toContain('visible');
  });

  it('redacts a no-space heading ("##Secrets")', () => {
    const body = '# Note\n\n##Secrets\nleak2 should be hidden\n\n## Safe\nvisible';
    const out = redactSections(body);
    expect(out).not.toContain('leak2');
    expect(out).toContain('visible');
  });

  it('does NOT let a #hashtag line terminate a redacted section early', () => {
    const body = '## Secrets\ntop-secret-a\n#hashtag note inside\ntop-secret-b\n\n## Safe\nvisible';
    const out = redactSections(body);
    expect(out).not.toContain('top-secret-a');
    expect(out).not.toContain('top-secret-b');
    expect(out).toContain('visible');
  });

  it('still redacts punctuated variants of multi-word headings ("### API Access —")', () => {
    const body = '# N\n### API Access —\nleak3\n## Safe\nvisible';
    const out = redactSections(body);
    expect(out).not.toContain('leak3');
    expect(out).toContain('visible');
  });
});

describe('extractWikilinkTargets', () => {
  it('extracts a plain [[Target]]', () => {
    expect(extractWikilinkTargets('See [[Some Note]] for details.')).toEqual(['Some Note']);
  });

  it('extracts the target only, dropping an alias ([[Target|Alias]])', () => {
    expect(extractWikilinkTargets('[[Some Note|click here]]')).toEqual(['Some Note']);
  });

  it('extracts the target only, dropping a heading ref ([[Target#Heading]])', () => {
    expect(extractWikilinkTargets('[[Some Note#Section Two]]')).toEqual(['Some Note']);
  });

  it('extracts the target only when both a heading ref and alias are present', () => {
    expect(extractWikilinkTargets('[[Some Note#Section|see]]')).toEqual(['Some Note']);
  });

  it('extracts an embed target (![[Target]]) the same as a link', () => {
    expect(extractWikilinkTargets('![[Some Note]]')).toEqual(['Some Note']);
  });

  it('extracts multiple links from one body, in order, including duplicates', () => {
    expect(extractWikilinkTargets('[[A]] then [[B]] then [[A]] again')).toEqual(['A', 'B', 'A']);
  });

  it('returns an empty array when the body has no wikilinks', () => {
    expect(extractWikilinkTargets('Plain prose, no links here.')).toEqual([]);
  });

  it('ignores a regular markdown link ([text](url))', () => {
    expect(extractWikilinkTargets('[not a wikilink](https://example.com)')).toEqual([]);
  });
});

describe('MemoryIndex.getGraph — Memory Galaxy (docs/DESIGN-studio-dock.md §4)', () => {
  it('builds nodes for every indexed note with id/title/path/mtime/size, and resolves a same-vault wikilink into an edge', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-basic-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      writeFileSync(
        join(root, 'Memory', 'Public', 'Alpha.md'),
        ['# Alpha', '', 'Links to [[Beta]] right here.'].join('\n')
      );
      writeFileSync(join(root, 'Memory', 'Public', 'Beta.md'), ['# Beta', '', 'No outgoing links.'].join('\n'));

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph();

      expect(graph.totalNotes).toBe(2);
      const alpha = graph.nodes.find((n) => n.path === 'Memory/Public/Alpha.md');
      expect(alpha).toBeDefined();
      expect(alpha).toMatchObject({ id: 'Memory/Public/Alpha.md', title: 'Alpha', path: 'Memory/Public/Alpha.md' });
      expect(typeof alpha!.mtime).toBe('number');
      expect(alpha!.size).toBeGreaterThan(0);

      expect(graph.links).toContainEqual({ source: 'Memory/Public/Alpha.md', target: 'Memory/Public/Beta.md' });
      expect(graph.links).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a wikilink by bare filename stem even when the title differs (hyphens -> spaces)', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-stem-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      writeFileSync(
        join(root, 'Memory', 'Public', 'Source.md'),
        ['# Source', '', 'Points at [[Two-Word-Note]].'].join('\n')
      );
      writeFileSync(join(root, 'Memory', 'Public', 'Two-Word-Note.md'), ['# Two Word Note', ''].join('\n'));

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph();

      expect(graph.links).toContainEqual({
        source: 'Memory/Public/Source.md',
        target: 'Memory/Public/Two-Word-Note.md',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never produces a node OR a link edge for a governance-excluded note (Review/Inbox/PII), even when a visible note links to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-excl-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      mkdirSync(join(root, 'Memory', 'Review'), { recursive: true });
      mkdirSync(join(root, 'Memory', 'Inbox'), { recursive: true });
      mkdirSync(join(root, 'User'), { recursive: true });
      writeFileSync(
        join(root, 'Memory', 'Public', 'Linker.md'),
        ['# Linker', '', 'See [[Pending Fact]], [[Raw Note]], and [[Profile]].'].join('\n')
      );
      writeFileSync(join(root, 'Memory', 'Review', 'Pending-Fact.md'), ['# Pending Fact', ''].join('\n'));
      writeFileSync(join(root, 'Memory', 'Inbox', 'Raw-Note.md'), ['# Raw Note', ''].join('\n'));
      writeFileSync(join(root, 'User', 'Profile.md'), ['# Profile', ''].join('\n'));

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph();

      // Only the linking note itself is indexed — the three targets are all excluded.
      expect(graph.totalNotes).toBe(1);
      expect(graph.nodes.map((n) => n.path)).toEqual(['Memory/Public/Linker.md']);
      expect(graph.links).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops an unresolved wikilink (target never existed) without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-unresolved-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      writeFileSync(
        join(root, 'Memory', 'Public', 'Lonely.md'),
        ['# Lonely', '', 'Points at [[Nothing Here]].'].join('\n')
      );

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph();

      expect(graph.nodes).toHaveLength(1);
      expect(graph.links).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a self-link ([[Self]] inside its own body)', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-self-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      writeFileSync(join(root, 'Memory', 'Public', 'Self.md'), ['# Self', '', 'Refers to [[Self]].'].join('\n'));

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph();

      expect(graph.links).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps nodes at `limit`, keeps the newest by mtime, and drops edges whose target was trimmed by the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-cap-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      // Older -> newer, each linking to the NEXT one so the oldest note's
      // outgoing edge target gets trimmed once the cap excludes it.
      writeFileSync(join(root, 'Memory', 'Public', 'N1.md'), ['# N1', '', 'Links [[N2]].'].join('\n'));
      await new Promise((r) => setTimeout(r, 15));
      writeFileSync(join(root, 'Memory', 'Public', 'N2.md'), ['# N2', '', 'Links [[N3]].'].join('\n'));
      await new Promise((r) => setTimeout(r, 15));
      writeFileSync(join(root, 'Memory', 'Public', 'N3.md'), ['# N3', ''].join('\n'));

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph(2);

      expect(graph.totalNotes).toBe(3);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.map((n) => n.path).sort()).toEqual(
        ['Memory/Public/N2.md', 'Memory/Public/N3.md'].sort()
      );
      // N1 -> N2 edge is gone because N1 itself was trimmed by the cap.
      expect(graph.links).toContainEqual({ source: 'Memory/Public/N2.md', target: 'Memory/Public/N3.md' });
      expect(graph.links).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('de-duplicates a note linking the same target twice in its body into one edge', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-graph-dedupe-'));
    try {
      mkdirSync(join(root, 'Memory', 'Public'), { recursive: true });
      writeFileSync(
        join(root, 'Memory', 'Public', 'Twice.md'),
        ['# Twice', '', 'See [[Once]] and again [[Once|here]].'].join('\n')
      );
      writeFileSync(join(root, 'Memory', 'Public', 'Once.md'), ['# Once', ''].join('\n'));

      const index = new MemoryIndex(root);
      index.reindex();
      const graph = index.getGraph();

      expect(graph.links).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
