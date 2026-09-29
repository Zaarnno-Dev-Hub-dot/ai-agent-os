/**
 * Helpers shared by CLI-flavor adapters (claude-code, grok-build, future CLI
 * harnesses). Extracted  "adapter duplication": these
 * were copy-pasted per adapter, and the send-serialization pattern in
 * particular has a subtle correctness constraint worth owning in one place.
 */

import { existsSync } from 'fs';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * True when the configured command is a concrete file path that exists, as
 * opposed to a bare name to be resolved on PATH. Adapters use this in
 * verifyBinaryAndAuth so file-path overrides (desktop bundles, ~/.grok/bin)
 * don't get rejected by PATH-only resolution.
 */
export function isExistingFile(command: string): boolean {
  return (command.includes('/') || command.includes('\\')) && existsSync(command);
}

/**
 * Newest subdirectory of `root` containing `filename`, by numeric-aware name
 * order (so '2.1.197' > '2.1.20', which plain lexicographic gets wrong).
 * Returns the full path to the file, or undefined. Used for desktop-app CLI
 * bundles that install as <root>/<version>/<exe> and are not on PATH.
 */
export function newestBundledBinary(root: string, filename: string): string | undefined {
  if (!existsSync(root)) return undefined;
  try {
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, filename)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const newest = versions[versions.length - 1];
    return newest ? join(root, newest, filename) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serializes async turns so a session never runs two at once, WITHOUT the
 * hand-rolled busy-wait loop each adapter currently carries.
 *
 * Why not `while (busy) await pump`: that pattern is only sound if the next
 * pump is assigned synchronously after the busy gate — an invariant nothing
 * enforces and a refactor can silently break (see REVIEW-2026-07-04 nit).
 * A promise chain has no such window: run() enqueues behind whatever is
 * already queued, FIFO, and the chain never rejects (each link settles even
 * when its turn throws — the caller still sees the rejection).
 */
export class TurnSerializer {
  private tail: Promise<void> = Promise.resolve();

  /** Number of turns queued or running (0 = idle). Diagnostic only. */
  private depth = 0;

  get pending(): number {
    return this.depth;
  }

  run<T>(turn: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const result = this.tail.then(turn);
    this.tail = result.then(
      () => {
        this.depth -= 1;
      },
      () => {
        this.depth -= 1;
      }
    );
    return result;
  }
}

/**
 * Behavior-preserving extraction of the busy-wait send gate hand-rolled,
 * byte-for-byte identically, in both claude-code's and grok-build's
 * `send()`.
 *
 * NOT a swap for TurnSerializer above: TurnSerializer resolves `run()` on
 * turn COMPLETION and queues concurrent callers — the right shape for a
 * caller that wants to await the actual result. relay.ts's `AgentRelayWorker.
 * runOne` awaits `session.send()` expecting it back once a turn is merely
 * KICKED OFF (so its own watchdog can start ticking), and — per the
 * documented 2026-07-04 grok-build busy-race — expects a genuinely-
 * concurrent send to THROW, not silently queue. `BusySendGate` reproduces
 * that exact control flow instead:
 *
 *   while (busy && pump) await pump.catch(() => undefined);  // grace-wait
 *   if (busy) throw <adapter-supplied message>;              // still busy? throw
 *   busy = true;                                              // claim it
 *
 * The grace-wait exists because `message-complete` streams out of the CLI
 * process (and reaches relay.ts's event consumer) BEFORE the turn pump's own
 * `finally` clears `busy` — an immediate next dispatch can observe `busy ===
 * true` for a few microtasks that are NOT a real second caller. Waiting the
 * CURRENT pump out (swallowing its rejection — a prior turn's failure is not
 * this caller's concern) absorbs exactly that window without turning a
 * genuinely-concurrent second send into a silent queue.
 *
 * Split into enter()/attach()/release() rather than taking the turn-runner
 * as a callback: each adapter's `interrupt()` needs to await the SAME
 * in-flight pump this gate holds (to let a hung child's kill actually settle
 * the turn), so the pump must stay a promise the adapter can also read, not
 * something swallowed entirely inside the gate.
 */
export class BusySendGate {
  private busy = false;
  private pump: Promise<void> | null = null;

  /** True while a turn is in flight. Diagnostic/test-only. */
  get isBusy(): boolean {
    return this.busy;
  }

  /** The in-flight turn promise, if any — same reference an adapter's own `turnPump` field held, for callers (interrupt()) that need to await it out. */
  get current(): Promise<void> | null {
    return this.pump;
  }

  /**
   * Grace-wait any in-flight pump out, then throw `busyMessage` if the
   * session is STILL busy once that clears — the exact control flow every
   * CLI adapter's `send()` hand-rolled. On success, marks the gate busy and
   * returns; the caller must call `attach()` next, with no `await` in
   * between, mirroring the original's synchronous `busy = true; turnPump =
   * ...` pairing (nothing can observe `busy` true with no pump attached).
   */
  async enter(busyMessage: string): Promise<void> {
    while (this.busy && this.pump) {
      await this.pump.catch(() => undefined);
    }
    if (this.busy) throw new Error(busyMessage);
    this.busy = true;
  }

  /** Adapter calls this synchronously right after `enter()` resolves, with its own fire-and-forget turn-pump promise (whose `finally` must call `release()`). */
  attach(pump: Promise<void>): void {
    this.pump = pump;
  }

  /** The turn-pump's own `finally` calls this to clear busy — same spot the hand-rolled `finally { this.busy = false; }` sat in each adapter. */
  release(): void {
    this.busy = false;
  }
}
