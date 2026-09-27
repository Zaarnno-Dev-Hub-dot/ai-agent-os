import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './voiceStore';
import { FakeSynth, FakeUtterance, MemoryStorage } from '../lib/speechFakes';

// Captured once, before any test mutates the (module-singleton) store — used
// to fully reset state between tests via setState(initialState, true).
const initialState = useVoiceStore.getState();

let synth: FakeSynth;

beforeEach(() => {
  useVoiceStore.setState(initialState, true);
  synth = new FakeSynth();
  vi.stubGlobal('speechSynthesis', synth as unknown as SpeechSynthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastUtterance(): FakeUtterance {
  const u = synth.spoken[synth.spoken.length - 1];
  if (!u) throw new Error('expected an utterance to have been spoken by now');
  return u;
}

describe('toggleAutoRead', () => {
  it('flips membership and persists across a fresh hydrate()', () => {
    expect(useVoiceStore.getState().autoReadRoomIds.has('room-a')).toBe(false);
    useVoiceStore.getState().toggleAutoRead('room-a');
    expect(useVoiceStore.getState().autoReadRoomIds.has('room-a')).toBe(true);

    useVoiceStore.getState().hydrate(); // simulate a fresh page load re-reading storage
    expect(useVoiceStore.getState().autoReadRoomIds.has('room-a')).toBe(true);

    useVoiceStore.getState().toggleAutoRead('room-a');
    expect(useVoiceStore.getState().autoReadRoomIds.has('room-a')).toBe(false);
  });

  it('tracks multiple rooms independently', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().toggleAutoRead('room-b');
    useVoiceStore.getState().toggleAutoRead('room-a');
    const ids = useVoiceStore.getState().autoReadRoomIds;
    expect(ids.has('room-a')).toBe(false);
    expect(ids.has('room-b')).toBe(true);
  });
});

describe('setRate / setVoiceURI', () => {
  it('clamps rate to the Web Speech API valid range', () => {
    useVoiceStore.getState().setRate(50);
    expect(useVoiceStore.getState().rate).toBe(10);
    useVoiceStore.getState().setRate(0);
    expect(useVoiceStore.getState().rate).toBeCloseTo(0.1);
  });

  it('persists rate and voiceURI so a later hydrate() sees them', () => {
    useVoiceStore.getState().setRate(1.25);
    useVoiceStore.getState().setVoiceURI('v3');
    useVoiceStore.getState().hydrate();
    expect(useVoiceStore.getState().rate).toBe(1.25);
    expect(useVoiceStore.getState().voiceURI).toBe('v3');
  });
});

describe('hydrate', () => {
  it('pulls persisted auto-read rooms and voice prefs from storage', () => {
    localStorage.setItem('agent-os:voice:auto-read-rooms', JSON.stringify(['room-x']));
    localStorage.setItem('agent-os:voice:settings', JSON.stringify({ rate: 1.75, voiceURI: 'v9' }));
    useVoiceStore.getState().hydrate();
    const state = useVoiceStore.getState();
    expect(state.autoReadRoomIds.has('room-x')).toBe(true);
    expect(state.rate).toBe(1.75);
    expect(state.voiceURI).toBe('v9');
  });
});

describe('playMessage / stopSpeaking', () => {
  it('speaks the message stripped of markdown and sets speakingMessageId', () => {
    useVoiceStore.getState().playMessage('m1', '**hello** world');
    expect(useVoiceStore.getState().speakingMessageId).toBe('m1');
    expect(lastUtterance().text).toBe('hello world');
  });

  it('a new play cancels whatever was playing ("New play cancels old")', () => {
    useVoiceStore.getState().playMessage('m1', 'first');
    useVoiceStore.getState().playMessage('m2', 'second');
    expect(synth.cancelCalls).toBeGreaterThanOrEqual(1);
    expect(useVoiceStore.getState().speakingMessageId).toBe('m2');
  });

  it('clears speakingMessageId once the utterance ends naturally', () => {
    useVoiceStore.getState().playMessage('m1', 'hello');
    lastUtterance().onend?.();
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
  });

  it('ignores a stale end callback from an utterance already superseded by a newer play', () => {
    useVoiceStore.getState().playMessage('m1', 'first');
    const firstUtterance = lastUtterance();
    useVoiceStore.getState().playMessage('m2', 'second');
    firstUtterance.onend?.(); // late/inconsistent browser callback for the OLD utterance
    expect(useVoiceStore.getState().speakingMessageId).toBe('m2');
  });

  it('stopSpeaking cancels, clears state, and drops any pending auto-read backlog', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'a1', roomId: 'room-a', senderId: 'agent', content: 'one' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'a2', roomId: 'room-a', senderId: 'agent', content: 'two' });
    expect(useVoiceStore.getState().readQueue).toHaveLength(1);

    useVoiceStore.getState().stopSpeaking();
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
    expect(useVoiceStore.getState().readQueue).toEqual([]);
    expect(synth.cancelCalls).toBeGreaterThanOrEqual(1);
  });

  it('does not crash and never gets stuck "speaking" when TTS is unsupported', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    expect(() => useVoiceStore.getState().playMessage('m1', 'hello')).not.toThrow();
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
  });
});

describe('handleIncomingAgentMessage (auto-read)', () => {
  it('ignores messages from the human sender', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'human', content: 'hi' });
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
    expect(useVoiceStore.getState().readQueue).toEqual([]);
  });

  it('ignores messages in a room whose auto-read toggle is off', () => {
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'hi' });
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
  });

  it('ignores messages while the tab is hidden', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().setTabVisible(false);
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'hi' });
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
    expect(useVoiceStore.getState().readQueue).toEqual([]);
  });

  it('ignores a message that strips down to no readable text', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({
      messageId: 'm1',
      roomId: 'room-a',
      senderId: 'agent',
      content: '```\ncode only\n```',
    });
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
    expect(useVoiceStore.getState().readQueue).toEqual([]);
  });

  it('speaks immediately when idle and the room is armed', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'hello' });
    expect(useVoiceStore.getState().speakingMessageId).toBe('m1');
    expect(lastUtterance().text).toBe('hello');
  });

  it('queues instead of interrupting when something is already speaking, then drains in FIFO order', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'one' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm2', roomId: 'room-a', senderId: 'agent', content: 'two' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm3', roomId: 'room-a', senderId: 'agent', content: 'three' });

    expect(useVoiceStore.getState().speakingMessageId).toBe('m1');
    expect(useVoiceStore.getState().readQueue.map((i) => i.messageId)).toEqual(['m2', 'm3']);

    lastUtterance().onend?.();
    expect(useVoiceStore.getState().speakingMessageId).toBe('m2');
    expect(useVoiceStore.getState().readQueue.map((i) => i.messageId)).toEqual(['m3']);

    lastUtterance().onend?.();
    expect(useVoiceStore.getState().speakingMessageId).toBe('m3');
    expect(useVoiceStore.getState().readQueue).toEqual([]);

    lastUtterance().onend?.();
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
  });

  it('drops the oldest queued item once the backlog exceeds the depth cap of 3 ("never backlog")', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'one' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm2', roomId: 'room-a', senderId: 'agent', content: 'two' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm3', roomId: 'room-a', senderId: 'agent', content: 'three' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm4', roomId: 'room-a', senderId: 'agent', content: 'four' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm5', roomId: 'room-a', senderId: 'agent', content: 'five' });

    expect(useVoiceStore.getState().speakingMessageId).toBe('m1');
    expect(useVoiceStore.getState().readQueue.map((i) => i.messageId)).toEqual(['m3', 'm4', 'm5']);
    expect(useVoiceStore.getState().readQueue.length).toBeLessThanOrEqual(3);
  });

  it('a manual play interrupts an in-progress auto-read item, which resumes once the manual play ends', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'one' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm2', roomId: 'room-a', senderId: 'agent', content: 'two' });
    expect(useVoiceStore.getState().speakingMessageId).toBe('m1');

    useVoiceStore.getState().playMessage('manual-1', 'a manual replay');
    expect(useVoiceStore.getState().speakingMessageId).toBe('manual-1');
    expect(useVoiceStore.getState().readQueue.map((i) => i.messageId)).toEqual(['m2']);

    lastUtterance().onend?.();
    expect(useVoiceStore.getState().speakingMessageId).toBe('m2');
  });

  it('pauses draining while the tab is hidden and resumes once visible again', () => {
    useVoiceStore.getState().toggleAutoRead('room-a');
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm1', roomId: 'room-a', senderId: 'agent', content: 'one' });
    useVoiceStore.getState().handleIncomingAgentMessage({ messageId: 'm2', roomId: 'room-a', senderId: 'agent', content: 'two' });

    useVoiceStore.getState().setTabVisible(false);
    lastUtterance().onend?.(); // m1 ends while hidden
    expect(useVoiceStore.getState().speakingMessageId).toBeNull();
    expect(useVoiceStore.getState().readQueue.map((i) => i.messageId)).toEqual(['m2']); // still queued, not dropped

    useVoiceStore.getState().setTabVisible(true);
    expect(useVoiceStore.getState().speakingMessageId).toBe('m2'); // resumed
  });
});

describe('micPermissionDenied', () => {
  it('can be set and read back (in-memory only — hydrate() never touches it)', () => {
    expect(useVoiceStore.getState().micPermissionDenied).toBe(false);
    useVoiceStore.getState().setMicPermissionDenied(true);
    expect(useVoiceStore.getState().micPermissionDenied).toBe(true);
    useVoiceStore.getState().hydrate();
    expect(useVoiceStore.getState().micPermissionDenied).toBe(true);
  });
});
