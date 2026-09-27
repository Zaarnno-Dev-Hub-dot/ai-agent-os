import { AgentSummary } from '@agent-os/shared';

export interface MentionCandidate {
  id: string;
  displayName: string;
  avatar: string;
  color: string;
}

export function agentsToMentionCandidates(agents: AgentSummary[]): MentionCandidate[] {
  const everyone: MentionCandidate = { id: 'everyone', displayName: 'everyone', avatar: '📣', color: '#c9a35c' };
  return [
    everyone,
    ...agents
      .filter((a) => a.status === 'VERIFIED')
      .map((a) => ({ id: a.id, displayName: a.displayName, avatar: a.avatar, color: a.color })),
  ];
}

export function MentionAutocomplete({
  candidates,
  query,
  activeIndex,
  onPick,
}: {
  candidates: MentionCandidate[];
  query: string;
  activeIndex: number;
  onPick: (candidate: MentionCandidate) => void;
}) {
  const filtered = candidates.filter((c) =>
    c.displayName.toLowerCase().includes(query.toLowerCase()) || c.id.toLowerCase().includes(query.toLowerCase())
  );

  if (filtered.length === 0) return null;

  return (
    <div className="mention-popup">
      {filtered.map((c, i) => (
        <div
          key={c.id}
          className={`mention-item ${i === activeIndex ? 'active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
        >
          <span className="mention-av" style={{ background: `${c.color}33` }}>
            {c.avatar}
          </span>
          @{c.id}
          <span className="mention-name">{c.displayName}</span>
        </div>
      ))}
    </div>
  );
}
