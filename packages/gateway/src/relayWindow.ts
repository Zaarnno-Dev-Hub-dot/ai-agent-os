/**
 * Relay history windowing. The actual fix
 * for hermes's context growth is per-turn session rotation (see the hermes
 * adapter's send()) — this module supplies the OTHER half: what context an
 * agent WITHOUT native session persistence should see each turn, capped at a
 * fixed number of recent messages instead of the whole room.
 *
 * Targets that DO carry their own memory (manifest.capabilities includes
 * 'resume-session': claude-code, grok-build via --resume) skip this entirely
 * and get the existing single-message outbound — re-feeding history to them
 * is pure waste. This module only matters for hermes/openclaw-shaped
 * adapters.
 */

import type { Message, OutboundMessage, Room } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';

/**
 * Build a windowed OutboundMessage: content is a context block of the last
 * min(windowSize, available) non-deleted room messages, one per line as
 * `[DisplayName]: content`, followed by an instruction line addressing the
 * target agent. senderId/senderName are set to the TRIGGERING message's
 * sender (source), not a synthetic "system" sender — this keeps role
 * mapping consistent with outboundFromMessage (human -> 'user', agent ->
 * 'assistant') for whichever adapter receives this.
 *
 * The hermes adapter prefixes outbound content with `[sender]: ` (see
 * HermesSession.send), so the FIRST line of this block is a header —
 * "(room context — last N messages)" — precisely so that prefix reads
 * sanely: `[You]: (room context — last N messages)` rather than the
 * prefix appearing to attribute the whole transcript to one speaker.
 */
export function composeWindowedOutbound(
  deps: RelayDeps,
  room: Room,
  source: Message,
  windowSize: number,
  targetAgentId: string
): OutboundMessage {
  const all = (deps.messages.get(room.id) ?? []).filter((m) => m.deletedAt == null);
  const windowed = all.slice(-Math.max(0, windowSize));

  const lines = windowed.map((m) => {
    const name = m.senderId === 'human' ? 'You' : deps.agentDisplayName(m.senderId);
    return `[${name}]: ${m.content}`;
  });

  const targetName = deps.agentDisplayName(targetAgentId);
  const content = [
    `(room context — last ${windowed.length} messages)`,
    ...lines,
    `You are ${targetName}. Reply to the latest message addressed to you.`,
  ].join('\n');

  const senderName = source.senderId === 'human' ? 'You' : deps.agentDisplayName(source.senderId);

  return {
    role: source.senderId === 'human' ? 'user' : 'assistant',
    senderId: source.senderId,
    senderName,
    content,
    mentions: source.mentions,
    replyTo: source.replyTo,
  };
}
