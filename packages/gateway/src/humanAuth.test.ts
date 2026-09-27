import { describe, expect, it } from 'vitest';
import { mintHumanToken, isValidHumanToken } from './humanAuth.js';

describe('mintHumanToken', () => {
  it('mints a non-empty hex string, different every call', () => {
    const a = mintHumanToken();
    const b = mintHumanToken();
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });
});

describe('isValidHumanToken', () => {
  const expected = mintHumanToken();

  it('accepts the exact correct token', () => {
    expect(isValidHumanToken(expected, expected)).toBe(true);
  });

  it('rejects undefined (the "caller never sent one" shape)', () => {
    expect(isValidHumanToken(expected, undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidHumanToken(expected, null)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidHumanToken(expected, '')).toBe(false);
  });

  it('rejects a same-length-but-wrong value', () => {
    const wrong = 'f'.repeat(expected.length);
    expect(isValidHumanToken(expected, wrong)).toBe(false);
  });

  it('rejects a shorter value', () => {
    expect(isValidHumanToken(expected, expected.slice(0, expected.length - 4))).toBe(false);
  });

  it('rejects a longer value (prefix match should not pass)', () => {
    expect(isValidHumanToken(expected, `${expected}extra`)).toBe(false);
  });

  it('rejects a non-string value (number)', () => {
    expect(isValidHumanToken(expected, 123456 as unknown as string)).toBe(false);
  });

  it('rejects a non-string value (object)', () => {
    expect(isValidHumanToken(expected, { token: expected } as unknown as string)).toBe(false);
  });

  it('rejects a non-string value (array)', () => {
    expect(isValidHumanToken(expected, [expected] as unknown as string)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isValidHumanToken(expected, expected.toUpperCase())).toBe(expected === expected.toUpperCase());
  });
});
