import { Message } from '@agent-os/shared';

import { gatewayHttpOrigin } from './gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

export async function fetchRoomMessages(roomId: string, before?: number, limit = 50): Promise<Message[]> {
  const params = new URLSearchParams();
  if (before != null) params.set('before', String(before));
  params.set('limit', String(limit));
  const res = await fetch(`${GATEWAY_ORIGIN}/api/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load messages: ${res.status}`);
  return (await res.json()) as Message[];
}
