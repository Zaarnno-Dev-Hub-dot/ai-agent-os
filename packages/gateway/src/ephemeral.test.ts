import { describe, expect, it } from 'vitest';
import { EphemeralPresenceRegistry, MAX_TTL_MS, MIN_TTL_MS } from './ephemeral.js';

/** Simple controllable clock — advance() moves time forward without any real sleep. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('EphemeralPresenceRegistry', () => {
  it('announce() stores the entry with expiresAt = now + ttlMs', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    const stored = reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 5_000);
    expect(stored.id).toBe('a');
    expect(stored.startedAt).toBe(1_000_000);
    expect(stored.expiresAt).toBe(1_005_000);
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]).toMatchObject({ id: 'a', label: 'job-a', kind: 'temp' });
  });

  it('re-announcing the same id preserves the original startedAt but refreshes expiresAt', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 5_000);
    clock.advance(2_000);
    const second = reg.announce({ id: 'a', label: 'job-a (renamed)', kind: 'temp' }, 5_000);
    expect(second.startedAt).toBe(1_000_000); // unchanged
    expect(second.expiresAt).toBe(1_002_000 + 5_000);
    expect(reg.list()).toHaveLength(1); // still one entry, not two
    expect(reg.list()[0].label).toBe('job-a (renamed)');
  });

  it('TTL expiry: an entry disappears from list() once past its expiresAt', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 5_000);
    clock.advance(4_999);
    expect(reg.list()).toHaveLength(1);
    clock.advance(2); // now past expiresAt
    expect(reg.list()).toHaveLength(0);
  });

  it('clamping: ttlMs above MAX_TTL_MS is clamped down, so a bad caller cannot pin an entry forever', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    const stored = reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, MAX_TTL_MS * 100);
    expect(stored.expiresAt).toBe(1_000_000 + MAX_TTL_MS);
  });

  it('clamping: a zero/negative/NaN ttlMs is floored to MIN_TTL_MS rather than expiring instantly', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    expect(reg.announce({ id: 'a', label: 'a', kind: 'temp' }, 0).expiresAt).toBe(1_000_000 + MIN_TTL_MS);
    expect(reg.announce({ id: 'b', label: 'b', kind: 'temp' }, -500).expiresAt).toBe(1_000_000 + MIN_TTL_MS);
    expect(reg.announce({ id: 'c', label: 'c', kind: 'temp' }, NaN).expiresAt).toBe(1_000_000 + MIN_TTL_MS);
  });

  it('clear() removes immediately and returns true; clearing an unknown id returns false', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 5_000);
    expect(reg.clear('a')).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(reg.clear('a')).toBe(false);
    expect(reg.clear('never-existed')).toBe(false);
  });

  it('sweep() reports changed=true when it actually removes an expired entry, and drops it', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 1_000);
    clock.advance(1_001);
    expect(reg.sweep()).toBe(true);
    expect(reg.size()).toBe(0);
  });

  it('sweep() reports changed=false on a no-op sweep (nothing expired) — this is the broadcast-storm guard', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 5_000);
    reg.announce({ id: 'b', label: 'job-b', kind: 'temp' }, 5_000);
    // Neither entry has expired yet.
    expect(reg.sweep()).toBe(false);
    expect(reg.size()).toBe(2);
    // An empty registry swept repeatedly must also report false, every time —
    // a periodic timer calling sweep() every 5s on an empty/idle registry
    // must never itself trigger a broadcast.
    const empty = new EphemeralPresenceRegistry(clock.now);
    expect(empty.sweep()).toBe(false);
    expect(empty.sweep()).toBe(false);
  });

  it('sweep() with a mix of expired and live entries removes only the expired ones and reports changed', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'expires-soon', label: 'a', kind: 'temp' }, 1_000);
    reg.announce({ id: 'lives-on', label: 'b', kind: 'temp' }, 10_000);
    clock.advance(1_001);
    expect(reg.sweep()).toBe(true);
    const remaining = reg.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('lives-on');
  });

  it('list() never returns an already-expired entry even without an explicit sweep() call first', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce({ id: 'a', label: 'job-a', kind: 'temp' }, 1_000);
    clock.advance(5_000); // well past expiry, sweep() never called
    expect(reg.list()).toHaveLength(0);
    expect(reg.size()).toBe(1); // still physically present until swept
  });

  it('carries optional meta through announce -> list untouched', () => {
    const clock = fakeClock();
    const reg = new EphemeralPresenceRegistry(clock.now);
    reg.announce(
      { id: 'a', label: 'printify-daily', kind: 'temp', meta: { role: 'data-cleaner', jobSlug: 'printify-daily', tempId: 'printify-daily-20260802-abcd' } },
      5_000
    );
    expect(reg.list()[0].meta).toEqual({
      role: 'data-cleaner',
      jobSlug: 'printify-daily',
      tempId: 'printify-daily-20260802-abcd',
    });
  });
});
