import { useStore } from '../store/gatewayStore';

export function TypingIndicator({ roomId }: { roomId: string | null }) {
  const { typing, agents } = useStore();
  if (!roomId) return null;

  const active = Array.from(typing.values()).filter((t) => t.roomId === roomId);
  if (active.length === 0) return null;

  return (
    <div className="typing">
      {active.map((t) => {
        const agent = agents.find((a) => a.id === t.agentId);
        return (
          <span key={t.agentId}>
            <span>
              {agent?.avatar ?? '⚙'} {agent?.displayName ?? t.agentId} is working
            </span>{' '}
            {t.tool && <span className="dots">⚙ {t.tool}…</span>}
          </span>
        );
      })}
    </div>
  );
}
