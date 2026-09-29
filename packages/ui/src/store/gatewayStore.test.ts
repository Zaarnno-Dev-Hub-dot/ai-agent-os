import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, PollReview, ServerEvent } from '@agent-os/shared';
import { useStore } from './gatewayStore';
import { useVoiceStore } from './voiceStore';
import { getHumanToken } from '../lib/reviewPolicy';

// This package's test environment is plain 'node' (vitest.config.ts: no
// jsdom/happy-dom — "store/lib logic has no DOM dependency"), so `window`
// does not exist as a global here. lib/reviewPolicy.ts's getHumanToken()
// reads `window.__AGENT_OS_HUMAN_TOKEN__` and already guards with
// `typeof window !== 'undefined'`, but there is no `window` to SET a token
// on in this environment — mock the function itself instead (same
// resolution the voiceStore.test.ts comment describes for the speech APIs:
// "mocked as plain globals" there, mocked as a module import here). vi.mock
// calls are hoisted above imports by vitest's transform regardless of
// source position, so this is safe even though it reads as "after" the
// import above.
vi.mock('../lib/reviewPolicy', () => ({ getHumanToken: vi.fn() }));

// Captured once, before any test mutates the (module-singleton) stores — used
// to fully reset state between tests via setState(initial, true), same
// pattern as voiceStore.test.ts.
const initialState = useStore.getState();
const initialVoiceState = useVoiceStore.getState();

beforeEach(() => {
  useStore.setState(initialState, true);
  useVoiceStore.setState(initialVoiceState, true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function agentMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    roomId: 'room-a',
    senderId: 'agent-1',
    content: 'hello there',
    createdAt: Date.now(),
    ...overrides,
  };
}

function messageNew(payload: Message): ServerEvent {
  return { type: 'message.new', payload };
}

describe('applyServerEvent — message.new (baseline)', () => {
  it('appends the message to the room and clears the sender agent typing indicator', () => {
    useStore.setState({
      typing: new Map([
        ['room-a:agent-1', { agentId: 'agent-1', roomId: 'room-a', updatedAt: Date.now() }],
      ]),
    });

    useStore.getState().applyServerEvent(messageNew(agentMessage()));

    expect(useStore.getState().messages.get('room-a')?.map((m) => m.id)).toEqual(['m1']);
    expect(useStore.getState().typing.has('room-a:agent-1')).toBe(false);
  });

  it('forwards non-human messages to the voice store for auto-read handling', () => {
    const spy = vi.fn();
    vi.spyOn(useVoiceStore, 'getState').mockReturnValue({
      ...initialVoiceState,
      handleIncomingAgentMessage: spy,
    });

    useStore.getState().applyServerEvent(messageNew(agentMessage()));

    expect(spy).toHaveBeenCalledWith({
      messageId: 'm1',
      roomId: 'room-a',
      senderId: 'agent-1',
      content: 'hello there',
    });
  });

  it('does not forward human-sent messages to the voice store', () => {
    const spy = vi.fn();
    vi.spyOn(useVoiceStore, 'getState').mockReturnValue({
      ...initialVoiceState,
      handleIncomingAgentMessage: spy,
    });

    useStore.getState().applyServerEvent(messageNew(agentMessage({ id: 'm-human', senderId: 'human' })));

    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().messages.get('room-a')?.map((m) => m.id)).toEqual(['m-human']);
  });
});

describe('applyServerEvent — message.new (voice-hop throw regression, review 2026-07-09)', () => {
  it('still commits the new message to state even when the voice-store hop throws synchronously', () => {
    // Simulates an inconsistent Web Speech API implementation throwing
    // synchronously somewhere inside handleIncomingAgentMessage's call chain
    // (speechSynthesis.getVoices(), new SpeechSynthesisUtterance(), etc.).
    // Before the fix, this exception would escape applyServerEvent's set()
    // updater before `next` was returned, so the message would silently
    // never land in state.messages for this event.
    vi.spyOn(useVoiceStore, 'getState').mockReturnValue({
      ...initialVoiceState,
      handleIncomingAgentMessage: () => {
        throw new Error('speechSynthesis boom');
      },
    });

    expect(() => useStore.getState().applyServerEvent(messageNew(agentMessage({ id: 'm2' })))).not.toThrow();

    expect(useStore.getState().messages.get('room-a')?.map((m) => m.id)).toContain('m2');
  });

  it('still clears the typing indicator when the voice-store hop throws', () => {
    useStore.setState({
      typing: new Map([
        ['room-a:agent-1', { agentId: 'agent-1', roomId: 'room-a', updatedAt: Date.now() }],
      ]),
    });
    vi.spyOn(useVoiceStore, 'getState').mockReturnValue({
      ...initialVoiceState,
      handleIncomingAgentMessage: () => {
        throw new Error('speechSynthesis boom');
      },
    });

    useStore.getState().applyServerEvent(messageNew(agentMessage({ id: 'm3' })));

    expect(useStore.getState().typing.has('room-a:agent-1')).toBe(false);
  });

  it('logs the swallowed error instead of failing silently', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(useVoiceStore, 'getState').mockReturnValue({
      ...initialVoiceState,
      handleIncomingAgentMessage: () => {
        throw new Error('speechSynthesis boom');
      },
    });

    useStore.getState().applyServerEvent(messageNew(agentMessage({ id: 'm4' })));

    expect(errorSpy).toHaveBeenCalled();
  });
});

// ============================================================================
// Two-Reviewer Policy
// ============================================================================

function baseReview(overrides: Partial<PollReview> = {}): PollReview {
  return {
    id: 'r1',
    pollId: 'poll-1',
    seatId: 'ollama',
    family: 'homebrew',
    slot: 1,
    poolSizeAtSelection: 2,
    policyMode: 'mutations',
    wakeAt: 1000,
    status: 'pending',
    parseOk: false,
    ...overrides,
  };
}

describe('applyServerEvent — poll.review.updated', () => {
  it('inserts a new review into the poll\'s array', () => {
    useStore.getState().applyServerEvent({ type: 'poll.review.updated', payload: baseReview() } as unknown as ServerEvent);
    expect(useStore.getState().pollReviews.get('poll-1')).toEqual([baseReview()]);
  });

  it('upserts by review id — a later update for the SAME review replaces it in place, does not duplicate', () => {
    const store = useStore.getState();
    store.applyServerEvent({ type: 'poll.review.updated', payload: baseReview({ status: 'pending' }) } as unknown as ServerEvent);
    store.applyServerEvent({
      type: 'poll.review.updated',
      payload: baseReview({ status: 'attached', parseOk: true, verdict: 'approve' }),
    } as unknown as ServerEvent);
    const list = useStore.getState().pollReviews.get('poll-1')!;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('attached');
    expect(list[0].verdict).toBe('approve');
  });

  it('a second review for the SAME poll (different slot) is appended, not merged', () => {
    const store = useStore.getState();
    store.applyServerEvent({ type: 'poll.review.updated', payload: baseReview({ id: 'r1', slot: 1 }) } as unknown as ServerEvent);
    store.applyServerEvent({ type: 'poll.review.updated', payload: baseReview({ id: 'r2', slot: 2, seatId: 'grok-build' }) } as unknown as ServerEvent);
    expect(useStore.getState().pollReviews.get('poll-1')?.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('reviews for DIFFERENT polls stay in separate array entries', () => {
    const store = useStore.getState();
    store.applyServerEvent({ type: 'poll.review.updated', payload: baseReview({ id: 'r1', pollId: 'poll-1' }) } as unknown as ServerEvent);
    store.applyServerEvent({ type: 'poll.review.updated', payload: baseReview({ id: 'r2', pollId: 'poll-2' }) } as unknown as ServerEvent);
    expect(useStore.getState().pollReviews.get('poll-1')?.map((r) => r.id)).toEqual(['r1']);
    expect(useStore.getState().pollReviews.get('poll-2')?.map((r) => r.id)).toEqual(['r2']);
  });
});

describe('applyServerEvent — review.policy.status', () => {
  it('updates reviewPolicyMode, server-authoritative (no client prediction)', () => {
    expect(useStore.getState().reviewPolicyMode).toBe('mutations'); // default
    useStore.getState().applyServerEvent({ type: 'review.policy.status', payload: { mode: 'off' } } as unknown as ServerEvent);
    expect(useStore.getState().reviewPolicyMode).toBe('off');
    useStore.getState().applyServerEvent({ type: 'review.policy.status', payload: { mode: 'all' } } as unknown as ServerEvent);
    expect(useStore.getState().reviewPolicyMode).toBe('all');
  });
});

describe('applyServerEvent — state.sync additive pollReviews/reviewPolicy fields', () => {
  it('groups the flat pollReviews array back into a per-poll Map, and hydrates reviewPolicyMode', () => {
    const event = {
      type: 'state.sync',
      payload: {
        agents: [],
        rooms: [],
        pollReviews: [baseReview({ id: 'r1', pollId: 'poll-1' }), baseReview({ id: 'r2', pollId: 'poll-1', slot: 2 }), baseReview({ id: 'r3', pollId: 'poll-2' })],
        reviewPolicy: { mode: 'all' },
      },
    } as unknown as ServerEvent;

    useStore.getState().applyServerEvent(event);

    expect(useStore.getState().pollReviews.get('poll-1')?.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect(useStore.getState().pollReviews.get('poll-2')?.map((r) => r.id)).toEqual(['r3']);
    expect(useStore.getState().reviewPolicyMode).toBe('all');
  });

  it('a state.sync with NO pollReviews/reviewPolicy fields (pre-M3 wire shape) leaves reviewPolicyMode unchanged and clears pollReviews to empty', () => {
    useStore.getState().applyServerEvent({
      type: 'poll.review.updated',
      payload: baseReview(),
    } as unknown as ServerEvent);
    expect(useStore.getState().pollReviews.size).toBe(1);

    useStore.getState().applyServerEvent({ type: 'state.sync', payload: { agents: [], rooms: [] } } as unknown as ServerEvent);

    expect(useStore.getState().pollReviews.size).toBe(0); // full-replace-on-hydrate, same as `polls`
    expect(useStore.getState().reviewPolicyMode).toBe('mutations'); // unchanged from its prior value (falls back, not reset)
  });
});

describe('sendClientEvent — humanToken auto-attach', () => {
  // 1 = WS_OPEN (the `ws` package's and the browser WebSocket's shared
  // readyState.OPEN value — see gateway/src/wsEnvelope.ts's WS_OPEN
  // constant) — a plain literal so this doesn't depend on a global
  // WebSocket existing in this package's 'node' test environment.
  const WS_OPEN = 1;
  function fakeOpenSocket() {
    return { readyState: WS_OPEN, send: vi.fn() };
  }

  beforeEach(() => {
    vi.mocked(getHumanToken).mockReturnValue('the-real-token');
  });

  it('attaches humanToken to poll.decide payloads automatically', () => {
    const ws = fakeOpenSocket();
    useStore.setState({ ws: ws as unknown as WebSocket, connected: true });

    useStore.getState().sendClientEvent({ type: 'poll.decide', payload: { pollId: 'p1', optionId: 'approve' } } as never);

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.payload.humanToken).toBe('the-real-token');
    expect(sent.payload.pollId).toBe('p1');
  });

  it('attaches humanToken to agent.disconnect payloads automatically', () => {
    const ws = fakeOpenSocket();
    useStore.setState({ ws: ws as unknown as WebSocket, connected: true });

    useStore.getState().sendClientEvent({ type: 'agent.disconnect', payload: { agentId: 'hermes' } } as never);

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.payload.humanToken).toBe('the-real-token');
  });

  it('does NOT attach humanToken to an unrelated event type (e.g. chat.send)', () => {
    const ws = fakeOpenSocket();
    useStore.setState({ ws: ws as unknown as WebSocket, connected: true });

    useStore.getState().sendClientEvent({
      type: 'chat.send',
      payload: { roomId: 'r1', message: { role: 'user', senderId: 'human', content: 'hi' } },
    } as never);

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.payload.humanToken).toBeUndefined();
  });

  it('sends undefined (not a crash) when getHumanToken() has no token — the honest dev-mode gap', () => {
    vi.mocked(getHumanToken).mockReturnValue(undefined);
    const ws = fakeOpenSocket();
    useStore.setState({ ws: ws as unknown as WebSocket, connected: true });

    useStore.getState().sendClientEvent({ type: 'poll.decide', payload: { pollId: 'p1', optionId: 'approve' } } as never);

    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.payload.humanToken).toBeUndefined();
  });
});
