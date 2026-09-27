/**
 * Shared test doubles for the Web Speech API globals voice.ts/voiceStore.ts
 * feature-detect (speechSynthesis, SpeechSynthesisUtterance, SpeechRecognition,
 * localStorage). Used by voice.test.ts and voiceStore.test.ts via
 * `vi.stubGlobal` — kept in one place so both suites exercise the exact same
 * fake behavior (in particular: manually firing `onend`/`onerror` to simulate
 * an utterance finishing, since there's no real audio engine in a test run).
 *
 * Not itself a *.test.ts file — no `describe`/`it` here, so vitest's default
 * include glob never picks it up as a suite of its own.
 */

export class FakeUtterance {
  text: string;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text?: string) {
    this.text = text ?? '';
  }
}

export function makeFakeVoice(voiceURI: string, name: string, lang = 'en-US'): SpeechSynthesisVoice {
  return { voiceURI, name, lang, default: false, localService: true } as SpeechSynthesisVoice;
}

export class FakeSynth {
  cancelCalls = 0;
  spoken: FakeUtterance[] = [];
  voices: SpeechSynthesisVoice[];
  constructor(voices: SpeechSynthesisVoice[] = []) {
    this.voices = voices;
  }
  getVoices() {
    return this.voices;
  }
  cancel() {
    this.cancelCalls++;
  }
  speak(utterance: FakeUtterance) {
    this.spoken.push(utterance);
  }
}

export class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  start() {
    this.startCalls++;
  }
  stop() {}
  abort() {}
}

export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}
