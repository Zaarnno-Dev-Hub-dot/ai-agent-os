/**
 * Composer auto-grow + manual resize (docs/TECH-DEBT.md Wave 7 queue,
 * : the textarea auto-expands with content from 1 to ~4
 * lines, then holds a fixed height with an internal scrollbar. A custom
 * TOP-EDGE drag handle (wired in Composer.tsx) lets the operator manually enlarge
 * it further — the composer is bottom-anchored, so a native bottom-right
 * resize handle would drag the wrong direction (it moves the box instead of
 * just resizing it). Manual size takes precedence over auto-grow until
 * reset (double-click the handle).
 *
 * Every function here is pure and DOM-free on purpose — this repo has no
 * jsdom/RTL (deliberate, see vitest.config.ts), so all the height/
 * precedence/persistence math lives here and is unit-tested directly;
 * Composer.tsx's job is only to read scrollHeight/clientY off the real
 * textarea and call these.
 */

// ============================================================================
// Sizing constants
// ============================================================================

/** Line-height and vertical padding baked into `.cinput`/`.cinput-textarea`
 *  in index.css (font-size 14px, line-height 1.4, padding 8px top + 8px
 *  bottom). Kept here as constants (not re-derived from getComputedStyle at
 *  runtime) so the min/max heights are deterministic and unit-testable — if
 *  index.css's metrics ever change, update these two numbers to match. */
export const COMPOSER_LINE_HEIGHT_PX = 19.6; // 14px * line-height 1.4
export const COMPOSER_VERTICAL_PADDING_PX = 16; // 8px top + 8px bottom

export const COMPOSER_MIN_LINES = 1;
export const COMPOSER_MAX_AUTO_LINES = 4;

/** Hard ceiling for MANUAL drag-resize. Auto-grow never exceeds
 *  COMPOSER_MAX_AUTO_LINES worth of px regardless of this constant — this
 *  only bounds how far a manual drag can enlarge the box, so a runaway drag
 *  (or a corrupt/tampered localStorage value) can't swallow the viewport. */
export const COMPOSER_MAX_MANUAL_HEIGHT_PX = 480;

/** Height in px for a given number of lines, per the metrics above. */
export function heightForLines(lines: number): number {
  return lines * COMPOSER_LINE_HEIGHT_PX + COMPOSER_VERTICAL_PADDING_PX;
}

export const COMPOSER_MIN_HEIGHT_PX = heightForLines(COMPOSER_MIN_LINES);
export const COMPOSER_MAX_AUTO_HEIGHT_PX = heightForLines(COMPOSER_MAX_AUTO_LINES);

// ============================================================================
// Auto-grow
// ============================================================================

/**
 * Clamps a textarea's natural content height to the auto-grow band [1 line,
 * ~4 lines]. `scrollHeight` is expected to have been measured by the caller
 * AFTER resetting the element's inline height to 'auto' (so it can shrink
 * back down too, not just grow — scrollHeight of a fixed-height element
 * reports the fixed height, not the content's natural height). Above the
 * ceiling the textarea holds at COMPOSER_MAX_AUTO_HEIGHT_PX and the caller's
 * CSS `overflow-y: auto` takes over for the rest.
 */
export function computeAutoGrowHeight(
  scrollHeight: number,
  minHeight: number = COMPOSER_MIN_HEIGHT_PX,
  maxHeight: number = COMPOSER_MAX_AUTO_HEIGHT_PX
): number {
  return Math.min(Math.max(scrollHeight, minHeight), maxHeight);
}

// ============================================================================
// Manual drag-resize
// ============================================================================

/**
 * Height for an in-progress top-edge drag. The composer is bottom-anchored,
 * so dragging the TOP edge UP (`clientY` decreasing) must GROW the box and
 * dragging it DOWN must shrink it — inverted from a normal bottom-right
 * handle, hence `startClientY - currentClientY` rather than the reverse.
 * Clamped to [minHeight, maxHeight] so a drag can't shrink below one line or
 * grow past the hard ceiling.
 */
export function computeDragHeight(
  startHeight: number,
  startClientY: number,
  currentClientY: number,
  minHeight: number = COMPOSER_MIN_HEIGHT_PX,
  maxHeight: number = COMPOSER_MAX_MANUAL_HEIGHT_PX
): number {
  const delta = startClientY - currentClientY;
  return Math.min(Math.max(startHeight + delta, minHeight), maxHeight);
}

// ============================================================================
// Precedence: manual size wins over auto-grow until reset
// ============================================================================

/**
 * The height the textarea should actually render at. A manually-set height
 * (live drag, or restored from localStorage) takes precedence over
 * auto-grow entirely — content changes don't resize the box back down while
 * a manual height is active. `null` means "auto": never manually resized,
 * or reset via double-click on the handle.
 */
export function resolveComposerHeight(manualHeightPx: number | null, autoHeightPx: number): number {
  return manualHeightPx ?? autoHeightPx;
}

// ============================================================================
// localStorage persistence — same defensive pattern as lib/voice.ts: every
// read/write is guarded so a broken/disabled localStorage degrades to
// "manual height not persisted" rather than a crash.
// ============================================================================

const MANUAL_HEIGHT_KEY = 'agent-os:composer:manual-height';

function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Some browsers throw on *accessing* localStorage in certain private-
    // browsing modes, not just on read/write.
    return null;
  }
}

/**
 * Returns the persisted manual height, or null when there is none (never
 * manually resized, storage unavailable, corrupt/non-positive stored value,
 * or a reset cleared it). null is also the auto-grow signal
 * `resolveComposerHeight` expects, so callers can pass this straight
 * through without an extra "was it ever set" check.
 */
export function loadManualHeight(): number | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(MANUAL_HEIGHT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persists a manual height, or clears it when `height` is null (the
 * reset-to-auto path — double-click the handle) so a later session also
 * starts back at auto instead of restoring a stale manual size.
 */
export function saveManualHeight(height: number | null): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    if (height === null) {
      storage.removeItem(MANUAL_HEIGHT_KEY);
    } else {
      storage.setItem(MANUAL_HEIGHT_KEY, String(height));
    }
  } catch {
    /* quota / private-browsing write rejection — setting still applies in-memory for this session */
  }
}
