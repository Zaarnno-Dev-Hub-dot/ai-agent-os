import { useEffect, useRef } from 'react';
import { PICKER_EMOJI } from '../lib/emoji';

/**
 * Dismissal is click-outside / Escape / pick — NEVER mouse-leave. The picker
 * can render overlapping the pointer, so a hover-out close dismissed it on
 * the first mouse move (live complaint, 2026-07-06). Trigger buttons carry
 * data-emoji-trigger so their own onClick keeps toggle semantics instead of
 * fighting the outside-click listener (close-then-reopen flicker).
 */
export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target.closest('[data-emoji-trigger]')) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref}>
      {PICKER_EMOJI.map((e) => (
        <button
          key={e}
          type="button"
          className="emoji-picker-item"
          onClick={() => {
            onPick(e);
          }}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
