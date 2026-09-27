/**
 * Voice v1 (docs/DESIGN-voice-v1.md) — browser-native TTS/dictation helpers.
 * Zero deps, zero server changes: everything here talks directly to the
 * browser's speechSynthesis / SpeechRecognition globals (feature-detected —
 * both are commonly absent: SpeechRecognition is Chromium-only/webkit-
 * prefixed, and either can be missing in embedded/test environments).
 *
 * Kept free of React and of packages/ui's zustand stores so every function
 * here is a plain, directly unit-testable unit (see voice.test.ts) — the
 * store (../store/voiceStore.ts) is the only thing that holds state.
 */

// ============================================================================
// Ambient types for the Web Speech API's recognition side. TypeScript's
// lib.dom.d.ts ships SpeechSynthesis/SpeechSynthesisUtterance (used below,
// no shim needed) but NOT SpeechRecognition — it never fully standardized
// (Chromium-only, webkit-prefixed), so it's absent from lib.dom entirely.
// Minimal surface, declared the same way lib.dom.d.ts itself declares
// `speechSynthesis` (a bare ambient global — see that file's use of
// `declare var speechSynthesis: SpeechSynthesis;`).
// ============================================================================

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((this: SpeechRecognitionLike, ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((this: SpeechRecognitionLike, ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((this: SpeechRecognitionLike, ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = { new (): SpeechRecognitionLike };

declare global {
  // eslint-disable-next-line no-var
  var SpeechRecognition: SpeechRecognitionCtor | undefined;
  // eslint-disable-next-line no-var
  var webkitSpeechRecognition: SpeechRecognitionCtor | undefined;
}

// ============================================================================
// Feature detection
// ============================================================================

/** Bare-global check (works identically in a real browser and in a test
 *  environment with `globalThis.speechSynthesis` stubbed) — deliberately not
 *  `window.speechSynthesis`, so this has no dependency on `window` existing. */
export function getSynth(): SpeechSynthesis | null {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
}

export function isTTSSupported(): boolean {
  return getSynth() !== null;
}

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof SpeechRecognition !== 'undefined') return SpeechRecognition;
  if (typeof webkitSpeechRecognition !== 'undefined') return webkitSpeechRecognition;
  return null;
}

export function isDictationSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

// ============================================================================
// TTS playback helpers
// ============================================================================

export interface VoicePrefs {
  rate: number;
  voiceURI: string | null;
}

/** Resolves a persisted voiceURI to an actual SpeechSynthesisVoice, or null
 *  (browser default) when unset or no longer present (voices list can change
 *  between sessions/devices — never throw over a stale saved id). */
export function resolveVoice(voiceURI: string | null): SpeechSynthesisVoice | null {
  if (!voiceURI) return null;
  const synth = getSynth();
  if (!synth) return null;
  return synth.getVoices().find((v) => v.voiceURI === voiceURI) ?? null;
}

export function createUtterance(text: string, prefs: VoicePrefs): SpeechSynthesisUtterance {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = prefs.rate;
  const voice = resolveVoice(prefs.voiceURI);
  if (voice) utterance.voice = voice;
  return utterance;
}

// ============================================================================
// Auto-read queue (pure math — the store owns the actual queue state)
// ============================================================================

export const MAX_AUTO_READ_QUEUE_DEPTH = 3;

/** Appends `item`, dropping the OLDEST entries once over `maxDepth` — "drop
 *  queue >3 deep (never backlog)" (docs/DESIGN-voice-v1.md): auto-read stays
 *  roughly caught-up to the live conversation instead of accumulating an
 *  ever-growing backlog of things to read aloud. */
export function pushBounded<T>(queue: T[], item: T, maxDepth: number): T[] {
  const next = [...queue, item];
  return next.length > maxDepth ? next.slice(next.length - maxDepth) : next;
}

// ============================================================================
// Markdown -> speech-friendly plain text
// ============================================================================

/** Light regex strip of the CommonMark syntax that reads worst aloud
 *  (asterisks, backticks, link brackets, heading hashes…). Deliberately not a
 *  full markdown parser — this only has to sound reasonable, not round-trip. */
export function stripMarkdownForSpeech(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// Dictation transcript parsing
// ============================================================================

/**
 * Pulls interim/final text out of a recognition event. Only walks
 * `[resultIndex, results.length)` — everything before `resultIndex` was
 * already finalized by an earlier event and won't repeat (per the Web Speech
 * API's incremental-results model). Defensive at every step (missing
 * `results`, zero-length, a result with no alternatives) so a browser sending
 * an empty-grammar event can never throw — it just yields empty strings.
 */
export function extractTranscript(event: {
  resultIndex?: number;
  results?: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }> | null;
}): { interimText: string; finalText: string } {
  let interimText = '';
  let finalText = '';
  const results = event.results;
  const length = results?.length ?? 0;
  const start = event.resultIndex ?? 0;
  for (let i = start; i < length; i++) {
    const result = results?.[i];
    const transcript = result?.[0]?.transcript ?? '';
    if (!transcript) continue;
    if (result?.isFinal) finalText = finalText ? `${finalText} ${transcript}` : transcript;
    else interimText = interimText ? `${interimText} ${transcript}` : transcript;
  }
  return { interimText, finalText };
}

/** Joins the composer's pre-dictation text with the accumulated final
 *  transcript and the current in-flight interim tail, single-spaced and
 *  trimmed — never drops what the user already typed before hitting the mic. */
export function joinDictation(base: string, committed: string, interim: string): string {
  return [base, committed, interim]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * Dictation session state (pure, React-free) — the single source of truth
 * Composer's one `dictationRef` holds for the lifetime of a mic-on session.
 * Centralizing every transition here is what lets every path that can touch
 * the composer text mid-dictation — typed edits, emoji pick, @mention
 * insert, and the post-send clear — share the exact same re-anchor logic
 * instead of each reimplementing (or forgetting) it.
 *
 * History (review 2026-07-09, round 1 fix, commit 06f137c): the first fix
 * only re-anchored on the textarea's own onChange, via a narrower
 * `resyncDictationOnManualEdit(value): { base, committed }` that this
 * replaces. Two bugs survived that round because nothing else re-anchored:
 *
 * Bug 1 (clobber): emoji pick, @mention insert, and send's `setValue('')`
 * are all programmatic composer mutations that never went through resync —
 * `dictationBaseRef`/`committedRef` stayed stale, so the very next
 * SpeechRecognition event recomputed `joinDictation(staleBase, committed,
 * text)` from the PRE-mutation base and silently wiped whichever of those
 * had just happened (emoji erased, mention erased, sent text resurrected
 * into the now-empty composer).
 *
 * Bug 2 (interim-tail duplication): `resyncDictationOnManualEdit` folded
 * the composer's *entire visible value* into the new base unconditionally
 * — including a live interim tail, if one was painted in at edit time. That
 * phrase's `isFinal` segment was still in flight and would land on top of
 * text the user had just accepted, e.g. base "hello", interim "wrold"
 * painted, user hand-corrects to "hello world", then the pending final
 * "wrold" arrives -> "hello world wrold". `skipNextFinal` below exists
 * specifically to close this: `reanchorDictationSession` sets it whenever
 * the session it's re-anchoring had a live interim, and
 * `applyDictationFinal` drops (instead of appends) the one final segment
 * it's covering for.
 */
export interface DictationSession {
  /** Composer text this session is anchored to — everything before it. */
  base: string;
  /** Finalized transcript segments accumulated since the last anchor. */
  committed: string;
  /** The interim (not-yet-final) tail currently painted, or '' when none is live. */
  interim: string;
  /**
   * True when the phrase in flight at the moment of the last re-anchor must
   * have its eventual `isFinal` segment dropped instead of appended — see
   * "Bug 2" above.
   */
  skipNextFinal: boolean;
}

/** Starts a fresh session anchored to the composer's text at mic-on. */
export function startDictationSession(currentValue: string): DictationSession {
  return { base: currentValue, committed: '', interim: '', skipNextFinal: false };
}

/** The text the composer should display for a session's current state. */
export function dictationSessionValue(session: DictationSession): string {
  return joinDictation(session.base, session.committed, session.interim);
}

/**
 * Re-anchors a live session to `next` — the new ground truth for the
 * composer after ANY external mutation while the mic is live: a hand-typed
 * edit, an emoji pick, an @mention insert, or the post-send clear. Callers
 * compute `next` themselves (the post-mutation composer value) and are
 * expected to have already called `setValue(next)` — this only updates the
 * dictation bookkeeping so the NEXT SpeechRecognition event appends after
 * `next` instead of recomputing from a stale pre-mutation base (Bug 1).
 *
 * If the session being re-anchored had a live interim tail
 * (`session.interim !== ''`), that tail is presumed already folded into
 * `next` by the caller (its text was visible, so it's part of whatever the
 * user just approved/edited/sent). `skipNextFinal` is set so the matching
 * final — still in flight — is dropped instead of appended a second time
 * (Bug 2). An already-set `skipNextFinal` from an earlier re-anchor whose
 * final hasn't arrived yet is preserved, not cleared.
 */
export function reanchorDictationSession(session: DictationSession, next: string): DictationSession {
  return {
    base: next,
    committed: '',
    interim: '',
    skipNextFinal: session.interim !== '' || session.skipNextFinal,
  };
}

/**
 * Applies a finalized transcript segment. If `skipNextFinal` is set, this
 * one segment is the phrase a re-anchor already folded into the visible
 * text (Bug 2) — it's dropped and the flag is consumed (cleared), so only
 * the single final in flight at re-anchor time is skipped; anything after
 * that is a new phrase and appends normally.
 */
export function applyDictationFinal(session: DictationSession, text: string): DictationSession {
  if (session.skipNextFinal) {
    return { ...session, skipNextFinal: false, interim: '' };
  }
  return {
    ...session,
    committed: session.committed ? `${session.committed} ${text}` : text,
    interim: '',
  };
}

/**
 * Applies an interim (not-yet-final) transcript segment. While
 * `skipNextFinal` is set, incoming interim events still belong to the
 * folded-away phrase (its final hasn't arrived to clear the flag yet) and
 * are suppressed — repainting them would resurrect text the re-anchor just
 * replaced. This also covers the combined-event case `createRecognition`
 * can emit (one `onresult` carrying both the old phrase's final AND a new
 * phrase's interim): `onFinal` runs first and clears the flag before
 * `onInterim` runs (see `createRecognition` below), so the new interim
 * paints normally within that same event.
 */
export function applyDictationInterim(session: DictationSession, text: string): DictationSession {
  if (session.skipNextFinal) return session;
  return { ...session, interim: text };
}

// ============================================================================
// Recognition session wiring
// ============================================================================

export interface RecognitionHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: string) => void;
  onEnd: () => void;
}

/** Builds and wires a recognition instance; returns null when unsupported
 *  (defensive — callers should already have hidden the mic button via
 *  isDictationSupported(), this is a second guard, not the primary one). */
export function createRecognition(handlers: RecognitionHandlers): SpeechRecognitionLike | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
  recognition.onresult = (event) => {
    const { interimText, finalText } = extractTranscript(event);
    if (finalText) handlers.onFinal(finalText);
    if (interimText) handlers.onInterim(interimText);
  };
  recognition.onerror = (event) => handlers.onError(event.error);
  recognition.onend = () => handlers.onEnd();
  return recognition;
}

// ============================================================================
// localStorage persistence — settings are pure client state, no wire event.
// Every read/write is defensive (private browsing, quota, disabled storage,
// corrupt JSON) so a broken localStorage degrades to "not persisted" rather
// than a crash.
// ============================================================================

const AUTO_READ_KEY = 'agent-os:voice:auto-read-rooms';
const SETTINGS_KEY = 'agent-os:voice:settings';

function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Some browsers throw on *accessing* localStorage in certain private-
    // browsing modes, not just on read/write.
    return null;
  }
}

export function loadAutoReadRoomIds(): Set<string> {
  const storage = getLocalStorage();
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(AUTO_READ_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function saveAutoReadRoomIds(ids: Set<string>): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(AUTO_READ_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* quota / private-browsing write rejection — setting still applies in-memory for this session */
  }
}

const DEFAULT_VOICE_PREFS: VoicePrefs = { rate: 1, voiceURI: null };

export function loadVoicePrefs(): VoicePrefs {
  const storage = getLocalStorage();
  if (!storage) return DEFAULT_VOICE_PREFS;
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_VOICE_PREFS;
    const parsed = JSON.parse(raw);
    const rate = typeof parsed?.rate === 'number' && parsed.rate > 0 ? parsed.rate : DEFAULT_VOICE_PREFS.rate;
    const voiceURI = typeof parsed?.voiceURI === 'string' ? parsed.voiceURI : null;
    return { rate, voiceURI };
  } catch {
    return DEFAULT_VOICE_PREFS;
  }
}

export function saveVoicePrefs(prefs: VoicePrefs): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
  } catch {
    /* ditto */
  }
}
