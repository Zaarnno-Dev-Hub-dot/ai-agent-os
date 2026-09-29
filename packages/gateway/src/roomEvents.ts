import type { Room, ServerEvent } from '@agent-os/shared';

/**
 * The `room.created` broadcast a successful `room.create` must emit
 * ("room.create never emits room.created" — the shared
 * `ServerEvent` union declares this event, but until this fix the handler
 * only ever broadcast a fresh `state.sync`. Any client/script that waited on
 * `room.created` to learn the new room's id instead hung forever, and one
 * such script's retry-on-timeout loop created 5,721 duplicate rooms in a
 * live incident —  for the full writeup).
 *
 * Pure — no I/O — so it's unit-testable in isolation from `index.ts`, which
 * cannot itself be imported into a test process: it's an ~1800-line
 * top-level-executing module that opens the real `data/` DB and binds
 * Fastify to the LIVE gateway's:4110 port as a side effect of import
 * (`openDatabase`/`.listen()` both run at module scope, not behind an
 * exported "start" function). Importing it here would start a second live
 * gateway instance against production data — out of bounds for this
 * session. `index.ts`'s `room.create` handler calls this helper at its one
 * call site, so this test exercises the real production code path for the
 * event's shape even though the handler's broadcast() call itself isn't
 * covered end-to-end.
 */
export function buildRoomCreatedEvent(room: Room): ServerEvent {
  return { type: 'room.created', payload: room };
}
