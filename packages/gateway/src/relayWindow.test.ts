import { describe, expect, it } from 'vitest';
import type { AgentState, Message, Room, ServerEvent } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';
import { composeWindowedOutbound } from './relayWindow.js';

function makeRoom(): Room {
  return {
    id: 'room-1',
    name: 'Test Room',
    type: 'group',
    memberIds: ['human', 'hermes'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: 12,
  };
}

function makeMessages(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `msg-${i}`,
      roomId: 'room-1',
      senderId: i % 2 === 0 ? 'human' : 'hermes',
      content: `message body ${i}`,
      createdAt: Date.now() + i,
    });
  }
  return out;
}

function makeDeps(messages: Message[]): RelayDeps {
  const messagesMap = new Map<string, Message[]>();
  messagesMap.set('room-1', messages);
  return {
    db: {} as RelayDeps['db'],
    dataDir: '/tmp/unused',
    agents: new Map<string, AgentState>(),
    rooms: new Map(),
    messages: messagesMap,
    roomRelay: new Map(),
    globalCost: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} },
    broadcast: (_event: ServerEvent) => undefined,
    agentDisplayName: (agentId: string) => (agentId === 'hermes' ? 'Hermes' : agentId),
  };
}

describe('composeWindowedOutbound', () => {
  it('windows a 40-message room down to exactly 30 messages in the content', () => {
    const room = makeRoom();
    const messages = makeMessages(40);
    const deps = makeDeps(messages);
    const source = messages[messages.length - 1];

    const outbound = composeWindowedOutbound(deps, room, source, 30, 'hermes');

    // Count `[Name]: ` line markers — one per windowed message, matching the
    // spec's "count the `[` line markers" acceptance approach.
    const lineMarkers = outbound.content
      .split('\n')
      .filter((line) => /^\[[^\]]+\]: /.test(line));
    expect(lineMarkers).toHaveLength(30);

    // The window is the LAST 30 messages (most recent), not the first 30.
    expect(outbound.content).toContain('message body 39');
    expect(outbound.content).toContain('message body 10');
    expect(outbound.content).not.toContain('message body 9\n');
  });

  it('includes all messages when the room has fewer than windowSize', () => {
    const room = makeRoom();
    const messages = makeMessages(5);
    const deps = makeDeps(messages);
    const source = messages[messages.length - 1];

    const outbound = composeWindowedOutbound(deps, room, source, 30, 'hermes');

    const lineMarkers = outbound.content.split('\n').filter((line) => /^\[[^\]]+\]: /.test(line));
    expect(lineMarkers).toHaveLength(5);
  });

  it('excludes deleted messages from the window', () => {
    const room = makeRoom();
    const messages = makeMessages(5);
    messages[2] = { ...messages[2], deletedAt: Date.now() };
    const deps = makeDeps(messages);
    const source = messages[messages.length - 1];

    const outbound = composeWindowedOutbound(deps, room, source, 30, 'hermes');

    expect(outbound.content).not.toContain('message body 2');
    const lineMarkers = outbound.content.split('\n').filter((line) => /^\[[^\]]+\]: /.test(line));
    expect(lineMarkers).toHaveLength(4);
  });

  it('starts with a context-block header and ends with the addressing instruction', () => {
    const room = makeRoom();
    const messages = makeMessages(3);
    const deps = makeDeps(messages);
    const source = messages[messages.length - 1];

    const outbound = composeWindowedOutbound(deps, room, source, 30, 'hermes');
    const lines = outbound.content.split('\n');

    expect(lines[0]).toBe('(room context — last 3 messages)');
    expect(lines[lines.length - 1]).toBe('You are Hermes. Reply to the latest message addressed to you.');
  });

  it('sets senderId/senderName to the triggering source message, not a synthetic sender', () => {
    const room = makeRoom();
    const messages = makeMessages(3);
    const deps = makeDeps(messages);
    const source = messages[messages.length - 1]; // sender alternates; index 2 -> 'hermes'

    const outbound = composeWindowedOutbound(deps, room, source, 30, 'hermes');

    expect(outbound.senderId).toBe(source.senderId);
    expect(outbound.role).toBe(source.senderId === 'human' ? 'user' : 'assistant');
  });
});
