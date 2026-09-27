import { AttachmentRef } from '@agent-os/shared';
import { gatewayHttpOrigin } from '../lib/gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

/**
 * Content types the gateway will serve inline (see INLINE_SAFE_CONTENT_TYPES in
 * packages/gateway/src/files.ts — keep in sync). Deliberately excludes
 * image/svg+xml: SVG can carry <script>/event-handler markup, so it must never
 * be rendered via <img>/<iframe> from the gateway origin. Non-listed mimetypes
 * always render as a download chip, never an inline image.
 */
const INLINE_SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function attachmentUrl(a: AttachmentRef): string {
  return a.url ?? `${GATEWAY_ORIGIN}/api/files/${a.id}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentView({ attachment }: { attachment: AttachmentRef }) {
  const isImage = INLINE_SAFE_IMAGE_TYPES.has(attachment.mimeType);

  if (isImage) {
    return (
      <a href={attachmentUrl(attachment)} target="_blank" rel="noreferrer" className="attach-image-link">
        <img src={attachmentUrl(attachment)} alt={attachment.filename} className="attach-image" />
      </a>
    );
  }

  return (
    <a href={attachmentUrl(attachment)} target="_blank" rel="noreferrer" className="attach">
      <div className="ic">📄</div>
      <div>
        <div className="fn">{attachment.filename}</div>
        <div className="fs">
          {formatSize(attachment.size)} · {attachment.mimeType}
        </div>
      </div>
    </a>
  );
}

export function PendingAttachmentChip({
  filename,
  size,
  onRemove,
  uploading,
}: {
  filename: string;
  size: number;
  onRemove: () => void;
  uploading: boolean;
}) {
  return (
    <div className="pending-attach">
      <div className="ic">{uploading ? '⏳' : '📄'}</div>
      <div className="pending-attach-info">
        <div className="fn">{filename}</div>
        <div className="fs">{formatSize(size)}</div>
      </div>
      <button type="button" className="pending-attach-remove" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}
