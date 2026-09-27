/**
 * Archived-room windowing (review 2026-08-04 §4.2). The properties worth
 * pinning are the ones a future edit is most likely to break silently:
 * the cap itself, the ASCENDING order the Sidebar renders in, and the
 * cursor semantics that make the paging route lossless (no archived room
 * becomes unreachable now that state.sync stopped carrying all of them).
 */
import { describe, expect, it } from 'vitest';
import type { Room } from '@agent-os/shared';
import {
  ARCHIVED_ROOMS_WINDOW,
  archivedRoomsForStateSync,
  archivedRoomsPage,
} from './roomWindow.js';

function room(id: string, updatedAt: number, archived: boolean): Room {
  return {
    id,
    name: `room ${id}`,
    type: 'group',
    memberIds: [],
    createdAt: 1_000,
    updatedAt,
    archivedAt: archived ? updatedAt : undefined,
    turnCap: 12,
  };
}

/** n archived rooms with updatedAt 1..n, deliberately shuffled on the way in. */
function manyArchived(n: number): Room[] {
  const rooms = Array.from({ length: n }, (_, i) => room(`a${i + 1}`, i + 1, true));
  return rooms.sort(() => (Math.random() < 0.5 ? 1 : -1));
}

describe('archivedRoomsForStateSync', () => {
  it('excludes active rooms entirely', () => {
    const out = archivedRoomsForStateSync([
      room('active-1', 10, false),
      room('archived-1', 20, true),
      room('active-2', 30, false),
    ]);
    expect(out.map((r) => r.id)).toEqual(['archived-1']);
  });

  it('caps the payload at the window size', () => {
    const out = archivedRoomsForStateSync(manyArchived(886));
    expect(out).toHaveLength(ARCHIVED_ROOMS_WINDOW);
    expect(ARCHIVED_ROOMS_WINDOW).toBe(50);
  });

  it('keeps the 50 MOST RECENTLY updated, not the oldest 50', () => {
    const out = archivedRoomsForStateSync(manyArchived(886));
    expect(out[out.length - 1].updatedAt).toBe(886);
    expect(out[0].updatedAt).toBe(886 - ARCHIVED_ROOMS_WINDOW + 1);
  });

  it('returns ascending updatedAt — Sidebar renders this array in raw order, so the order must not flip', () => {
    const out = archivedRoomsForStateSync(manyArchived(120));
    const stamps = out.map((r) => r.updatedAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it('returns everything when there are fewer archived rooms than the window', () => {
    const out = archivedRoomsForStateSync([room('a', 1, true), room('b', 2, true)]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('handles an empty world without throwing', () => {
    expect(archivedRoomsForStateSync([])).toEqual([]);
  });
});

describe('archivedRoomsPage (GET /api/rooms/archived?before=)', () => {
  it('with no cursor returns the same newest page state.sync carries', () => {
    const rooms = manyArchived(886);
    expect(archivedRoomsPage(rooms).map((r) => r.id)).toEqual(
      archivedRoomsForStateSync(rooms).map((r) => r.id)
    );
  });

  it('before= is an EXCLUSIVE cursor — the row at the cursor is not repeated', () => {
    const rooms = manyArchived(200);
    const firstPage = archivedRoomsPage(rooms);
    const oldestHeld = firstPage[0].updatedAt;

    const nextPage = archivedRoomsPage(rooms, oldestHeld);
    expect(nextPage.every((r) => r.updatedAt < oldestHeld)).toBe(true);
    expect(nextPage[nextPage.length - 1].updatedAt).toBe(oldestHeld - 1);
  });

  it('paging backwards walks the whole archive with no gaps and no duplicates', () => {
    const total = 237;
    const rooms = manyArchived(total);
    const seen: string[] = [];
    let cursor: number | undefined;

    for (;;) {
      const page = archivedRoomsPage(rooms, cursor);
      if (page.length === 0) break;
      seen.unshift(...page.map((r) => r.id));
      cursor = page[0].updatedAt;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Every archived room is still reachable after windowing state.sync.
    expect(seen[0]).toBe('a1');
    expect(seen[seen.length - 1]).toBe(`a${total}`);
  });

  it('respects an explicit limit and still excludes active rooms', () => {
    const rooms = [...manyArchived(30), room('active', 999, false)];
    const page = archivedRoomsPage(rooms, undefined, 5);
    expect(page).toHaveLength(5);
    expect(page.some((r) => r.id === 'active')).toBe(false);
  });

  it('a non-positive limit returns nothing rather than the whole archive', () => {
    expect(archivedRoomsPage(manyArchived(10), undefined, 0)).toEqual([]);
    expect(archivedRoomsForStateSync(manyArchived(10), 0)).toEqual([]);
  });

  it('a cursor older than everything returns an empty page', () => {
    expect(archivedRoomsPage(manyArchived(10), 1)).toEqual([]);
  });
});
