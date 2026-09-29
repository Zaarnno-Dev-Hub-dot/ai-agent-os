import { create } from 'zustand';
import {
  MAX_AUTO_READ_QUEUE_DEPTH,
  createUtterance,
  getSynth,
  loadAutoReadRoomIds,
  loadVoicePrefs,
  pushBounded,
  saveAutoReadRoomIds,
  saveVoicePrefs,
  stripMarkdownForSpeech,
} from '../lib/voice';

/** One pending auto-read item — queued text for a message that already
 *  passed the toggle+visibility+non-empty-text gate in handleIncomingAgentMessage. */
export interface ReadQueueItem {
  messageId: string;
  roomId: string;
  text: string;
}

/** Shape gatewayStore's message.new handling hands off on every agent
 *  message — see that file's comment for why the hop exists (voiceStore owns
 *  the toggle/visibility gating and the bounded queue, gatewayStore just
 *  forwards). */
export interface IncomingAgentMessage {
  messageId: string;
  roomId: string;
  senderId: string;
  content: string;
}

export interface VoiceState {
  // ---- Settings, localStorage-persisted. Hardcoded-safe defaults here;
  // hydrate() (called once from App.tsx's mount effect) pulls in whatever
  // was actually persisted. Never read at module-eval time — this store is
  // safe to import in any environment (tests included) without a DOM.
  autoReadRoomIds: Set<string>;
  rate: number;
  voiceURI: string | null;

  // ---- Playback. speakingMessageId is the single source of truth for
  // "what's the speaker icon on this bubble supposed to show" — manual plays
  // and auto-read plays are indistinguishable once they're the thing making
  // noise, by design (see stopSpeaking's comment for the one behavioral
  // difference: what happens to the pending queue).
  speakingMessageId: string | null;
  readQueue: ReadQueueItem[];

  // ---- Environment.
  /** Mirrors `!document.hidden`, kept live by App.tsx's visibilitychange
   *  listener. Auto-read is gated on this — "when ON and tab visible" per
   *  the original design — nothing else in the app depends on it. */
  tabVisible: boolean;
  /** Set once a SpeechRecognition error reports permission was refused.
   *  Deliberately NOT persisted (localStorage) — "disabled for session"
   *  means this page load, not forever; a reload re-prompts. */
  micPermissionDenied: boolean;

  hydrate: () => void;
  toggleAutoRead: (roomId: string) => void;
  setRate: (rate: number) => void;
  setVoiceURI: (voiceURI: string | null) => void;
  setTabVisible: (visible: boolean) => void;
  setMicPermissionDenied: (denied: boolean) => void;
  /** Manual play from a message bubble's speaker icon. */
  playMessage: (messageId: string, content: string) => void;
  /** Manual stop (click-again on the currently-speaking bubble). */
  stopSpeaking: () => void;
  handleIncomingAgentMessage: (msg: IncomingAgentMessage) => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  // Guards stale onend/onerror callbacks from a previous utterance: cancel()
  // firing 'end'/'error' timing is notoriously inconsistent across browsers,
  // so every speakNow() bumps this and every settle() checks it's still
  // current before touching state — a callback from an utterance that's
  // already been superseded by a newer play/stop is a no-op.
  let utteranceToken = 0;

  /** The only place a queued item is popped and actually spoken — called
   *  right after enqueueing (if idle) and again every time an utterance
   *  settles. Safe to call any time; no-ops unless idle, visible, and
   *  something is actually waiting. */
  function advanceQueue() {
    const state = get();
    if (!state.tabVisible || state.speakingMessageId !== null || state.readQueue.length === 0) return;
    const [next, ...rest] = state.readQueue;
    set({ readQueue: rest });
    speakNow(next.messageId, next.text);
  }

  /** Shared by playMessage (manual) and advanceQueue (auto-read): cancel
   *  whatever's playing, speak this text, and on natural end/error clear
   *  state and try to drain the next queued item. Manual plays never touch
   *  readQueue directly — they just borrow the speaker for a moment; the
   *  queue (if any) resumes right after via the same settle() -> advanceQueue()
   *  path an auto-read item would use. */
  function speakNow(messageId: string, text: string) {
    const token = ++utteranceToken;
    set({ speakingMessageId: messageId });
    const synth = getSynth();
    if (!synth) {
      // No engine (feature-detect false) — never leave the store "stuck
      // speaking" with nothing able to end it. The UI hides every voice
      // affordance when unsupported; this is the store's own safety net.
      set({ speakingMessageId: null });
      return;
    }
    synth.cancel(); // "New play cancels old" (docs/DESIGN-voice-v1.md)
    const { rate, voiceURI } = get();
    const utterance = createUtterance(text, { rate, voiceURI });
    const settle = () => {
      if (token !== utteranceToken) return; // superseded by a newer play/stop
      set({ speakingMessageId: null });
      advanceQueue();
    };
    utterance.onend = settle;
    utterance.onerror = settle;
    synth.speak(utterance);
  }

  return {
    autoReadRoomIds: new Set<string>(),
    rate: 1,
    voiceURI: null,
    speakingMessageId: null,
    readQueue: [],
    tabVisible: true,
    micPermissionDenied: false,

    hydrate: () =>
      set({
        autoReadRoomIds: loadAutoReadRoomIds(),
        ...loadVoicePrefs(),
        tabVisible: typeof document !== 'undefined' ? !document.hidden : true,
      }),

    toggleAutoRead: (roomId) =>
      set((state) => {
        const next = new Set(state.autoReadRoomIds);
        if (next.has(roomId)) next.delete(roomId);
        else next.add(roomId);
        saveAutoReadRoomIds(next);
        return { autoReadRoomIds: next };
      }),

    setRate: (rate) =>
      set((state) => {
        const clamped = Math.min(10, Math.max(0.1, rate));
        saveVoicePrefs({ rate: clamped, voiceURI: state.voiceURI });
        return { rate: clamped };
      }),

    setVoiceURI: (voiceURI) =>
      set((state) => {
        saveVoicePrefs({ rate: state.rate, voiceURI });
        return { voiceURI };
      }),

    setTabVisible: (visible) => {
      set({ tabVisible: visible });
      // Coming back to a visible tab resumes draining whatever's still
      // queued — hiding never drops items (only NEW ones stop enqueueing
      // while hidden, see handleIncomingAgentMessage), it just pauses
      // playback of them. An already-speaking utterance is never cut off by
      // a visibility change in either direction (see module doc).
      if (visible) advanceQueue();
    },

    setMicPermissionDenied: (denied) => set({ micPermissionDenied: denied }),

    playMessage: (messageId, content) => {
      speakNow(messageId, stripMarkdownForSpeech(content));
    },

    stopSpeaking: () => {
      utteranceToken++; // invalidate any in-flight settle() for the current utterance
      getSynth()?.cancel();
      // A deliberate stop is a full halt: also drops anything still queued
      // from auto-read, so silencing the current bubble doesn't immediately
      // cascade into the next agent message playing right after — unlike
      // the natural end-of-utterance path (settle(), above), which DOES
      // drain the queue. Auto-read stays armed for the *next* incoming
      // message; this only clears the current backlog.
      set({ speakingMessageId: null, readQueue: [] });
    },

    handleIncomingAgentMessage: ({ messageId, roomId, senderId, content }) => {
      if (senderId === 'human') return;
      const state = get();
      if (!state.tabVisible || !state.autoReadRoomIds.has(roomId)) return;
      const text = stripMarkdownForSpeech(content);
      if (!text) return; // e.g. an attachment-only message with no body text
      const item: ReadQueueItem = { messageId, roomId, text };
      set((s) => ({ readQueue: pushBounded(s.readQueue, item, MAX_AUTO_READ_QUEUE_DEPTH) }));
      advanceQueue();
    },
  };
});
