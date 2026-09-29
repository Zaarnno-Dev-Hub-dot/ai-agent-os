/**
 * Wave 8 W8-3 item 1 — burst guard for persistRoomMutation.
 *
 * ROOT CAUSE (confirmed by reading index.ts's persistRoomMutation, not
 * guessed): every single room mutation — room.create, room.rename,
 * room.archive, room.unarchive, room.members, room.set-budget — ran
 * `persistDatabase()` (a full sql.js `db.export()` + synchronous
 * `writeFileSync` of the WHOLE database file) and `broadcast(buildStateSync())`
 * (a full state snapshot re-serialized and sent to EVERY connected client)
 * inline, on every call, on the same tick that received the WS message. A
 * burst of `room.archive` messages sent back-to-back on one connection (a
 * bulk "archive N rooms" UI action, or a retry-loop bug — see the
 * documented incident: 5,721 duplicate rooms from a runaway smoke script)
 * turned into N synchronous full-DB serializations + N full broadcasts
 * chained with no yield back to the event loop between them. At ~100 this
 * was enough to make `/health` miss its own request's timeout budget; at
 * 5,000+ (unthrottled) it exhausted the process entirely, with zero
 * diagnostic output because stdout/stderr was discarded under the
 * scheduled task at the time (a since-fixed, separate issue).
 *
 * The existing `setInterval(() => persistDatabase(db, config.dataDir), 5000)`
 * in index.ts is a periodic backstop, not a fix for this — it does nothing
 * to stop N synchronous writes from blocking the loop on the way in.
 *
 * FIX: coalesce every `trigger()` call that lands before the scheduled
 * callback actually runs into exactly ONE invocation of `run`. The
 * correctness-critical, cheap part of a room mutation (`rooms.set` +
 * `saveRoom`'s single-row sql.js INSERT) stays fully synchronous on every
 * call — any handler logic reading the in-memory `rooms` map immediately
 * after a call still sees the fresh state. Only the expensive, batchable
 * parts (full-DB disk write, full-state broadcast) are deferred and shared
 * across the whole burst. A lone, isolated mutation still gets persisted
 * and broadcast almost immediately (one scheduler tick later) — this only
 * changes behavior when calls actually overlap.
 *
 * Extracted into its own tiny pure module (rather than left inline in
 * persistRoomMutation) specifically so this batching behavior is
 * unit-testable without booting the real gateway — index.ts has no test
 * harness of its own (Fastify listen + WS server + several setIntervals
 * fire on import), so testing the coalescing logic in place isn't
 * practical. `schedule` defaults to the real `setImmediate` but is
 * injectable so a test can drive it deterministically.
 */
export function createBatchedRunner(run: () => void, schedule: (cb: () => void) => void = setImmediate) {
  let pending = false;
  return function trigger(): void {
    if (pending) return;
    pending = true;
    schedule(() => {
      // Reset BEFORE running `run`, not after: a trigger() call that
      // happens synchronously from inside `run` itself (not expected today,
      // but defensive) must schedule a fresh batch rather than being
      // silently swallowed by a still-true `pending` flag.
      pending = false;
      run();
    });
  };
}
