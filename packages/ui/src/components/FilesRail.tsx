import { useMemo, useRef, useState } from 'react';
import { AttachmentRef, OutboundMessage } from '@agent-os/shared';
import { useStore } from '../store/gatewayStore';
import { uploadFile } from '../lib/attachments';
import { gatewayHttpOrigin } from '../lib/gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

/** Same inline-image allowlist idiom as Attachment.tsx (kept local — no shared export exists yet). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function iconFor(mimeType: string): string {
  if (IMAGE_TYPES.has(mimeType)) return '🖼';
  if (mimeType.startsWith('text/')) return '📝';
  return '📄';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentUrl(a: AttachmentRef): string {
  return a.url ?? `${GATEWAY_ORIGIN}/api/files/${a.id}`;
}

/** One attachment as it appears in room history, plus who sent it and when. */
interface RailEntry {
  attachment: AttachmentRef;
  senderId: string;
  senderName: string;
  createdAt: number;
}

export function FilesRail() {
  const { filesRailOpen, toggleFilesRail, activeRoomId, rooms, messages, agents, sendClientEvent } =
    useStore();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const room = rooms.find((r) => r.id === activeRoomId);

  // Derived from messages already loaded into the store — if older history
  // pages haven't been paged in yet, their attachments won't show here until
  // they are (see ChatView's loadOlder / scroll-to-load-more).
  const entries: RailEntry[] = useMemo(() => {
    if (!activeRoomId) return [];
    const list = messages.get(activeRoomId) ?? [];
    const out: RailEntry[] = [];
    for (const m of list) {
      if (!m.attachments?.length) continue;
      const senderName =
        m.senderId === 'human' ? 'You' : agents.find((a) => a.id === m.senderId)?.displayName ?? m.senderId;
      for (const attachment of m.attachments) {
        out.push({ attachment, senderId: m.senderId, senderName, createdAt: m.createdAt });
      }
    }
    return out.slice().reverse(); // newest first
  }, [activeRoomId, messages, agents]);

  if (!filesRailOpen) return null;

  async function handleFiles(files: FileList | File[]) {
    if (!room) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded: AttachmentRef[] = [];
      for (const file of list) {
        uploaded.push(await uploadFile(file));
      }
      // Same post-upload send the composer does, so the attachment enters
      // room history (no new routes — this is the existing chat.send path).
      const message: OutboundMessage = {
        role: 'user',
        senderId: 'human',
        senderName: 'You',
        content: '',
        attachments: uploaded,
      };
      sendClientEvent({ type: 'chat.send', payload: { roomId: room.id, message } });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="files-rail">
      <div className="inspect-header">
        <div className="inspect-title">Files {room ? `— ${room.name}` : ''}</div>
        <button className="cbtn" onClick={toggleFilesRail} title="Close">
          ✕
        </button>
      </div>

      <div className="files-rail-upload">
        <label className="cbtn" title="Upload file" style={{ opacity: room ? 1 : 0.5 }}>
          {uploading ? '⏳ Uploading…' : '📎 Upload file'}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            disabled={!room || uploading}
            onChange={(e) => e.target.files && void handleFiles(e.target.files)}
          />
        </label>
        {uploadError && <div className="files-rail-error">{uploadError}</div>}
      </div>

      <div className="files-rail-list">
        {entries.length === 0 && (
          <div className="empty-hint">No attachments in this room yet.</div>
        )}
        {entries.map(({ attachment, senderId, senderName, createdAt }) => (
          <a
            key={`${attachment.id}-${senderId}-${createdAt}`}
            className="files-rail-row"
            href={attachmentUrl(attachment)}
            target="_blank"
            rel="noreferrer"
          >
            <div className="ic">{iconFor(attachment.mimeType)}</div>
            <div className="files-rail-meta">
              <div className="fn">{attachment.filename}</div>
              <div className="fs">
                {formatSize(attachment.size)} · {senderName} ·{' '}
                {new Date(createdAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
