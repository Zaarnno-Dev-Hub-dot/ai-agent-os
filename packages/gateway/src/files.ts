/**
 * Attachment storage: files land on disk under <dataDir>/files/<id>-<safe-filename>.
 * AttachmentRef.path is the on-disk path (adapters can hand it to CLI-flavor agents);
 * AttachmentRef.url is the gateway-served URL the UI renders (GET /api/files/:id).
 */

import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import type { AttachmentRef } from '@agent-os/shared';

/**
 * Content types safe to render inline in a browser (no active content, no
 * markup the browser will parse/execute). Exact-string-match only — never
 * substring/prefix match against this list, and never trust anything else
 * the client claims as a mimetype for inline rendering (stored XSS otherwise:
 * e.g. an uploaded mimeType of "text/html" or "image/svg+xml" would
 * otherwise be served inline from the gateway origin).
 */
export const INLINE_SAFE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
] as const;

export type InlineSafeContentType = (typeof INLINE_SAFE_CONTENT_TYPES)[number];

export function isInlineSafeContentType(mimeType: string): mimeType is InlineSafeContentType {
  return (INLINE_SAFE_CONTENT_TYPES as readonly string[]).includes(mimeType);
}

/** Strip characters that could break out of a quoted header value or inject header/CRLF splitting. */
export function sanitizeHeaderFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '').trim() || 'file';
}

export interface StoredAttachment extends AttachmentRef {
  /** Filesystem path segment used to serve the file back out (id-safe filename). */
  diskName: string;
}

const attachmentIndex = new Map<string, StoredAttachment>();

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  return base.length > 0 ? base.slice(-180) : 'file';
}

export function filesDir(dataDir: string): string {
  const dir = join(dataDir, 'files');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function storeAttachment(
  dataDir: string,
  filename: string,
  mimeType: string,
  buffer: Buffer
): StoredAttachment {
  const id = randomUUID();
  const safeName = sanitizeFilename(filename);
  const diskName = `${id}-${safeName}`;
  const dir = filesDir(dataDir);
  const path = join(dir, diskName);
  writeFileSync(path, buffer);

  const attachment: StoredAttachment = {
    id,
    filename: safeName,
    mimeType,
    size: buffer.length,
    path,
    diskName,
  };
  attachmentIndex.set(id, attachment);
  return attachment;
}

export function getAttachment(id: string): StoredAttachment | undefined {
  return attachmentIndex.get(id);
}

export function readAttachmentBuffer(dataDir: string, attachment: StoredAttachment): Buffer {
  return readFileSync(join(filesDir(dataDir), attachment.diskName));
}

/** Rehydrate the in-memory index from persisted messages on boot (attachments referenced in history). */
export function reindexAttachmentsFromMessages(attachments: AttachmentRef[]) {
  for (const a of attachments) {
    if (!attachmentIndex.has(a.id)) {
      const diskName = a.path.split(/[/\\]/).pop() ?? '';
      attachmentIndex.set(a.id, { ...a, diskName });
    }
  }
}

/** `<uuid>-<original-filename>`, the exact diskName shape storeAttachment() writes. */
const DISK_NAME_ID_RE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-(.+)$/;

/**
 * Boot-time sweep of <dataDir>/files for on-disk attachments the in-memory
 * index doesn't know about yet. reindexAttachmentsFromMessages only covers
 * attachments referenced in persisted message history; a file uploaded via
 * POST /api/files but never sent in a chat message (upload-then-cancel) has
 * no message to rehydrate from and stayed unreachable via GET /api/files/:id
 * for the rest of the process's life even though the bytes were still on
 * disk. Call AFTER reindexAttachmentsFromMessages on
 * boot so message-linked attachments keep their real recorded
 * filename/mimeType; this only fills in ids still missing from the index.
 * mimeType is unrecoverable from disk alone, so orphans get a conservative
 * 'application/octet-stream' default — isInlineSafeContentType requires an
 * exact allowlist match, so an orphan can never be inline-rendered, only
 * downloaded as opaque bytes (same fail-safe posture as any other unknown
 * type through this code path). Returns the number of entries added, for
 * boot-log/proof purposes.
 */
export function reindexAttachmentsFromDisk(dataDir: string): number {
  const dir = filesDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`[files] reindexAttachmentsFromDisk: failed to list ${dir}`, e);
    return 0;
  }

  let added = 0;
  for (const diskName of entries) {
    const match = DISK_NAME_ID_RE.exec(diskName);
    if (!match) continue; // not one of ours (unexpected file) — skip rather than guess
    const [, id, filename] = match;
    if (attachmentIndex.has(id)) continue; // message-linked entry already covers it

    let size: number;
    try {
      size = statSync(join(dir, diskName)).size;
    } catch (e) {
      console.error(`[files] reindexAttachmentsFromDisk: stat failed for ${diskName}`, e);
      continue;
    }

    attachmentIndex.set(id, {
      id,
      filename,
      mimeType: 'application/octet-stream',
      size,
      path: join(dir, diskName),
      diskName,
    });
    added += 1;
  }
  return added;
}

/**
 *: CLI-flavor agents get a filesystem hand-off,
 * but never a path into the shared files store or another agent's workspace.
 * Copy the stored file into <dataDir>/workspaces/<agentId>/attachments/ and
 * hand out the ABSOLUTE PATH OF THE COPY. Returns undefined on any failure
 * (missing source file, mkdir/copy error) — fail closed, never hand out a
 * path that doesn't point at the agent's own copy.
 */
export function copyAttachmentForAgent(
  dataDir: string,
  attachment: StoredAttachment,
  agentId: string
): string | undefined {
  const srcPath = join(filesDir(dataDir), attachment.diskName);
  if (!existsSync(srcPath)) {
    console.error(`[files] copyAttachmentForAgent: source missing for ${attachment.id}`);
    return undefined;
  }
  const destDir = join(dataDir, 'workspaces', agentId, 'attachments');
  try {
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    const destPath = join(destDir, attachment.diskName);
    copyFileSync(srcPath, destPath);
    return destPath;
  } catch (e) {
    console.error(`[files] copyAttachmentForAgent: copy failed for ${attachment.id} -> ${agentId}`, e);
    return undefined;
  }
}

/**
 * Room-archive cleanup: delete the per-agent copies made for these attachment
 * ids from every agent's workspace attachments dir. Archive-time only (never
 * earlier — re-reads must work for the room's lifetime). Missing dirs/files
 * are not an error — best-effort cleanup, never throws.
 */
export function cleanupAgentAttachmentCopies(dataDir: string, attachmentIds: string[]) {
  if (attachmentIds.length === 0) return;
  // Match by prefix, not split-on-first-hyphen: ids are UUIDs and contain
  // hyphens themselves (diskName is `${id}-${safeName}`).
  const prefixes = attachmentIds.map((id) => `${id}-`);
  const workspacesDir = join(dataDir, 'workspaces');
  if (!existsSync(workspacesDir)) return;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(workspacesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    console.error('[files] cleanupAgentAttachmentCopies: failed to list workspaces', e);
    return;
  }

  for (const agentId of agentDirs) {
    const attachmentsDir = join(workspacesDir, agentId, 'attachments');
    if (!existsSync(attachmentsDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(attachmentsDir);
    } catch (e) {
      console.error(`[files] cleanupAgentAttachmentCopies: failed to list ${attachmentsDir}`, e);
      continue;
    }
    for (const entry of entries) {
      if (!prefixes.some((p) => entry.startsWith(p))) continue;
      try {
        rmSync(join(attachmentsDir, entry), { force: true });
      } catch (e) {
        console.error(`[files] cleanupAgentAttachmentCopies: failed to remove ${entry}`, e);
      }
    }
  }
}
