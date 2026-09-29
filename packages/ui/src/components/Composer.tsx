import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AttachmentRef, OutboundMessage, Room } from '@agent-os/shared';
import { useStore } from '../store/gatewayStore';
import { useVoiceStore } from '../store/voiceStore';
import {
  applyDictationFinal,
  applyDictationInterim,
  createRecognition,
  dictationSessionValue,
  isDictationSupported,
  reanchorDictationSession,
  startDictationSession,
  type DictationSession,
  type SpeechRecognitionLike,
} from '../lib/voice';
import {
  COMPOSER_MIN_HEIGHT_PX,
  computeAutoGrowHeight,
  computeDragHeight,
  loadManualHeight,
  resolveComposerHeight,
  saveManualHeight,
} from '../lib/composerSize';
import { uploadFile } from '../lib/attachments';
import { extractMentions } from '../lib/mentions';
import { renderMarkdown } from '../lib/markdown';
import { EmojiPicker } from './EmojiPicker';
import { MentionAutocomplete, agentsToMentionCandidates } from './MentionAutocomplete';
import { PendingAttachmentChip } from './Attachment';

interface PendingUpload {
  localId: string;
  file: File;
  attachment?: AttachmentRef;
  uploading: boolean;
  error?: string;
}

export function Composer({ room }: { room: Room | undefined }) {
  const { agents, sendClientEvent } = useStore();
  const [value, setValue] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Composer auto-grow + manual resize: see lib/composerSize.ts for the full
  // design note.
  // `autoHeight` tracks the content-driven height (recomputed below whenever
  // `value` changes); `manualHeight` is null until the user drags the
  // top-edge handle, at which point it takes precedence over `autoHeight`
  // until reset (double-click). Lazy-initialized from localStorage so a
  // previously-set manual size survives a reload.
  const [autoHeight, setAutoHeight] = useState(COMPOSER_MIN_HEIGHT_PX);
  const [manualHeight, setManualHeight] = useState<number | null>(() => loadManualHeight());
  const composerHeight = resolveComposerHeight(manualHeight, autoHeight);

  // Voice v1: push-to-talk dictation. Click-to-
  // toggle —
  // simpler and more reliable across pointer/touch input than hold-to-record.
  // Recognized text is only ever written into `value` below — never sent.
  const [dictating, setDictating] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Single ref holding the whole dictation session (base/committed/interim/
  // skipNextFinal) — see DictationSession's doc comment in lib/voice.ts for
  // why this is centralized instead of several independently-updated refs:
  // every path that can touch the composer mid-dictation (typed edit, emoji
  // pick, @mention insert, send) re-anchors through the same helper below.
  const dictationRef = useRef<DictationSession>(startDictationSession(''));
  const micPermissionDenied = useVoiceStore((s) => s.micPermissionDenied);
  const setMicPermissionDenied = useVoiceStore((s) => s.setMicPermissionDenied);
  const dictationSupported = isDictationSupported();

  const mentionCandidates = agentsToMentionCandidates(agents);

  const disabled = !room;

  // Belt-and-suspenders: stop a live mic session if this component ever
  // unmounts mid-dictation.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  // Re-measure the auto-grow height whenever the content changes (typing,
  // dictation, emoji pick, @mention insert, post-send clear — every path
  // that can change `value`). Runs even while a manual height is active: the
  // moment the user double-clicks back to auto (handleResizeReset below),
  // `autoHeight` needs to already be correct for the CURRENT content, not
  // stale from whatever it was when manual resize started.
  //
  // Height is reset to 'auto' before reading `scrollHeight` because a
  // textarea whose inline height is already fixed reports THAT height as
  // scrollHeight, not the content's natural height — without this, the box
  // could grow but never shrink back down as text is deleted.
  // useLayoutEffect (not useEffect) so this measure-then-set happens before
  // the browser paints — no visible flash of the wrong height.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const previousInlineHeight = el.style.height;
    el.style.height = 'auto';
    const measured = computeAutoGrowHeight(el.scrollHeight);
    el.style.height = previousInlineHeight;
    setAutoHeight(measured);
  }, [value]);

  // Drag-resize: custom TOP-EDGE handle (native bottom-right resize would
  // drag the wrong direction on this bottom-anchored composer — see
  // lib/composerSize.ts). Plain window mousemove/mouseup listeners (not
  // React handlers) so the drag keeps tracking even if the cursor leaves the
  // thin handle strip mid-drag.
  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const startHeight = composerHeight;
    const startClientY = e.clientY;
    let latestHeight = startHeight;

    function onMove(moveEvent: MouseEvent) {
      latestHeight = computeDragHeight(startHeight, startClientY, moveEvent.clientY);
      setManualHeight(latestHeight);
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Persist only on release, not on every drag-move tick — avoids a
      // localStorage write per mousemove event.
      saveManualHeight(latestHeight);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Double-click the handle: drop the manual override and go back to
  // auto-grow. Clears the
  // persisted value too, so a reload doesn't resurrect the old manual size.
  function handleResizeReset() {
    setManualHeight(null);
    saveManualHeight(null);
  }

  function appendDictated(text: string, isFinal: boolean) {
    dictationRef.current = isFinal
      ? applyDictationFinal(dictationRef.current, text)
      : applyDictationInterim(dictationRef.current, text);
    // Safe to call unconditionally, including when applyDictationFinal/
    // applyDictationInterim suppressed the event (skipNextFinal path): the
    // resulting session's value is then byte-identical to what's already
    // shown, so React bails on the state update — no extra render, and
    // never a visible flash of the dropped/suppressed text.
    setValue(dictationSessionValue(dictationRef.current));
  }

  function toggleDictation() {
    if (micPermissionDenied) return;
    if (dictating) {
      recognitionRef.current?.stop();
      // setDictating(false) happens in onEnd below, once the engine actually
      // stops — stop() is async, so this stays truthful to what's listening.
      return;
    }
    dictationRef.current = startDictationSession(value);
    const recognition = createRecognition({
      onInterim: (text) => appendDictated(text, false),
      onFinal: (text) => appendDictated(text, true),
      onError: (error) => {
        if (error === 'not-allowed' || error === 'service-not-allowed') {
          setMicPermissionDenied(true);
        }
        setDictating(false);
        recognitionRef.current = null;
      },
      onEnd: () => {
        setDictating(false);
        recognitionRef.current = null;
      },
    });
    if (!recognition) return; // defensive — the mic button is hidden when unsupported
    recognitionRef.current = recognition;
    setDictating(true);
    recognition.start();
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const file of list) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPending((p) => [...p, { localId, file, uploading: true }]);
      try {
        const attachment = await uploadFile(file);
        setPending((p) =>
          p.map((item) => (item.localId === localId ? { ...item, attachment, uploading: false } : item))
        );
      } catch (e) {
        setPending((p) =>
          p.map((item) =>
            item.localId === localId
              ? { ...item, uploading: false, error: e instanceof Error ? e.message : String(e) }
              : item
          )
        );
      }
    }
  }

  function removePending(localId: string) {
    setPending((p) => p.filter((item) => item.localId !== localId));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  }

  function updateMentionState(text: string, caret: number) {
    const upToCaret = text.slice(0, caret);
    // '#' is included so typing a multi-instance seat id keeps the autocomplete popup
    // open through the '#' instead of it terminating the mention query.
    const match = /@([a-z0-9_#-]*)$/i.exec(upToCaret);
    if (match) {
      setMentionQuery({ query: match[1], start: caret - match[0].length });
      setMentionActiveIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    if (dictating) {
      // Fix (review 2026-07-09, round 2): re-anchor dictation to this hand
      // edit so the next SpeechRecognition event appends after it instead of
      // clobbering it — see reanchorDictationSession's doc comment in
      // lib/voice.ts. onChange only fires on real user input, never on
      // dictation's own programmatic setValue calls, so this can't mistake
      // dictation for a manual edit.
      dictationRef.current = reanchorDictationSession(dictationRef.current, next);
    }
    updateMentionState(next, e.target.selectionStart ?? next.length);
  }

  function pickMention(id: string) {
    if (!mentionQuery || !textareaRef.current) return;
    const before = value.slice(0, mentionQuery.start);
    const after = value.slice(textareaRef.current.selectionStart ?? value.length);
    const next = `${before}@${id} ${after}`;
    setValue(next);
    if (dictating) {
      // Fix (review 2026-07-09, round 2): re-anchor so the inserted mention
      // survives dictation's next SpeechRecognition event instead of being
      // clobbered by it.
      dictationRef.current = reanchorDictationSession(dictationRef.current, next);
    }
    setMentionQuery(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handleSend() {
    const content = value.trim();
    const attachments = pending.filter((p) => p.attachment).map((p) => p.attachment!) as AttachmentRef[];
    if ((!content && attachments.length === 0) || !room) return;

    const mentions = extractMentions(content, agents);
    const message: OutboundMessage = {
      role: 'user',
      senderId: 'human',
      senderName: 'You',
      content,
      mentions,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    const sent = sendClientEvent({ type: 'chat.send', payload: { roomId: room.id, message } });
    if (!sent) {
      // Socket is down (gateway restart, network); keep the draft — the top
      // bar shows "Gateway offline" and the connection hook is reconnecting.
      return;
    }
    setValue('');
    if (dictating) {
      // Fix (review 2026-07-09, round 2): re-anchor to the now-empty
      // composer so a final still in flight for the just-sent phrase can't
      // resurrect the already-sent text — the next phrase starts a fresh
      // draft.
      dictationRef.current = reanchorDictationSession(dictationRef.current, '');
    }
    setPending([]);
    setPreviewMode(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery) {
      const filtered = mentionCandidates.filter(
        (c) =>
          c.displayName.toLowerCase().includes(mentionQuery.query.toLowerCase()) ||
          c.id.toLowerCase().includes(mentionQuery.query.toLowerCase())
      );
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filtered[mentionActiveIndex]) {
        e.preventDefault();
        pickMention(filtered[mentionActiveIndex].id);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const anyUploading = pending.some((p) => p.uploading);
  const canSend = (value.trim().length > 0 || pending.some((p) => p.attachment)) && !anyUploading && !!room;

  return (
    <div className="composer-wrap" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      {pending.length > 0 && (
        <div className="pending-attachments">
          {pending.map((p) => (
            <PendingAttachmentChip
              key={p.localId}
              filename={p.file.name}
              size={p.file.size}
              uploading={p.uploading}
              onRemove={() => removePending(p.localId)}
            />
          ))}
        </div>
      )}

      {previewMode ? (
        <div
          className="composer-preview"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(value || '*Nothing to preview*') }}
        />
      ) : null}

      {micPermissionDenied && (
        <div className="mic-denied-hint">Mic permission denied — dictation disabled for this session.</div>
      )}

      {!previewMode && (
        <div
          className="composer-resize-handle"
          title="Drag to resize — double-click to reset"
          onMouseDown={handleResizeStart}
          onDoubleClick={handleResizeReset}
        />
      )}

      <div className="composer" style={{ display: previewMode ? 'none' : 'flex' }}>
        <label className="cbtn" title="Attach file">
          📎
          <input
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && void addFiles(e.target.files)}
          />
        </label>
        <div style={{ position: 'relative', flex: 1 }}>
          <textarea
            ref={textareaRef}
            className="cinput cinput-textarea"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              room ? `Message #${room.name} — @mention an agent, drop files, or paste images…` : 'Select a room to chat'
            }
            disabled={disabled}
            rows={1}
            style={{ height: `${composerHeight}px` }}
          />
          {mentionQuery && (
            <MentionAutocomplete
              candidates={mentionCandidates}
              query={mentionQuery.query}
              activeIndex={mentionActiveIndex}
              onPick={(c) => pickMention(c.id)}
            />
          )}
        </div>
        <button
          type="button"
          className="cbtn"
          title="Toggle markdown preview"
          onClick={() => setPreviewMode((v) => !v)}
        >
          👁
        </button>
        <div style={{ position: 'relative' }}>
          <button type="button" className="cbtn" title="Emoji" data-emoji-trigger onClick={() => setEmojiOpen((v) => !v)}>
            😊
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(emoji) => {
                const next = value + emoji;
                setValue(next);
                if (dictating) {
                  // Fix (review 2026-07-09, round 2): re-anchor so the
                  // picked emoji survives dictation's next SpeechRecognition
                  // event instead of being clobbered by it. Computed `next`
                  // explicitly (rather than the updater-form `setValue((v)
                  // => v + emoji)` this used before) so the re-anchor uses
                  // the exact same post-mutation string that was painted.
                  dictationRef.current = reanchorDictationSession(dictationRef.current, next);
                }
                setEmojiOpen(false);
                textareaRef.current?.focus();
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>
        {dictationSupported && (
          <button
            type="button"
            className={`cbtn${dictating ? ' mic-active' : ''}`}
            title={
              micPermissionDenied ? 'Mic permission denied' : dictating ? 'Stop dictation' : 'Dictate into composer'
            }
            disabled={disabled || micPermissionDenied}
            onClick={toggleDictation}
          >
            🎙
          </button>
        )}
        <button className="send" onClick={handleSend} disabled={!canSend} title="Send (Enter)">
          ➤
        </button>
      </div>

      {previewMode && (
        <div className="composer-preview-actions">
          <button className="cbtn" onClick={() => setPreviewMode(false)}>
            Back to edit
          </button>
          <button className="send" onClick={handleSend} disabled={!canSend}>
            ➤ Send
          </button>
        </div>
      )}
    </div>
  );
}
