import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  copyAttachmentForAgent,
  cleanupAgentAttachmentCopies,
  filesDir,
  getAttachment,
  reindexAttachmentsFromDisk,
  storeAttachment,
} from './files.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'attach-test-'));
}

describe('copyAttachmentForAgent', () => {
  it('copies the stored file into the agent workspace and returns the absolute copy path', () => {
    const dataDir = freshDataDir();
    const stored = storeAttachment(dataDir, 'notes.md', 'text/plain', Buffer.from('hello'));

    const copyPath = copyAttachmentForAgent(dataDir, stored, 'claude-code');

    expect(copyPath).toBeDefined();
    expect(copyPath).toBe(join(dataDir, 'workspaces', 'claude-code', 'attachments', stored.diskName));
    expect(existsSync(copyPath!)).toBe(true);
  });

  it('returns undefined without throwing when the source file is missing', () => {
    const dataDir = freshDataDir();
    const stored = storeAttachment(dataDir, 'ghost.md', 'text/plain', Buffer.from('x'));
    // Simulate a source that vanished from disk but is still in the in-memory index.
    const fakeStored = { ...stored, diskName: 'nonexistent-diskname' };

    let result: string | undefined;
    expect(() => {
      result = copyAttachmentForAgent(dataDir, fakeStored, 'claude-code');
    }).not.toThrow();
    expect(result).toBeUndefined();
  });
});

describe('cleanupAgentAttachmentCopies', () => {
  it('deletes matching id-* copies from every workspace attachments dir', () => {
    const dataDir = freshDataDir();
    const a = storeAttachment(dataDir, 'a.txt', 'text/plain', Buffer.from('a'));
    const b = storeAttachment(dataDir, 'b.txt', 'text/plain', Buffer.from('b'));

    const copyA1 = copyAttachmentForAgent(dataDir, a, 'claude-code')!;
    const copyA2 = copyAttachmentForAgent(dataDir, a, 'grok-build')!;
    const copyB = copyAttachmentForAgent(dataDir, b, 'claude-code')!;

    cleanupAgentAttachmentCopies(dataDir, [a.id]);

    expect(existsSync(copyA1)).toBe(false);
    expect(existsSync(copyA2)).toBe(false);
    expect(existsSync(copyB)).toBe(true); // b's copy untouched
  });

  it('is a no-op (no throw) when workspaces dir or attachment dirs are missing', () => {
    const dataDir = freshDataDir(); // no workspaces/ dir created at all
    expect(() => cleanupAgentAttachmentCopies(dataDir, ['some-id'])).not.toThrow();

    // Also fine with an empty id list.
    expect(() => cleanupAgentAttachmentCopies(dataDir, [])).not.toThrow();
  });

  it('does not touch unrelated files in the attachments dir', () => {
    const dataDir = freshDataDir();
    const a = storeAttachment(dataDir, 'a.txt', 'text/plain', Buffer.from('a'));
    const copyA = copyAttachmentForAgent(dataDir, a, 'claude-code')!;
    const attachDir = join(dataDir, 'workspaces', 'claude-code', 'attachments');
    const unrelated = join(attachDir, 'unrelated-file.txt');
    writeFileSync(unrelated, 'keep me');

    cleanupAgentAttachmentCopies(dataDir, [a.id]);

    expect(existsSync(copyA)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(readdirSync(attachDir)).toEqual(['unrelated-file.txt']);
  });
});

// ============================================================================
// reindexAttachmentsFromDisk — docs/TECH-DEBT.md P2 "Orphaned uploads survive
// on disk but vanish from the index on restart". attachmentIndex is a
// module-level singleton (shared across this whole test process, same as a
// real gateway boot), so each test below uses a fresh randomUUID() id and
// writes straight to disk WITHOUT calling storeAttachment() — that mirrors
// exactly what a restart leaves behind: bytes on disk, nothing in memory.
// ============================================================================

describe('reindexAttachmentsFromDisk', () => {
  it('makes an orphaned on-disk file (uploaded, never sent in a message) reachable again after a restart', () => {
    const dataDir = freshDataDir();
    const id = randomUUID();
    const diskName = `${id}-photo.png`;
    const dir = filesDir(dataDir);
    const bytes = Buffer.from('fake-png-bytes');
    writeFileSync(join(dir, diskName), bytes);

    // Pre-fix state: nothing uploaded through storeAttachment() in this
    // process, so the in-memory index has never heard of this id — exactly
    // the bug (attachmentIndex only rehydrates from message history).
    expect(getAttachment(id)).toBeUndefined();

    const added = reindexAttachmentsFromDisk(dataDir);

    expect(added).toBeGreaterThanOrEqual(1);
    const rehydrated = getAttachment(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.diskName).toBe(diskName);
    expect(rehydrated?.filename).toBe('photo.png');
    expect(rehydrated?.size).toBe(bytes.length);
    expect(rehydrated?.path).toBe(join(dir, diskName));
    // Unknown from disk alone — conservative default, never inline-rendered
    // (isInlineSafeContentType requires an exact allowlist match).
    expect(rehydrated?.mimeType).toBe('application/octet-stream');
  });

  it('does not re-derive an id already in the index (a second sweep is a no-op for it)', () => {
    const dataDir = freshDataDir();
    const id = randomUUID();
    const diskName = `${id}-report.pdf`;
    const dir = filesDir(dataDir);
    writeFileSync(join(dir, diskName), Buffer.from('pdf-bytes'));

    reindexAttachmentsFromDisk(dataDir); // first pass indexes it as octet-stream
    expect(getAttachment(id)?.mimeType).toBe('application/octet-stream');

    const addedSecondPass = reindexAttachmentsFromDisk(dataDir);
    expect(addedSecondPass).toBe(0);
    expect(getAttachment(id)?.mimeType).toBe('application/octet-stream');
  });

  it('ignores files that do not match the <uuid>-<name> diskName convention', () => {
    const dataDir = freshDataDir();
    const dir = filesDir(dataDir);
    writeFileSync(join(dir, 'not-a-valid-diskname.txt'), Buffer.from('x'));
    writeFileSync(join(dir, '.gitkeep'), Buffer.from(''));

    expect(reindexAttachmentsFromDisk(dataDir)).toBe(0);
  });

  it('returns 0 (not throw) when the files dir is empty', () => {
    const dataDir = freshDataDir();
    expect(reindexAttachmentsFromDisk(dataDir)).toBe(0);
  });
});
