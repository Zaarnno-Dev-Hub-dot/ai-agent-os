import { describe, expect, it } from 'vitest';
import type { Room } from '@agent-os/shared';
import { buildRoomCreatedEvent } from './roomEvents.js';

// docs/TECH-DEBT.md "room.create never emits room.created" — regression
// coverage for the event shape index.ts's room.create handler now
// broadcasts. See roomEvents.ts's doc comment for why index.ts itself
// (the actual wiring point) cannot be imported into a test process.
describe('buildRoomCreatedEvent', () => {
  const room: Room = {
    id: 'room-1',
    name: 'Test Room',
    type: 'group',
    memberIds: ['hermes'],
    createdAt: 1000,
    updatedAt: 1000,
    turnCap: 12,
  };

  it('wraps the room in a room.created ServerEvent with the room as payload', () => {
    expect(buildRoomCreatedEvent(room)).toEqual({ type: 'room.created', payload: room });
  });

  it('carries the exact same room reference through, not a copy', () => {
    const event = buildRoomCreatedEvent(room);
    expect(event.type).toBe('room.created');
    expect((event as { payload: Room }).payload).toBe(room);
  });

  it('reflects an archived/updated room as-is (no field filtering)', () => {
    const archived: Room = { ...room, archivedAt: 2000, updatedAt: 2000 };
    expect(buildRoomCreatedEvent(archived)).toEqual({ type: 'room.created', payload: archived });
  });
});
