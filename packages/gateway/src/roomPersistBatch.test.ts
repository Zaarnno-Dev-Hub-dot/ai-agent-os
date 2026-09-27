import { describe, expect, it, vi } from 'vitest';
import { createBatchedRunner } from './roomPersistBatch.js';

describe('createBatchedRunner (W8-3 item 1: bulk room.archive burst guard)', () => {
  it('coalesces a burst of triggers landing before the scheduled callback fires into exactly one run', () => {
    const run = vi.fn();
    let scheduled: (() => void) | undefined;
    const schedule = (cb: () => void) => {
      scheduled = cb;
    };
    const trigger = createBatchedRunner(run, schedule);

    // Simulate the documented incident: thousands of room.archive-style
    // mutations landing back-to-back on one connection, all arriving before
    // the scheduler ever gets a turn to run its callback.
    for (let i = 0; i < 5000; i++) trigger();

    // Nothing has actually persisted/broadcast yet — still batched, and the
    // scheduler was only ever asked to run ONCE for the whole burst (this is
    // what previously turned into 5000 synchronous full-DB writes).
    expect(run).not.toHaveBeenCalled();
    expect(scheduled).toBeTypeOf('function');

    scheduled?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a trigger that arrives after the previous batch already flushed', () => {
    const run = vi.fn();
    let scheduled: (() => void) | undefined;
    const schedule = (cb: () => void) => {
      scheduled = cb;
    };
    const trigger = createBatchedRunner(run, schedule);

    trigger();
    trigger();
    scheduled?.();
    expect(run).toHaveBeenCalledTimes(1);

    // A later, separate mutation (e.g. a single human room.rename after the
    // burst settled) must still get its own persist+broadcast, not be
    // dropped by a stale `pending` flag.
    scheduled = undefined;
    trigger();
    expect(scheduled).toBeTypeOf('function');
    scheduled?.();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a trigger() fired synchronously from inside run() schedules a fresh batch rather than being swallowed', () => {
    const run = vi.fn();
    let scheduled: (() => void) | undefined;
    const schedule = (cb: () => void) => {
      scheduled = cb;
    };
    // eslint-disable-next-line prefer-const -- trigger references itself via closure below
    let trigger: () => void;
    let reentered = false;
    run.mockImplementation(() => {
      if (!reentered) {
        reentered = true;
        trigger(); // re-entrant call, defensive case per the module's own comment
      }
    });
    trigger = createBatchedRunner(run, schedule);

    trigger();
    scheduled?.(); // runs the batch; run() re-enters trigger() once inside

    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduled).toBeTypeOf('function'); // the re-entrant trigger() scheduled a fresh batch

    scheduled?.();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('defaults to the real setImmediate when no scheduler is injected, still coalescing same-tick triggers', async () => {
    const run = vi.fn();
    const trigger = createBatchedRunner(run);

    trigger();
    trigger();
    trigger();
    expect(run).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
