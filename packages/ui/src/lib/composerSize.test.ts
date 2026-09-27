import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_MAX_AUTO_HEIGHT_PX,
  COMPOSER_MAX_MANUAL_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  computeAutoGrowHeight,
  computeDragHeight,
  heightForLines,
  loadManualHeight,
  resolveComposerHeight,
  saveManualHeight,
} from './composerSize';
import { MemoryStorage } from './speechFakes';

describe('heightForLines / band constants', () => {
  it('grows linearly with line count', () => {
    expect(heightForLines(2)).toBeGreaterThan(heightForLines(1));
    expect(heightForLines(4)).toBe(COMPOSER_MAX_AUTO_HEIGHT_PX);
    expect(heightForLines(1)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('min height is below max auto height, which is below the manual ceiling', () => {
    expect(COMPOSER_MIN_HEIGHT_PX).toBeLessThan(COMPOSER_MAX_AUTO_HEIGHT_PX);
    expect(COMPOSER_MAX_AUTO_HEIGHT_PX).toBeLessThan(COMPOSER_MAX_MANUAL_HEIGHT_PX);
  });
});

describe('computeAutoGrowHeight', () => {
  it('floors content shorter than one line at the minimum height', () => {
    expect(computeAutoGrowHeight(0)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(computeAutoGrowHeight(10)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('follows scrollHeight in between the band', () => {
    const mid = (COMPOSER_MIN_HEIGHT_PX + COMPOSER_MAX_AUTO_HEIGHT_PX) / 2;
    expect(computeAutoGrowHeight(mid)).toBe(mid);
  });

  it('caps content beyond ~4 lines at the auto-grow ceiling (overflow scrolls instead)', () => {
    expect(computeAutoGrowHeight(10000)).toBe(COMPOSER_MAX_AUTO_HEIGHT_PX);
  });

  it('respects custom min/max bounds when passed explicitly', () => {
    expect(computeAutoGrowHeight(5, 20, 100)).toBe(20);
    expect(computeAutoGrowHeight(50, 20, 100)).toBe(50);
    expect(computeAutoGrowHeight(500, 20, 100)).toBe(100);
  });
});

describe('computeDragHeight', () => {
  it('dragging the top edge UP (clientY decreases) grows the box', () => {
    const startHeight = 100;
    const startY = 500;
    const draggedUpY = 460; // moved up 40px
    expect(computeDragHeight(startHeight, startY, draggedUpY)).toBe(140);
  });

  it('dragging the top edge DOWN (clientY increases) shrinks the box', () => {
    const startHeight = 100;
    const startY = 500;
    const draggedDownY = 530; // moved down 30px
    expect(computeDragHeight(startHeight, startY, draggedDownY)).toBe(70);
  });

  it('clamps growth at the hard manual ceiling', () => {
    const result = computeDragHeight(100, 1000, -100000);
    expect(result).toBe(COMPOSER_MAX_MANUAL_HEIGHT_PX);
  });

  it('clamps shrink at the minimum height (never below one line)', () => {
    const result = computeDragHeight(100, 500, 100000);
    expect(result).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('no movement returns the start height unchanged', () => {
    expect(computeDragHeight(77, 300, 300)).toBe(77);
  });

  it('respects custom min/max bounds when passed explicitly', () => {
    expect(computeDragHeight(50, 500, 100, 10, 60)).toBe(60); // dragged up 400px, capped at 60
    expect(computeDragHeight(50, 500, 900, 10, 60)).toBe(10); // dragged down 400px, floored at 10
  });
});

describe('resolveComposerHeight (manual precedence over auto)', () => {
  it('uses autoHeight when no manual height is set', () => {
    expect(resolveComposerHeight(null, 88)).toBe(88);
  });

  it('uses manualHeight when set, ignoring autoHeight entirely', () => {
    expect(resolveComposerHeight(250, 88)).toBe(250);
    expect(resolveComposerHeight(250, 400)).toBe(250);
  });

  it('a manual height of 0 is falsy but must NOT fall back to auto (nullish, not falsy, coalescing)', () => {
    // Guards the ?? vs || choice in the implementation: 0 is a degenerate
    // but technically valid manual height and should never be silently
    // reinterpreted as "unset".
    expect(resolveComposerHeight(0, 88)).toBe(0);
  });
});

describe('localStorage persistence (same defensive pattern as lib/voice.ts)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('returns null when nothing has been saved yet', () => {
    expect(loadManualHeight()).toBeNull();
  });

  it('round-trips a saved manual height', () => {
    saveManualHeight(220);
    expect(loadManualHeight()).toBe(220);
  });

  it('clears the persisted value when saving null (the reset-to-auto path)', () => {
    saveManualHeight(220);
    expect(loadManualHeight()).toBe(220);
    saveManualHeight(null);
    expect(loadManualHeight()).toBeNull();
  });

  it('falls back to null on corrupt/non-numeric stored data instead of throwing', () => {
    localStorage.setItem('agent-os:composer:manual-height', 'not-a-number');
    expect(() => loadManualHeight()).not.toThrow();
    expect(loadManualHeight()).toBeNull();
  });

  it('falls back to null on a non-positive stored value (defends against a corrupted/tampered 0 or negative)', () => {
    localStorage.setItem('agent-os:composer:manual-height', '0');
    expect(loadManualHeight()).toBeNull();
    localStorage.setItem('agent-os:composer:manual-height', '-40');
    expect(loadManualHeight()).toBeNull();
  });

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveManualHeight(200)).not.toThrow();
    expect(() => loadManualHeight()).not.toThrow();
    expect(loadManualHeight()).toBeNull();
  });
});
