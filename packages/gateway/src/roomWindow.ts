/**
 * Archived-room windowing for state.sync (review 2026-08-04 §4.2 / RISK 2).
 *
 * ROOT CAUSE (measured against the live gateway on 2026-08-04, not guessed):
 * buildStateSync returned EVERY archived room that has ever existed. At 886
 * archived rooms that was 283.4 KB of a 330.1 KB payload — 86% of every
 * state.sync — re-serialized once per connected client, on every room/project/
 * poll mutation, every ephemeral announce, every agent connect/disconnect, and
 * unconditionally every 60 s from the Paperclip poll tick. No client renders
 * more than the top of that list.
 *
 * Room count grows from an automated source rather than from the operator (a
 * liveness probe minted one permanent room per run — see §4.4 and
 * Team\toolbox\Delivery-Smoke.mjs), so this is a growth axis, not a plateau:
 * the same trajectory reaches ~13,000 rooms and a ~4 MB field in six months.
 *
 * FIX: the precedent was already three lines away in the same payload —
 * `polls` is windowed to open + the last 20 settled (polls.ts
 * pollsForStateSync). Do the same for archived rooms, and serve the rest from
 * GET /api/rooms/archived?before= (cursor semantics copied from the existing
 * GET /api/rooms/:roomId/messages?before= route).
 *
 * ORDERING IS DELIBERATE: both functions return ASCENDING by updatedAt and
 * take the tail via slice(-limit). The gateway previously emitted archived
 * rooms in `rooms` Map order, which is created_at ASC (db.ts loadRooms' ORDER
 * BY), and Sidebar.tsx renders `archivedRooms.map(...)` in raw array order —
 * so returning newest-first here would silently flip the Archived list in the
 * UI. Windowing is a payload-size change; it is not licence to reorder what
 * the operator sees.
 *
 * Extracted into its own module rather than left inline in buildStateSync for
 * the same reason roomPersistBatch.ts was: index.ts cannot be imported by a
 * test (Fastify listen + WS server + several setIntervals fire on import), so
 * logic left inline there is untestable by construction.
 */
import type { Room } from '@agent-os/shared';

/**
 * How many archived rooms reach a client in state.sync. Anything older is a
 * paging concern, not a broadcast concern.
 */
export const ARCHIVED_ROOMS_WINDOW = 50;

/** Archived rooms only, oldest-updated first — the shared basis for both views below. */
function archivedByUpdatedAtAsc(rooms: Iterable<Room>): Room[] {
  return Array.from(rooms)
    .filter((r) => r.archivedAt != null)
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * The state.sync slice: the `limit` most recently updated archived rooms, in
 * ascending updatedAt order (see ORDERING note in the module header).
 */
export function archivedRoomsForStateSync(
  rooms: Iterable<Room>,
  limit: number = ARCHIVED_ROOMS_WINDOW
): Room[] {
  if (limit <= 0) return [];
  return archivedByUpdatedAtAsc(rooms).slice(-limit);
}

/**
 * The paging slice behind GET /api/rooms/archived?before=&limit=.
 *
 * `before` is an exclusive updatedAt cursor: pass the updatedAt of the oldest
 * row you already hold to get the page immediately older than it. Same shape
 * and same slice(-limit) tail convention as the messages pagination route, so
 * a caller that already knows one knows the other. No `before` = the newest
 * page, i.e. identical to what state.sync carries.
 */
export function archivedRoomsPage(
  rooms: Iterable<Room>,
  before?: number,
  limit: number = ARCHIVED_ROOMS_WINDOW
): Room[] {
  if (limit <= 0) return [];
  const all = archivedByUpdatedAtAsc(rooms);
  const older = before == null ? all : all.filter((r) => r.updatedAt < before);
  return older.slice(-limit);
}
