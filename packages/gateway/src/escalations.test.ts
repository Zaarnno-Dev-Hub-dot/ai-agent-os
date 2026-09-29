import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync } from 'fs';
import {
  checkRateLimit,
  COOLDOWN_MS,
  DAILY_CAP,
  finalizeEscalationOutcome,
  isQuietHours,
  loadEscalations,
  quietHoursOptionsFromEnv,
  reserveEscalation,
  saveEscalations,
  secretGuard,
  withEscalationsLock,
  type EscalationRecord,
} from './escalations.js';

function record(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: 'e1',
    ts: Date.now(),
    severity: 'high',
    title: 't',
    bodyPreview: 'b',
    smsOutcome: 'sent',
    ...overrides,
  };
}

/** Hoisted to module scope — shared by every describe block below that needs an isolated data dir (was previously re-declared per-describe; concurrency tests below need it too). */
function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'escalations-test-'));
}

describe('checkRateLimit', () => {
  const NOON = new Date(2026, 6, 9, 12, 0, 0, 0).getTime(); // 2026-07-09 noon, local

  it('allows the first escalation of the day with no prior records', () => {
    expect(checkRateLimit([], NOON, 'high')).toEqual({ allowed: true });
  });

  it('blocks a second "high" within the 30-minute cooldown', () => {
    const records = [record({ ts: NOON - 5 * 60 * 1000 })]; // 5 min ago
    const result = checkRateLimit(records, NOON, 'high');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/cooldown/i);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(COOLDOWN_MS);
    }
  });

  it('allows a second "high" once the cooldown has elapsed', () => {
    const records = [record({ ts: NOON - (COOLDOWN_MS + 1000) })]; // just over 30 min ago
    expect(checkRateLimit(records, NOON, 'high')).toEqual({ allowed: true });
  });

  it('"critical" bypasses the cooldown', () => {
    const records = [record({ ts: NOON - 1000, severity: 'high' })]; // 1 second ago
    expect(checkRateLimit(records, NOON, 'critical')).toEqual({ allowed: true });
  });

  it('blocks at the daily cap regardless of cooldown state', () => {
    const records = Array.from({ length: DAILY_CAP }, (_, i) => record({ id: `e${i}`, ts: NOON - (i + 1) * 60 * 60 * 1000 }));
    const result = checkRateLimit(records, NOON, 'high');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/daily cap/i);
  });

  it('"critical" does NOT bypass the daily cap', () => {
    const records = Array.from({ length: DAILY_CAP }, (_, i) => record({ id: `e${i}`, ts: NOON - (i + 1) * 60 * 60 * 1000 }));
    const result = checkRateLimit(records, NOON, 'critical');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/daily cap/i);
  });

  it("does not count yesterday's escalations toward today's cap", () => {
    const yesterday = NOON - 24 * 60 * 60 * 1000;
    const records = Array.from({ length: DAILY_CAP + 2 }, (_, i) => record({ id: `y${i}`, ts: yesterday }));
    expect(checkRateLimit(records, NOON, 'high')).toEqual({ allowed: true });
  });

  it('daily-cap retryAfterMs points at the next local midnight, not a fixed offset', () => {
    const almostMidnight = new Date(2026, 6, 9, 23, 59, 0, 0).getTime();
    const records = Array.from({ length: DAILY_CAP }, (_, i) => record({ id: `e${i}`, ts: almostMidnight }));
    const result = checkRateLimit(records, almostMidnight, 'high');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60 * 1000); // <= 1 minute to midnight
    }
  });
});

describe('isQuietHours', () => {
  it('is quiet at 2am (default 00:00-08:00 window)', () => {
    expect(isQuietHours(new Date(2026, 6, 9, 2, 0, 0, 0))).toBe(true);
  });

  it('is quiet exactly at the start boundary (midnight, inclusive)', () => {
    expect(isQuietHours(new Date(2026, 6, 9, 0, 0, 0, 0))).toBe(true);
  });

  it('is NOT quiet exactly at the end boundary (8am, exclusive)', () => {
    expect(isQuietHours(new Date(2026, 6, 9, 8, 0, 0, 0))).toBe(false);
  });

  it('is not quiet at 10am', () => {
    expect(isQuietHours(new Date(2026, 6, 9, 10, 0, 0, 0))).toBe(false);
  });

  it('is not quiet at 11:59pm', () => {
    expect(isQuietHours(new Date(2026, 6, 9, 23, 59, 0, 0))).toBe(false);
  });

  it('respects a custom override window', () => {
    const opts = { startHour: 22, endHour: 6 }; // wraps midnight
    expect(isQuietHours(new Date(2026, 6, 9, 23, 0, 0, 0), opts)).toBe(true);
    expect(isQuietHours(new Date(2026, 6, 9, 3, 0, 0, 0), opts)).toBe(true);
    expect(isQuietHours(new Date(2026, 6, 9, 12, 0, 0, 0), opts)).toBe(false);
  });

  it('a degenerate startHour === endHour override disables the window (never quiet)', () => {
    expect(isQuietHours(new Date(2026, 6, 9, 3, 0, 0, 0), { startHour: 5, endHour: 5 })).toBe(false);
  });
});

describe('quietHoursOptionsFromEnv', () => {
  it('reads valid hour overrides from env', () => {
    expect(quietHoursOptionsFromEnv({ AGENT_OS_ESCALATE_QUIET_START_HOUR: '22', AGENT_OS_ESCALATE_QUIET_END_HOUR: '6' } as NodeJS.ProcessEnv)).toEqual({
      startHour: 22,
      endHour: 6,
    });
  });

  it('falls back to undefined (isQuietHours default) for missing/invalid values', () => {
    expect(quietHoursOptionsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ startHour: undefined, endHour: undefined });
    expect(quietHoursOptionsFromEnv({ AGENT_OS_ESCALATE_QUIET_START_HOUR: 'not-a-number' } as NodeJS.ProcessEnv).startHour).toBeUndefined();
    expect(quietHoursOptionsFromEnv({ AGENT_OS_ESCALATE_QUIET_START_HOUR: '99' } as NodeJS.ProcessEnv).startHour).toBeUndefined();
  });
});

describe('secretGuard', () => {
  it('allows ordinary escalation text', () => {
    expect(secretGuard('The gateway has been down for 45 minutes, please check on it.')).toEqual({ ok: true });
  });

  it('rejects an AWS access key', () => {
    const result = secretGuard('rotate AKIAABCDEFGHIJKLMNOP now');
    expect(result.ok).toBe(false);
  });

  it('rejects an sk- style API key', () => {
    const result = secretGuard('leaked key sk-abcdefghijklmnopqrstuvwx1234');
    expect(result.ok).toBe(false);
  });

  it('rejects a Bearer token', () => {
    const result = secretGuard('use Bearer abcdefghijklmnop1234567890 to auth');
    expect(result.ok).toBe(false);
  });

  it('rejects an inline "api_key: ..." assignment', () => {
    const result = secretGuard('config has api_key: sup3rs3cr3tvalue in it');
    expect(result.ok).toBe(false);
  });

  it('rejects an inline "password=" assignment', () => {
    const result = secretGuard('db password=hunter2ish set wrong');
    expect(result.ok).toBe(false);
  });

  it('never echoes the matched secret substring back in the rejection reason', () => {
    const secretValue = 'AKIAABCDEFGHIJKLMNOP';
    const result = secretGuard(`rotate ${secretValue} now`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain(secretValue);
  });
});

describe('loadEscalations / saveEscalations', () => {
  it('returns empty state when the file does not exist yet', () => {
    const dir = freshDataDir();
    try {
      expect(loadEscalations(dir)).toEqual({ escalations: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a saved state', () => {
    const dir = freshDataDir();
    try {
      const state = { escalations: [record({ id: 'r1' }), record({ id: 'r2', severity: 'critical' })] };
      saveEscalations(dir, state);
      expect(loadEscalations(dir)).toEqual(state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to empty state (not a crash) on a corrupt file', () => {
    const dir = freshDataDir();
    try {
      writeFileSync(join(dir, 'escalations.json'), '{ not valid json', 'utf8');
      expect(loadEscalations(dir)).toEqual({ escalations: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters out malformed records rather than failing the whole load', () => {
    const dir = freshDataDir();
    try {
      writeFileSync(
        join(dir, 'escalations.json'),
        JSON.stringify({ escalations: [record({ id: 'good' }), { id: 'bad-missing-fields' }, 'not-even-an-object'] }),
        'utf8'
      );
      const state = loadEscalations(dir);
      expect(state.escalations).toHaveLength(1);
      expect(state.escalations[0].id).toBe('good');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Fix-round regression coverage: the pre-fix route did
 * loadEscalations()+checkRateLimit() BEFORE its long bridge-wake await and
 * saveEscalations() with a pre-await snapshot AFTER — under concurrent
 * callers this both bypassed the daily cap (every caller checked the same
 * stale state) and lost records (each save clobbered the last). These tests
 * exercise reserveEscalation/finalizeEscalationOutcome/withEscalationsLock
 * directly, at the pure-module level, without a Fastify instance — see
 * escalateRoutes.test.ts for the end-to-end version against a real route.
 */
describe('withEscalationsLock', () => {
  it('runs queued callbacks strictly one at a time, in call order — a slow first caller is not overtaken by a fast second one', async () => {
    const order: number[] = [];
    const p1 = withEscalationsLock(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const p2 = withEscalationsLock(() => {
      order.push(3);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]); // p2's body never runs until p1's has fully settled
  });

  it('a throwing callback propagates to its own caller but does not wedge the queue for later callers', async () => {
    const p1 = withEscalationsLock(() => {
      throw new Error('boom');
    });
    await expect(p1).rejects.toThrow('boom');

    let ran = false;
    await withEscalationsLock(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('reserveEscalation / finalizeEscalationOutcome', () => {
  const NOON = new Date(2026, 6, 9, 12, 0, 0, 0).getTime();

  function pendingRecord(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
    return record({ smsOutcome: 'pending', ts: NOON, ...overrides });
  }

  it('a single reserve appends the record and allows, matching checkRateLimit directly', async () => {
    const dir = freshDataDir();
    try {
      const result = await reserveEscalation(dir, NOON, 'critical', pendingRecord({ id: 'solo' }));
      expect(result).toEqual({ allowed: true });
      expect(loadEscalations(dir).escalations).toEqual([pendingRecord({ id: 'solo' })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a reserve that is NOT allowed persists nothing (no slot consumed by a rejected reservation)', async () => {
    const dir = freshDataDir();
    try {
      saveEscalations(dir, { escalations: Array.from({ length: DAILY_CAP }, (_, i) => record({ id: `pre${i}`, ts: NOON })) });
      const result = await reserveEscalation(dir, NOON, 'critical', pendingRecord({ id: 'over-cap' }));
      expect(result.allowed).toBe(false);
      expect(loadEscalations(dir).escalations).toHaveLength(DAILY_CAP); // 'over-cap' never written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONCURRENT reserves enforce the daily cap exactly, with no lost records (the core fix-round bug)', async () => {
    const dir = freshDataDir();
    try {
      const N = DAILY_CAP + 2; // exact shape of the empirical repro: DAILY_CAP+2 concurrent callers
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => reserveEscalation(dir, NOON, 'critical', pendingRecord({ id: `r${i}` })))
      );

      // Pre-fix: every one of these would be { allowed: true } — all N
      // callers loaded the same empty pre-save state.
      expect(results.filter((r) => r.allowed)).toHaveLength(DAILY_CAP);
      expect(results.filter((r) => !r.allowed)).toHaveLength(N - DAILY_CAP);

      // Pre-fix: only 1 record would survive (lost update — last save wins).
      const state = loadEscalations(dir);
      expect(state.escalations).toHaveLength(DAILY_CAP);
      expect(new Set(state.escalations.map((r) => r.id)).size).toBe(DAILY_CAP); // no id collisions/overwrites
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizeEscalationOutcome replaces only its own record\'s smsOutcome, even with another reserve landing in between', async () => {
    const dir = freshDataDir();
    try {
      const a = pendingRecord({ id: 'a' });
      await reserveEscalation(dir, NOON, 'critical', a);

      // A second caller's reservation and this caller's finalize, both
      // in flight at once (neither awaited before the other starts) —
      // regardless of which runs first through the lock, neither may
      // clobber the other's write.
      const b = pendingRecord({ id: 'b', ts: NOON + 1 });
      const reserveB = reserveEscalation(dir, NOON + 1, 'critical', b);
      const finalizeA = finalizeEscalationOutcome(dir, 'a', 'sent');
      await Promise.all([reserveB, finalizeA]);

      const state = loadEscalations(dir);
      expect(state.escalations).toHaveLength(2);
      expect(state.escalations.find((r) => r.id === 'a')?.smsOutcome).toBe('sent');
      expect(state.escalations.find((r) => r.id === 'b')?.smsOutcome).toBe('pending');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizeEscalationOutcome is a safe no-op if the id is no longer present', async () => {
    const dir = freshDataDir();
    try {
      await expect(finalizeEscalationOutcome(dir, 'does-not-exist', 'sent')).resolves.toBeUndefined();
      expect(loadEscalations(dir).escalations).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
