import { useState } from 'react';
import type { Poll, PollAttachment, PollDisputeSide } from '../store/gatewayStore';
import { pollAttachments, pollRecommendationText, pollSummaryLines, resolveAttachmentView } from '../lib/pollPresent';

/**
 * Rich-card sections for the Approvals Inbox (Wave 6, docs/DESIGN-approvals-app-v2.md):
 * WHAT/WHY/RECOMMENDATION, an attachments gallery (images/graphs/tables/text),
 * and dispute columns (both agents' own statements, unedited, side by side).
 * Mounted only by PollCard's `variant="inbox"` — the rail/in-room variant is
 * unchanged (design doc correction #4: v1 polls render exactly as before).
 */
export function PollSummarySection({ poll }: { poll: Poll }) {
  const { what, why } = pollSummaryLines(poll);
  const rec = pollRecommendationText(poll);
  return (
    <div className="poll-rich-summary">
      <div className="poll-rich-block">
        <div className="poll-rich-label">What</div>
        <div className="poll-rich-body">{what}</div>
      </div>
      {why && (
        <div className="poll-rich-block">
          <div className="poll-rich-label">Why</div>
          <div className="poll-rich-body">{why}</div>
        </div>
      )}
      {rec && (
        <div className="poll-rich-block poll-rich-rec">
          <div className="poll-rich-label">Recommendation</div>
          <div className="poll-rich-body">{rec}</div>
        </div>
      )}
    </div>
  );
}

/**
 * SECURITY (design doc correction #1, reopened): this component used to
 * compute `attachmentSrc(att)` unconditionally and trust it in the fallback
 * branch's `<a href>` for ANY `att.kind` — but attachmentSrc's allowlist
 * checked url/data SHAPE, not `kind`, so a missing/misnamed kind (e.g. a
 * typo) paired with a `data:image/svg+xml;base64,...` payload still resolved
 * to a "safe" src there, and unlike `<img src>`, a top-level navigation via
 * `<a href>` DOES execute an embedded `<script>`. Dispatch now goes entirely
 * through pollPresent.ts's resolveAttachmentView(), which gates on `kind`
 * before ever trusting attachmentSrc's output (and is itself unit-tested —
 * see pollPresent.test.ts) — so there is no `src`/`href` construction left in
 * this component at all, only a rendering choice over an already-decided,
 * already-safe view.
 */
function AttachmentTile({ att }: { att: PollAttachment }) {
  const [expanded, setExpanded] = useState(false);
  const caption = att.caption?.trim();
  const view = resolveAttachmentView(att);

  if (view.view === 'plain-text') {
    const long = view.body.length > 280;
    return (
      <div className="poll-att poll-att-text">
        <div className="poll-att-kind">{att.kind}</div>
        {caption && <div className="poll-att-caption">{caption}</div>}
        <pre className={`poll-att-pre ${expanded ? 'expanded' : 'clamped'}`}>{view.body || '(empty)'}</pre>
        {long && (
          <button type="button" className="poll-att-expand" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    );
  }

  if (view.view === 'visual') {
    return (
      <figure className="poll-att poll-att-visual">
        <img src={view.src} alt={caption || att.kind} className="poll-att-img" />
        {caption && <figcaption className="poll-att-caption">{caption}</figcaption>}
        {att.source && <div className="poll-att-source">{att.source}</div>}
      </figure>
    );
  }

  // view.view === 'blocked': either a visual attachment whose url/data failed
  // the allowlist, or a kind this card doesn't recognize at all. Deliberately
  // renders inert text only — never a link, never `att.url`/`att.data` read
  // directly (gatewayStore.ts's own rule: attachmentSrc, via
  // resolveAttachmentView, is the ONLY place those fields may become a DOM
  // sink, and it already said no).
  return (
    <div className="poll-att poll-att-fallback">
      <div className="poll-att-kind">{att.kind}</div>
      {caption && <div className="poll-att-caption">{caption}</div>}
      <span className="poll-att-missing">
        {view.hasSource ? 'Blocked source (not on the allowlist)' : 'No renderable URL or data'}
      </span>
    </div>
  );
}

export function PollAttachmentsGallery({ poll }: { poll: Poll }) {
  const items = pollAttachments(poll);
  if (items.length === 0) return null;
  return (
    <div className="poll-rich-section">
      <div className="poll-rich-label">Attachments</div>
      <div className="poll-att-gallery">
        {items.map((att, i) => (
          <AttachmentTile key={`${att.kind}-${i}`} att={att} />
        ))}
      </div>
    </div>
  );
}

function DisputeColumn({ side }: { side: PollDisputeSide }) {
  const text = side.statement?.trim() || side.summary?.trim() || '';
  return (
    <div className="poll-dispute-col">
      <div className="poll-dispute-agent">{side.agent}</div>
      <div className="poll-dispute-statement">{text || '(no statement)'}</div>
      {side.evidence && side.evidence.length > 0 && (
        <div className="poll-dispute-evidence">
          {side.evidence.map((att, i) => (
            <AttachmentTile key={i} att={att} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PollDisputeColumns({ poll }: { poll: Poll }) {
  const sides = poll.disputeSides;
  if (!sides?.length) return null;
  return (
    <div className="poll-rich-section">
      <div className="poll-rich-label">Dispute — both sides (unedited)</div>
      <div className="poll-dispute-grid">
        {sides.map((side, i) => (
          <DisputeColumn key={`${side.agent}-${i}`} side={side} />
        ))}
      </div>
    </div>
  );
}
