import { describe, expect, it } from 'vitest';
import { isActionCovered } from './reviewPolicy';

// Mirrors packages/gateway/src/reviewPolicy.test.ts's `describe('isActionCovered', ...)`
// block byte-for-byte (same truth table, same three modes) — this copy exists
// because `isActionCovered` itself is duplicated into the UI package (see
// reviewPolicy.ts's comment: gateway is a Node/fs-importing package the
// browser bundle can't import). Added in the M3 fix cycle (2026-07-09) as
// part of fixing needsZeroVerdictConfirm's missing coverage check
// (pollPresent.ts / pollPresent.test.ts).
describe('isActionCovered', () => {
  it('off covers nothing', () => {
    expect(isActionCovered('off', 'workshop-propose')).toBe(false);
    expect(isActionCovered('off', 'seat-attachment-or-diff')).toBe(false);
  });
  it('mutations covers only workshop-propose', () => {
    expect(isActionCovered('mutations', 'workshop-propose')).toBe(true);
    expect(isActionCovered('mutations', 'seat-attachment-or-diff')).toBe(false);
  });
  it('all covers everything', () => {
    expect(isActionCovered('all', 'workshop-propose')).toBe(true);
    expect(isActionCovered('all', 'seat-attachment-or-diff')).toBe(true);
  });
});
