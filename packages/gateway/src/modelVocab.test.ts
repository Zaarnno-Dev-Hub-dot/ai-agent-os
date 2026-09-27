import { describe, expect, it } from 'vitest';
import { isAllowedModel, MODEL_VOCAB } from './modelVocab.js';

// ============================================================================
// grok-build vocabulary (Wave 5 — two permanent Grok seats)
// ============================================================================

describe('MODEL_VOCAB — grok-build', () => {
  it('lists both real grok-build model ids (verified live via `grok models`, CLI 0.2.91)', () => {
    expect(MODEL_VOCAB['grok-build']).toEqual(['grok-composer-2.5-fast', 'grok-4.5']);
  });

  it('no longer lists the bogus "grok-build" placeholder id that predated live verification', () => {
    expect(MODEL_VOCAB['grok-build']).not.toContain('grok-build');
  });
});

describe('isAllowedModel — grok-build', () => {
  it('allows grok-composer-2.5-fast (the grok-build main seat pin)', () => {
    expect(isAllowedModel('grok-build', 'grok-composer-2.5-fast')).toBe(true);
  });

  it('allows grok-4.5 (the grok-build#fast seat pin)', () => {
    expect(isAllowedModel('grok-build', 'grok-4.5')).toBe(true);
  });

  it('applies the SAME manifest-level vocabulary to a #instance seat id — the check is keyed by manifestId, not seatId', () => {
    // Callers pass state.manifest.id (the manifest, e.g. 'grok-build'), never
    // the seat id ('grok-build#fast') — this test pins that contract so a
    // future caller mistake (checking against the seat id) fails loudly.
    expect(isAllowedModel('grok-build', 'grok-4.5')).toBe(true);
    expect(isAllowedModel('grok-build#fast', 'grok-4.5')).toBe(false);
  });

  it('rejects an unknown grok model id', () => {
    expect(isAllowedModel('grok-build', 'grok-3-mini')).toBe(false);
  });

  it('rejects a leading-dash value even if paired with a known manifest (CLI-arg-injection defense)', () => {
    expect(isAllowedModel('grok-build', '--dangerous-flag')).toBe(false);
  });
});

// ============================================================================
// claude-code vocabulary (pre-existing — regression coverage for the refactor
// out of index.ts's inline literal)
// ============================================================================

describe('isAllowedModel — claude-code', () => {
  it('allows every documented claude-code model id', () => {
    expect(isAllowedModel('claude-code', 'claude-opus-4-8')).toBe(true);
    expect(isAllowedModel('claude-code', 'claude-sonnet-5')).toBe(true);
    expect(isAllowedModel('claude-code', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(isAllowedModel('claude-code', 'claude-fable-5')).toBe(true);
  });

  it('rejects an unknown claude-code model id', () => {
    expect(isAllowedModel('claude-code', 'claude-opus-3')).toBe(false);
  });
});

// ============================================================================
// Fixed-model harnesses (no configurable model)
// ============================================================================

describe('isAllowedModel — harnesses with no writable model field', () => {
  it('rejects any value for a manifest with no vocab entry (hermes, openclaw)', () => {
    expect(isAllowedModel('hermes', 'anything')).toBe(false);
    expect(isAllowedModel('openclaw', 'anything')).toBe(false);
  });

  it('rejects an empty model string', () => {
    expect(isAllowedModel('grok-build', '')).toBe(false);
  });
});
