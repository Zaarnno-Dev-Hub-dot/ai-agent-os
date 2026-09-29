import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDictationFinal,
  applyDictationInterim,
  createRecognition,
  createUtterance,
  type DictationSession,
  dictationSessionValue,
  extractTranscript,
  getSpeechRecognitionCtor,
  getSynth,
  isDictationSupported,
  isTTSSupported,
  joinDictation,
  loadAutoReadRoomIds,
  loadVoicePrefs,
  pushBounded,
  reanchorDictationSession,
  resolveVoice,
  saveAutoReadRoomIds,
  saveVoicePrefs,
  startDictationSession,
  stripMarkdownForSpeech,
} from './voice';
import { FakeRecognition, FakeSynth, FakeUtterance, MemoryStorage, makeFakeVoice } from './speechFakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feature detection', () => {
  it('reports TTS unsupported when speechSynthesis is absent', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    expect(isTTSSupported()).toBe(false);
    expect(getSynth()).toBeNull();
  });

  it('reports TTS supported when speechSynthesis is present', () => {
    const synth = new FakeSynth();
    vi.stubGlobal('speechSynthesis', synth as unknown as SpeechSynthesis);
    expect(isTTSSupported()).toBe(true);
    expect(getSynth()).toBe(synth);
  });

  it('reports dictation unsupported when neither ctor is present', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    expect(isDictationSupported()).toBe(false);
    expect(getSpeechRecognitionCtor()).toBeNull();
  });

  it('prefers unprefixed SpeechRecognition over the webkit-prefixed one', () => {
    const Plain = FakeRecognition;
    const Webkit = class extends FakeRecognition {};
    vi.stubGlobal('SpeechRecognition', Plain as unknown as typeof SpeechRecognition);
    vi.stubGlobal('webkitSpeechRecognition', Webkit as unknown as typeof SpeechRecognition);
    expect(getSpeechRecognitionCtor()).toBe(Plain);
  });

  it('falls back to webkitSpeechRecognition when the unprefixed ctor is absent', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    const Webkit = class extends FakeRecognition {};
    vi.stubGlobal('webkitSpeechRecognition', Webkit as unknown as typeof SpeechRecognition);
    expect(isDictationSupported()).toBe(true);
    expect(getSpeechRecognitionCtor()).toBe(Webkit);
  });
});

describe('createUtterance / resolveVoice', () => {
  it('returns null when there is no synth or no requested voice', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    expect(resolveVoice('anything')).toBeNull();
    expect(resolveVoice(null)).toBeNull();
  });

  it('resolves a persisted voiceURI to the matching voice', () => {
    const v1 = makeFakeVoice('v1', 'Voice One');
    const v2 = makeFakeVoice('v2', 'Voice Two');
    vi.stubGlobal('speechSynthesis', new FakeSynth([v1, v2]) as unknown as SpeechSynthesis);
    expect(resolveVoice('v2')).toBe(v2);
  });

  it('returns null for a voiceURI that no longer matches any installed voice', () => {
    vi.stubGlobal('speechSynthesis', new FakeSynth([makeFakeVoice('v1', 'Voice One')]) as unknown as SpeechSynthesis);
    expect(resolveVoice('stale-uri')).toBeNull();
  });

  it('sets rate and resolved voice on the constructed utterance', () => {
    const v1 = makeFakeVoice('v1', 'Voice One');
    vi.stubGlobal('speechSynthesis', new FakeSynth([v1]) as unknown as SpeechSynthesis);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
    const utterance = createUtterance('hello', { rate: 1.5, voiceURI: 'v1' });
    expect(utterance.text).toBe('hello');
    expect(utterance.rate).toBe(1.5);
    expect(utterance.voice).toBe(v1);
  });

  it('leaves voice unset (browser default) when voiceURI is null', () => {
    vi.stubGlobal('speechSynthesis', new FakeSynth([makeFakeVoice('v1', 'Voice One')]) as unknown as SpeechSynthesis);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
    const utterance = createUtterance('hello', { rate: 1, voiceURI: null });
    expect(utterance.voice).toBeNull();
  });
});

describe('pushBounded', () => {
  it('appends under the cap', () => {
    expect(pushBounded([1, 2], 3, 3)).toEqual([1, 2, 3]);
  });

  it('drops the oldest entries once over the cap', () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it('never exceeds the cap even from a single push past it', () => {
    const result = pushBounded(['a', 'b', 'c', 'd'], 'e', 3);
    expect(result).toEqual(['c', 'd', 'e']);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe('stripMarkdownForSpeech', () => {
  it('strips bold, italic, and inline code', () => {
    expect(stripMarkdownForSpeech('**bold** and *italic* and `code`')).toBe('bold and italic and code');
  });

  it('strips heading markers', () => {
    expect(stripMarkdownForSpeech('# Big Title\ntext')).toBe('Big Title text');
  });

  it('converts links and images to their label/alt text', () => {
    expect(stripMarkdownForSpeech('see [the docs](https://example.com) please')).toBe('see the docs please');
    expect(stripMarkdownForSpeech('![a cat](cat.png)')).toBe('a cat');
  });

  it('strips list markers and fenced code blocks', () => {
    expect(stripMarkdownForSpeech('- one\n- two')).toBe('one two');
    expect(stripMarkdownForSpeech('before\n```js\ncode();\n```\nafter')).toBe('before after');
  });

  it('collapses whitespace and trims', () => {
    expect(stripMarkdownForSpeech('  hello   world  ')).toBe('hello world');
  });

  it('returns empty string for whitespace-only / empty input', () => {
    expect(stripMarkdownForSpeech('   ')).toBe('');
    expect(stripMarkdownForSpeech('')).toBe('');
  });
});

describe('extractTranscript', () => {
  it('does not crash on an empty-grammar event (zero results)', () => {
    expect(() => extractTranscript({ resultIndex: 0, results: [] })).not.toThrow();
    expect(extractTranscript({ resultIndex: 0, results: [] })).toEqual({ interimText: '', finalText: '' });
  });

  it('does not crash when results/resultIndex are missing entirely', () => {
    expect(() => extractTranscript({})).not.toThrow();
    expect(extractTranscript({})).toEqual({ interimText: '', finalText: '' });
  });

  it('does not crash on a result with no alternatives', () => {
    const event = { resultIndex: 0, results: [{ isFinal: true }] };
    expect(() => extractTranscript(event)).not.toThrow();
    expect(extractTranscript(event)).toEqual({ interimText: '', finalText: '' });
  });

  it('separates final and interim text', () => {
    const event = {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'hello there' } }, { isFinal: false, 0: { transcript: 'how ar' } }],
    };
    expect(extractTranscript(event)).toEqual({ interimText: 'how ar', finalText: 'hello there' });
  });

  it('only walks results from resultIndex onward (earlier ones already finalized)', () => {
    const event = {
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: 'already handled' } },
        { isFinal: true, 0: { transcript: 'new final' } },
      ],
    };
    expect(extractTranscript(event)).toEqual({ interimText: '', finalText: 'new final' });
  });
});

describe('joinDictation', () => {
  it('joins non-empty parts with single spaces', () => {
    expect(joinDictation('typed text', 'said this', 'and now')).toBe('typed text said this and now');
  });

  it('skips empty parts without leaving extra spaces', () => {
    expect(joinDictation('', 'said this', '')).toBe('said this');
    expect(joinDictation('', '', '')).toBe('');
  });

  it('trims each part before joining', () => {
    expect(joinDictation('  base  ', '  mid  ', '  tail  ')).toBe('base mid tail');
  });
});

// ============================================================================
// DictationSession — the state machine behind Composer's single dictationRef.
// These tests exercise it exactly as Composer.tsx's handlers do: a sequence
// of applyDictationInterim/applyDictationFinal calls (SpeechRecognition
// events) interleaved with reanchorDictationSession calls (the four external
// mutation paths: typed edit, emoji pick, @mention insert, send). Composer
// itself stays untested at the component level — no RTL/jsdom in this
// codebase — but
// since both bugs live entirely in this state machine's transition logic,
// not in DOM wiring, these give the same regression coverage a rendered
// Composer test would.
// ============================================================================

describe('startDictationSession / dictationSessionValue', () => {
  it('anchors to the composer text at mic-on, nothing committed or interim yet', () => {
    const session = startDictationSession('typed text');
    expect(session).toEqual({ base: 'typed text', committed: '', interim: '', skipNextFinal: false });
    expect(dictationSessionValue(session)).toBe('typed text');
  });
});

describe('applyDictationInterim / applyDictationFinal — normal flow', () => {
  it('paints interim tails and accumulates committed segments across several phrases', () => {
    let session = startDictationSession('');
    session = applyDictationInterim(session, 'hel');
    expect(dictationSessionValue(session)).toBe('hel');
    session = applyDictationFinal(session, 'hello');
    expect(dictationSessionValue(session)).toBe('hello');
    session = applyDictationInterim(session, 'wor');
    expect(dictationSessionValue(session)).toBe('hello wor');
    session = applyDictationFinal(session, 'world');
    expect(dictationSessionValue(session)).toBe('hello world');
  });
});

describe('reanchorDictationSession — unit behavior', () => {
  it('resets base to `next` and clears committed', () => {
    const session: DictationSession = { base: 'old', committed: 'said', interim: '', skipNextFinal: false };
    expect(reanchorDictationSession(session, 'edited value')).toEqual({
      base: 'edited value',
      committed: '',
      interim: '',
      skipNextFinal: false,
    });
  });

  it('sets skipNextFinal when a live interim tail is folded into the new base', () => {
    const session: DictationSession = { base: 'old', committed: '', interim: 'ing', skipNextFinal: false };
    expect(reanchorDictationSession(session, 'edited value').skipNextFinal).toBe(true);
  });

  it('preserves an already-set skipNextFinal from an earlier re-anchor whose final has not arrived yet', () => {
    const session: DictationSession = { base: 'old', committed: '', interim: '', skipNextFinal: true };
    expect(reanchorDictationSession(session, 'edited again').skipNextFinal).toBe(true);
  });
});

describe('applyDictationFinal — skipNextFinal consumption', () => {
  it('drops the covered final and clears the flag; the NEXT final appends normally', () => {
    let session: DictationSession = { base: 'hello world', committed: '', interim: '', skipNextFinal: true };
    session = applyDictationFinal(session, 'wrold');
    expect(session).toEqual({ base: 'hello world', committed: '', interim: '', skipNextFinal: false });
    session = applyDictationFinal(session, 'today');
    expect(dictationSessionValue(session)).toBe('hello world today');
  });
});

describe('applyDictationInterim — suppression while skipNextFinal is set', () => {
  it('ignores interim events belonging to the folded-away phrase (no repaint)', () => {
    const session: DictationSession = { base: 'hello world', committed: '', interim: '', skipNextFinal: true };
    expect(applyDictationInterim(session, 'wr')).toEqual(session);
  });
});

describe('Bug 1 — external composer mutations no longer clobbered mid-dictation', () => {
  it('emoji picked mid-interim: the emoji is preserved and the in-flight phrase\'s final does not clobber or duplicate it', () => {
    let session = startDictationSession('');
    session = applyDictationInterim(session, 'nice');
    expect(dictationSessionValue(session)).toBe('nice');

    // Composer's emoji onPick computes next = value + emoji itself, then re-anchors.
    const nextAfterEmoji = `${dictationSessionValue(session)} 🎉`;
    session = reanchorDictationSession(session, nextAfterEmoji);
    expect(dictationSessionValue(session)).toBe('nice 🎉');

    // The interrupted phrase's final still arrives — must be dropped, not appended.
    session = applyDictationFinal(session, 'nice');
    expect(dictationSessionValue(session)).toBe('nice 🎉');

    // Dictation keeps working normally afterward.
    session = applyDictationInterim(session, 'more');
    expect(dictationSessionValue(session)).toBe('nice 🎉 more');
    session = applyDictationFinal(session, 'more stuff');
    expect(dictationSessionValue(session)).toBe('nice 🎉 more stuff');
  });

  it('mention inserted mid-interim: the mention is preserved and the in-flight phrase\'s final does not clobber or duplicate it', () => {
    let session = startDictationSession('hey ');
    session = applyDictationInterim(session, 'claud'); // user was dictating "claud..." then picked the mention instead
    // Composer's pickMention builds `next` itself from the mention query/caret.
    const nextAfterMention = 'hey @claude-code ';
    session = reanchorDictationSession(session, nextAfterMention);
    expect(dictationSessionValue(session)).toBe('hey @claude-code');

    session = applyDictationFinal(session, 'claud'); // the interrupted phrase's final still arrives
    expect(dictationSessionValue(session)).toBe('hey @claude-code');

    session = applyDictationInterim(session, 'please help');
    expect(dictationSessionValue(session)).toBe('hey @claude-code please help');
  });

  it('send mid-dictation with a finalized phrase already sent: the next phrase paints into the fresh composer, not appended after the old text', () => {
    let session = startDictationSession('');
    session = applyDictationInterim(session, 'send this');
    session = applyDictationFinal(session, 'send this now');
    expect(dictationSessionValue(session)).toBe('send this now'); // this is what handleSend reads as `content` and sends

    // handleSend clears the composer and re-anchors, mic stays open. No live
    // interim at send time here, so there's nothing in flight to skip —
    // resetting `committed` is what stops the sent text from leaking into
    // the next phrase.
    session = reanchorDictationSession(session, '');
    expect(session.skipNextFinal).toBe(false);
    expect(dictationSessionValue(session)).toBe('');

    session = applyDictationInterim(session, 'new draft');
    expect(dictationSessionValue(session)).toBe('new draft'); // NOT "send this now new draft"
  });

  it('send mid-dictation with a live interim in flight: sent text is not resurrected when that phrase\'s final arrives afterward', () => {
    // Realistic race: the user hits Send while an interim tail is still
    // showing (SpeechRecognition never re-fires an identical final for an
    // already-committed phrase — the risk here is the phrase that was
    // mid-flight, in interim, AT THE MOMENT of send).
    let session = startDictationSession('');
    session = applyDictationInterim(session, 'send this now'); // interim showing when Send is clicked
    expect(dictationSessionValue(session)).toBe('send this now'); // this is what handleSend reads as `content` and sends

    session = reanchorDictationSession(session, ''); // handleSend clears + re-anchors
    expect(session.skipNextFinal).toBe(true); // live interim was in flight at send time
    expect(dictationSessionValue(session)).toBe('');

    // That in-flight phrase's final now lands — must not resurrect the sent text.
    session = applyDictationFinal(session, 'send this now');
    expect(dictationSessionValue(session)).toBe('');

    // The next phrase paints into the now-empty composer.
    session = applyDictationInterim(session, 'new draft');
    expect(dictationSessionValue(session)).toBe('new draft');
  });
});

describe('Bug 2 regression — interim-tail duplication on manual edit', () => {
  it('does not duplicate the interim tail when a manual edit folds it into the new base', () => {
    // Exact review scenario: base "hello", interim "wrold" painted, user
    // hand-corrects the textarea to "hello world" without clicking stop
    // first, then the "wrold" final (already superseded) arrives late.
    let session = startDictationSession('hello');
    session = applyDictationInterim(session, 'wrold');
    expect(dictationSessionValue(session)).toBe('hello wrold');

    session = reanchorDictationSession(session, 'hello world'); // handleChange fires on the hand edit
    expect(dictationSessionValue(session)).toBe('hello world');

    session = applyDictationFinal(session, 'wrold'); // the pre-edit phrase's final arrives late
    expect(dictationSessionValue(session)).toBe('hello world'); // NOT "hello world wrold"
    expect(dictationSessionValue(session)).not.toContain('wrold wrold');

    session = applyDictationInterim(session, 'today');
    expect(dictationSessionValue(session)).toBe('hello world today');
  });
});

describe('Combined event — old phrase\'s final + new phrase\'s interim in one onresult', () => {
  it('drops the old final and paints the new interim, per createRecognition calling onFinal before onInterim', () => {
    // createRecognition.onresult calls handlers.onFinal(finalText) before
    // handlers.onInterim(interimText) when a single event carries both (see
    // createRecognition below) — so Composer's appendDictated processes the
    // old phrase's final first (consuming skipNextFinal) and the new
    // phrase's interim second, within the same synchronous event.
    let session = startDictationSession('hello');
    session = applyDictationInterim(session, 'wrold');
    session = reanchorDictationSession(session, 'hello world'); // manual edit re-anchors, sets skipNextFinal
    expect(session.skipNextFinal).toBe(true);

    session = applyDictationFinal(session, 'wrold'); // old phrase's final: dropped, flag cleared
    session = applyDictationInterim(session, 'today'); // new phrase's interim, same event: paints normally
    expect(dictationSessionValue(session)).toBe('hello world today');
  });
});

describe('createRecognition', () => {
  beforeEach(() => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition as unknown as typeof SpeechRecognition);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
  });

  it('returns null when unsupported', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    const handlers = { onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    expect(createRecognition(handlers)).toBeNull();
  });

  it('configures continuous + interimResults and wires callbacks', () => {
    const handlers = { onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const recognition = createRecognition(handlers) as unknown as FakeRecognition;
    expect(recognition).not.toBeNull();
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);

    recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hi' } }] });
    expect(handlers.onFinal).toHaveBeenCalledWith('hi');
    expect(handlers.onInterim).not.toHaveBeenCalled();

    recognition.onerror?.({ error: 'not-allowed' });
    expect(handlers.onError).toHaveBeenCalledWith('not-allowed');

    recognition.onend?.();
    expect(handlers.onEnd).toHaveBeenCalled();
  });

  it('does not crash and fires no text callbacks for an empty-grammar result event', () => {
    const handlers = { onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const recognition = createRecognition(handlers) as unknown as FakeRecognition;
    expect(() => recognition.onresult?.({ resultIndex: 0, results: [] })).not.toThrow();
    expect(handlers.onInterim).not.toHaveBeenCalled();
    expect(handlers.onFinal).not.toHaveBeenCalled();
  });

  it('calls onFinal before onInterim when a single event carries both an old phrase\'s final and a new phrase\'s interim', () => {
    // The "combined event" DictationSession's re-anchor logic depends on:
    // Composer's appendDictated processes the old phrase's final (clearing
    // skipNextFinal) before the new phrase's interim arrives, because
    // createRecognition invokes the handlers in this order within one
    // onresult call.
    const calls: string[] = [];
    const handlers = {
      onInterim: vi.fn((t: string) => calls.push(`interim:${t}`)),
      onFinal: vi.fn((t: string) => calls.push(`final:${t}`)),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    const recognition = createRecognition(handlers) as unknown as FakeRecognition;
    recognition.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, 0: { transcript: 'wrold' } },
        { isFinal: false, 0: { transcript: 'today' } },
      ],
    });
    expect(calls).toEqual(['final:wrold', 'interim:today']);
  });
});

describe('localStorage persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('round-trips auto-read room ids', () => {
    expect(loadAutoReadRoomIds()).toEqual(new Set());
    saveAutoReadRoomIds(new Set(['room-a', 'room-b']));
    expect(loadAutoReadRoomIds()).toEqual(new Set(['room-a', 'room-b']));
  });

  it('round-trips voice prefs', () => {
    expect(loadVoicePrefs()).toEqual({ rate: 1, voiceURI: null });
    saveVoicePrefs({ rate: 1.5, voiceURI: 'v2' });
    expect(loadVoicePrefs()).toEqual({ rate: 1.5, voiceURI: 'v2' });
  });

  it('falls back to defaults on corrupt JSON instead of throwing', () => {
    localStorage.setItem('agent-os:voice:settings', '{not json');
    expect(() => loadVoicePrefs()).not.toThrow();
    expect(loadVoicePrefs()).toEqual({ rate: 1, voiceURI: null });

    localStorage.setItem('agent-os:voice:auto-read-rooms', '{not json');
    expect(() => loadAutoReadRoomIds()).not.toThrow();
    expect(loadAutoReadRoomIds()).toEqual(new Set());
  });

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveAutoReadRoomIds(new Set(['x']))).not.toThrow();
    expect(() => loadAutoReadRoomIds()).not.toThrow();
    expect(loadAutoReadRoomIds()).toEqual(new Set());
  });
});
