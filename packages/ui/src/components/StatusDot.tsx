import { AgentStatus } from '@agent-os/shared';

export const STATUS_COLORS: Record<AgentStatus, string> = {
  REGISTERED: '#5c6672',
  CONNECTING: '#d29922',
  CHALLENGED: '#d29922',
  VERIFIED: '#3fb950',
  STALE: '#d29922',
  OFFLINE: '#5c6672',
  FAILED: '#f85149',
};

export function StatusDot({ status }: { status: AgentStatus }) {
  return <div className="dot" style={{ background: STATUS_COLORS[status] }} />;
}
