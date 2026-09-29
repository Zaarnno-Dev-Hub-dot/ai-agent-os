import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BusySendGate, TurnSerializer, isExistingFile, newestBundledBinary } from './cliKit';

describe('isExistingFile', () => {
  it('rejects bare command names even if a same-named file exists in cwd', () => {
    expect(isExistingFile('claude')).toBe(false);
  });

  it('accepts an existing path and rejects a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clikit-'));
    const file = join(dir, 'tool.exe');
    writeFileSync(file, '');
    expect(isExistingFile(file)).toBe(true);
    expect(isExistingFile(join(dir, 'missing.exe'))).toBe(false);
  });
});

describe('newestBundledBinary', () => {
  it('picks numerically-newest version dir, not lexicographic', () => {
    const root = mkdtempSync(join(tmpdir(), 'clikit-vers-'));
    for (const v of ['2.1.20', '2.1.197', '2.1.3']) {
      mkdirSync(join(root, v));
      writeFileSync(join(root, v, 'claude.exe'), '');
    }
    expect(newestBundledBinary(root, 'claude.exe')).toBe(join(root, '2.1.197', 'claude.exe'));
  });

  it('skips version dirs missing the binary (mid-update window)', () => {
    const root = mkdtempSync(join(tmpdir(), 'clikit-mid-'));
    mkdirSync(join(root, '1.0.0'));
    writeFileSync(join(root, '1.0.0', 'claude.exe'), '');
    mkdirSync(join(root, '2.0.0')); // updater created dir, exe not written yet
    expect(newestBundledBinary(root, 'claude.exe')).toBe(join(root, '1.0.0', 'claude.exe'));
  });

  it('returns undefined for a missing root or empty root', () => {
    expect(newestBundledBinary(join(tmpdir(), 'clikit-nope-xyz'), 'a.exe')).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), 'clikit-empty-'));
    expect(newestBundledBinary(empty, 'a.exe')).toBeUndefined();
  });
});

describe('TurnSerializer', () => {
  it('runs turns strictly one at a time, FIFO', async () => {
    const s = new TurnSerializer();
    const order: string[] = [];
    let running = 0;
    const turn = (id: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        running += 1;
        expect(running).toBe(1);
        setTimeout(() => {
          running -= 1;
          order.push(id);
          resolve(id);
        }, ms);
      });
    const [a, b, c] = await Promise.all([
      s.run(turn('a', 30)),
      s.run(turn('b', 5)),
      s.run(turn('c', 1)),
    ]);
    expect(order).toEqual(['a', 'b', 'c']); // FIFO despite b, c being faster
    expect([a, b, c]).toEqual(['a', 'b', 'c']);
    expect(s.pending).toBe(0);
  });

  it('a rejected turn reaches its caller but does not poison the queue', async () => {
    const s = new TurnSerializer();
    const failed = s.run(async () => {
      throw new Error('turn exploded');
    });
    await expect(failed).rejects.toThrow('turn exploded');
    await expect(s.run(async () => 'still works')).resolves.toBe('still works');
    expect(s.pending).toBe(0);
  });
});

/**
 * Q7:
 * behavior-preserving extraction of the grace-wait-then-throw busy gate both
 * claude-code's and grok-build's `send()` hand-rolled identically. The
 * acceptance bar is zero behavior change — these pin the exact control flow,
 * including the 2026-07-04 grok-build busy-race crash class staying
 * impossible (a genuinely-concurrent second send must still throw, never
 * silently queue like TurnSerializer would).
 */
describe('BusySendGate', () => {
  it('idle path: enter() succeeds immediately, marks the gate busy', async () => {
    const gate = new BusySendGate();
    expect(gate.isBusy).toBe(false);
    await gate.enter('busy');
    expect(gate.isBusy).toBe(true);
    expect(gate.current).toBeNull(); // caller has not attached a pump yet
  });

  it('grace-wait: a caller queued behind an in-flight turn resolves (no throw) once that turn\'s own finally releases the gate — the exact 2026-07-04 stale-flag window, generalized', async () => {
    const gate = new BusySendGate();
    let releaseTurnWork: (() => void) | undefined;
    const turnWork = new Promise<void>((resolve) => {
      releaseTurnWork = resolve;
    });

    await gate.enter('session busy — turn A');
    // Mirrors each adapter's own turnPump IIFE: release() (was `this.busy =
    // false`) runs in the pump's OWN finally, which fires BEFORE the pump
    // promise itself settles — same ordering as the real 2026-07-04 race
    // (message-complete streams out before the turn pump's finally clears
    // busy).
    gate.attach(
      (async () => {
        try {
          await turnWork;
        } finally {
          gate.release();
        }
      })()
    );

    // A second caller arrives while turn A is still in flight — it must
    // grace-wait, not throw immediately.
    const second = gate.enter('session busy — turn B');

    // Let turn A's work resolve; its finally clears busy before the pump
    // itself settles, so the grace-wait loop sees busy=false once it wakes.
    releaseTurnWork!();
    await expect(second).resolves.toBeUndefined();
    expect(gate.isBusy).toBe(true); // the second caller now holds the gate
  });

  it('a rejected turn does not poison the gate for the next grace-waiting caller (rejection is swallowed, not propagated to the waiter)', async () => {
    const gate = new BusySendGate();
    let failTurn: ((e: Error) => void) | undefined;
    const turnWork = new Promise<void>((_resolve, reject) => {
      failTurn = reject;
    });

    await gate.enter('busy A');
    gate.attach(
      (async () => {
        try {
          await turnWork;
        } finally {
          gate.release();
        }
      })().catch(() => undefined) // adapters swallow their own turn's error into an AgentEvent, never let it reject the stored pump
    );

    const second = gate.enter('busy B');
    failTurn!(new Error('turn A blew up'));
    await expect(second).resolves.toBeUndefined();
  });

  it('two truly-simultaneous enter() calls (zero stagger, no pump to grace-wait on yet) — first claims the gate, second throws immediately: the 2026-07-04 crash class stays impossible', async () => {
    const gate = new BusySendGate();
    const pFirst = gate.enter('session busy — gateway must serialize sends per agent');
    // No await between these two — fired on the same tick, exactly like two
    // real concurrent adapter sends racing relay.ts's per-agent queue.
    const pSecond = gate.enter('session busy — gateway must serialize sends per agent');

    await expect(pFirst).resolves.toBeUndefined();
    await expect(pSecond).rejects.toThrow('session busy — gateway must serialize sends per agent');
    expect(gate.isBusy).toBe(true); // the winner's claim stands
  });

  it('current exposes the attached pump for interrupt()-style callers, and clears busy without nulling current (matches original: turnPump is never reset to null)', async () => {
    const gate = new BusySendGate();
    await gate.enter('busy');
    let resolvePump: (() => void) | undefined;
    const pump = new Promise<void>((resolve) => {
      resolvePump = resolve;
    });
    gate.attach(pump);
    expect(gate.current).toBe(pump);

    gate.release();
    expect(gate.isBusy).toBe(false);
    expect(gate.current).toBe(pump); // still readable — interrupt() can await it out after release too

    resolvePump!();
    await pump;
  });
});
