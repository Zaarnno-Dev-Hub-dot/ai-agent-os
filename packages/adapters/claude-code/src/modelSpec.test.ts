import { describe, expect, it } from 'vitest';
import { CLAUDE_EFFORTS, parseModelSpec } from './cliProcess.js';

/**
 * Composite 'model:effort' support (2026-08-08) — the mechanism that lets the
 * dash's single model picker also set the Opus seat's reasoning effort.
 */
describe('parseModelSpec', () => {
  it('splits every CLI effort value out of a composite', () => {
    for (const effort of CLAUDE_EFFORTS) {
      expect(parseModelSpec(`claude-opus-5:${effort}`)).toEqual({
        model: 'claude-opus-5',
        effort,
      });
    }
  });

  it('leaves every existing bare pin untouched (no behavior change for old seats)', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5-20251001']) {
      expect(parseModelSpec(id)).toEqual({ model: id });
    }
  });

  it('does not treat an unknown suffix as effort', () => {
    expect(parseModelSpec('claude-opus-5:turbo')).toEqual({ model: 'claude-opus-5:turbo' });
  });

  it('returns empty for undefined/blank', () => {
    expect(parseModelSpec(undefined)).toEqual({});
    expect(parseModelSpec('  ')).toEqual({});
  });
});
