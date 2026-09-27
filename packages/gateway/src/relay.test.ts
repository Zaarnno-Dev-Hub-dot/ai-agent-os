import { describe, expect, it } from 'vitest';
import type { AgentSession, AgentState, Message, Room, ServerEvent } from '@agent-os/shared';
import type { RelayDeps } from './relay.js';
import { registerAgentRelay, relayMessageToAgents, resolveRelayTargets, unregisterAgentRelay } from './relay.js';

/**
 * Mention resolution over multi-instance seat ids
 * (docs/DESIGN-multi-instance.md): `@claude-code#work` must be a single
 * mention token routing ONLY to that seat, while bare aliases (`@claude`,
 * `@fable`) keep resolving to the `main` seat (`claude-code`) per the design
 * note's back-compat requirement.
 */

function makeRoom(memberIds: string[]): Room {
  return {
    id: 'room-1',
    name: 'Test Room',
    type: 'group',
    memberIds,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: 12,
  };
}

function verifiedState(): AgentState {
  return {
    manifest: {
      id: 'claude-code',
      displayName: 'Claude Code',
      harness: 'claude-code',
      flavor: 'cli-stream',
      avatar: '✦',
      color: '#d97757',
      capabilities: [],
      identity: { modelPattern: '^claude' },
      trust: 'full',
      manifestVersion: 1,
    },
    config: { transport: {} },
    status: 'VERIFIED',
    session: {} as AgentSession, // resolveRelayTargets only checks truthiness
    lastHeartbeat: Date.now(),
    assignedRooms: ['room-1'],
    challengeHistory: [],
  };
}

function makeDeps(agentIds: string[]): RelayDeps {
  const agents = new Map<string, AgentState>();
  for (const id of agentIds) agents.set(id, verifiedState());
  return {
    db: {} as RelayDeps['db'],
    dataDir: '/tmp/unused',
    agents,
    rooms: new Map(),
    messages: new Map(),
    roomRelay: new Map(),
    globalCost: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} },
    broadcast: (_event: ServerEvent) => undefined,
    agentDisplayName: (agentId: string) => agentId,
  };
}

function humanMessage(content: string, mentions?: string[]): Message {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'human',
    content,
    mentions,
    createdAt: Date.now(),
  };
}

describe('resolveRelayTargets — multi-instance seat mentions', () => {
  it('routes @claude-code#test to ONLY that seat when both main and the seat are in the room', () => {
    const deps = makeDeps(['claude-code', 'claude-code#test']);
    const room = makeRoom(['human', 'claude-code', 'claude-code#test']);
    const msg = humanMessage('hey @claude-code#test can you check this');

    const targets = resolveRelayTargets(deps, room, msg);

    expect(targets).toEqual(['claude-code#test']);
  });

  it('routes @claude-code (bare) to ONLY the main seat, not the #test seat', () => {
    const deps = makeDeps(['claude-code', 'claude-code#test']);
    const room = makeRoom(['human', 'claude-code', 'claude-code#test']);
    const msg = humanMessage('hey @claude-code look at this');

    const targets = resolveRelayTargets(deps, room, msg);

    expect(targets).toEqual(['claude-code']);
  });

  it('keeps bare aliases (@claude) resolving to the main seat, not any instance', () => {
    const deps = makeDeps(['claude-code', 'claude-code#test']);
    const room = makeRoom(['human', 'claude-code', 'claude-code#test']);

    const claude = resolveRelayTargets(deps, room, humanMessage('@claude take a look'));

    expect(claude).toEqual(['claude-code']);
  });

  it('@everyone still fans out to BOTH seats of the same harness', () => {
    const deps = makeDeps(['claude-code', 'claude-code#test']);
    const room = makeRoom(['human', 'claude-code', 'claude-code#test']);
    const msg = humanMessage('@everyone status check please');

    const targets = resolveRelayTargets(deps, room, msg);

    expect(new Set(targets)).toEqual(new Set(['claude-code', 'claude-code#test']));
  });

  it('parses a #-suffixed mention as ONE token, not split at the hash', () => {
    // If the regex failed to include '#', "@claude-code" and a bare
    // "#test" would either mis-parse or drop the seat entirely; asserting
    // the full seat id is the resolved target proves it parsed as one unit.
    const deps = makeDeps(['claude-code#test']);
    const room = makeRoom(['human', 'claude-code#test']);
    const msg = humanMessage('ping @claude-code#test, you there?');

    const targets = resolveRelayTargets(deps, room, msg);

    expect(targets).toEqual(['claude-code#test']);
  });

  it('also resolves a seat mention supplied via the mentions field (not just content)', () => {
    const deps = makeDeps(['claude-code#test']);
    const room = makeRoom(['human', 'claude-code#test']);
    const msg = humanMessage('no @ in the text', ['claude-code#test']);

    const targets = resolveRelayTargets(deps, room, msg);

    expect(targets).toEqual(['claude-code#test']);
  });

  it('an unverified/unknown seat mention resolves to no targets', () => {
    const deps = makeDeps(['claude-code']);
    const room = makeRoom(['human', 'claude-code']);
    const msg = humanMessage('@claude-code#ghost are you real');

    const targets = resolveRelayTargets(deps, room, msg);

    expect(targets).toEqual([]);
  });
});

/**
 * Q8 (2026-07-14, Fable-approved frozen-zone exception, TOP-TIER-QUEUE.md):
 * relayMessageToAgents's single delivery-failure catch used to be
 * console.error-only, so a wedged/erroring turn was invisible to every WS
 * client (root cause of the Z4-ratify Convene-Panel no-shows,
 * Reports\2026-07-14-W2-G-convene-noshow.md). This pins the fix: the catch
 * now also broadcasts a type:'error' ServerEvent with room/agent
 * attribution folded into the message text.
 *
 * Q8b (2026-07-21, Fable-approved narrow amendment to Q8, same catch block
 * only): the broadcast used to embed e.message verbatim, which leaked raw
 * adapter/OS error text — including absolute filesystem paths — to every
 * WS client. This updates the pin: the broadcast message now carries only
 * a sanitized short form (error class/name + truncated, path-redacted
 * message), and raw path-like substrings must never appear in it. The full
 * raw detail is still expected in the server-side console.error only.
 *
 * M11 (2026-07-21 review-panel finding, same Q8b catch-block-only scope):
 * PATH_LIKE alone missed non-path secrets — internal IP:port, bearer
 * tokens, key=value pairs, single-segment refs — and errorName was
 * attacker-settable (custom Error subclasses can set `.name`) with neither
 * cap nor scrub. This extends the pin to cover those redactors and the
 * errorName scrub.
 */
describe('relayMessageToAgents — delivery-failure broadcast (Q8, sanitized per Q8b)', () => {
  it('broadcasts a sanitized type:"error" ServerEvent with room/agent attribution when delivery fails', async () => {
    const deps = makeDeps(['claude-code']);
    const room = makeRoom(['human', 'claude-code']);
    deps.rooms.set(room.id, room);

    const broadcasts: ServerEvent[] = [];
    deps.broadcast = (event: ServerEvent) => {
      broadcasts.push(event);
    };

    // Fakes the "raw session.send() throw" delivery-failure class (one of
    // the three failure paths the report documents as funneling into this
    // one catch — the others are the in-band AgentEvent 'error' and the
    // TURN_WATCHDOG_MS timeout, both of which also resolve through the same
    // worker.enqueue() rejection this test exercises). The message
    // deliberately embeds an absolute path, mirroring the real adapter/OS
    // errors (ENOENT and friends) that motivated Q8b.
    const rawPath = 'C:\\Users\\dev\\secret\\config.json';
    const failingSession = {
      send: () =>
        Promise.reject(new Error(`ENOENT: no such file or directory, open '${rawPath}'`)),
      events: async function* () {
        /* no events */
      },
    } as AgentSession;

    registerAgentRelay('claude-code', failingSession, deps, 'full');
    try {
      relayMessageToAgents(deps, room.id, humanMessage('@claude-code please check this'));

      // Let the send()-reject -> job.settle -> enqueue()-reject -> .catch
      // microtask chain flush before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const errorEvents = broadcasts.filter(
        (e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error'
      );
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].payload.code).toBe('relay.delivery-failed');
      expect(errorEvents[0].payload.recoverable).toBe(true);
      expect(errorEvents[0].payload.message).toContain('claude-code');
      expect(errorEvents[0].payload.message).toContain(room.name);
      // Sanitized shape: error class/name is present...
      expect(errorEvents[0].payload.message).toContain('Error');
      // ...but the raw path must NOT survive into the broadcast.
      expect(errorEvents[0].payload.message).not.toContain(rawPath);
      expect(errorEvents[0].payload.message).not.toContain('secret');
      expect(errorEvents[0].payload.message).not.toContain('config.json');
      expect(errorEvents[0].payload.message).toContain('[path]');
    } finally {
      unregisterAgentRelay('claude-code');
    }
  });
});

/**
 * Shared harness for the M11 redactor tests below: registers a failing
 * session whose send() rejects with the given error, drives one relay turn,
 * and returns the sanitized broadcast message text.
 */
async function deliveryFailureMessage(error: Error): Promise<string> {
  const deps = makeDeps(['claude-code']);
  const room = makeRoom(['human', 'claude-code']);
  deps.rooms.set(room.id, room);

  const broadcasts: ServerEvent[] = [];
  deps.broadcast = (event: ServerEvent) => {
    broadcasts.push(event);
  };

  const failingSession = {
    send: () => Promise.reject(error),
    events: async function* () {
      /* no events */
    },
  } as AgentSession;

  registerAgentRelay('claude-code', failingSession, deps, 'full');
  try {
    relayMessageToAgents(deps, room.id, humanMessage('@claude-code please check this'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const errorEvents = broadcasts.filter(
      (e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error'
    );
    expect(errorEvents).toHaveLength(1);
    return errorEvents[0].payload.message;
  } finally {
    unregisterAgentRelay('claude-code');
  }
}

// M11 (2026-07-21 review-panel finding, same Q8b catch-block-only scope):
// PATH_LIKE alone let non-path secrets through the 80-char broadcast window
// verbatim. These pin the additional redactors + the errorName cap/scrub.
describe('relayMessageToAgents — delivery-failure broadcast redactors (M11)', () => {
  it('redacts an internal IP:port (e.g. a backend connection refused)', async () => {
    const message = await deliveryFailureMessage(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
    expect(message).not.toContain('10.0.0.5');
    expect(message).not.toContain('6379');
    expect(message).toContain('[addr]');
  });

  it('redacts a Bearer token', async () => {
    const message = await deliveryFailureMessage(
      new Error('request failed: Bearer sk-live-abc123XYZ789 rejected')
    );
    expect(message).not.toContain('sk-live-abc123XYZ789');
    expect(message).toContain('[token]');
  });

  it('redacts a key=value secret regardless of whether the key name suggests "secret"', async () => {
    const message = await deliveryFailureMessage(
      new Error('auth failed, apiKey=zzT9v2Lm4Qh8pRw1 rejected by upstream')
    );
    expect(message).not.toContain('zzT9v2Lm4Qh8pRw1');
    expect(message).toContain('[redacted]');
  });

  it('redacts a single-segment absolute path ("/etc"), not just multi-segment ones', async () => {
    const message = await deliveryFailureMessage(new Error("EACCES: permission denied, open '/etc'"));
    expect(message).not.toContain('/etc');
    expect(message).toContain('[path]');
  });

  it('caps an attacker-controlled error class name so an unbounded string cannot ride along uncapped', async () => {
    class LongNameError extends Error {}
    Object.defineProperty(LongNameError, 'name', { value: 'A'.repeat(500) });
    const message = await deliveryFailureMessage(new LongNameError('boom'));
    expect(message).not.toContain('A'.repeat(41));
  });

  it('scrubs non-word characters out of an attacker-controlled error class name (no raw markup/punctuation survives)', async () => {
    class InjectError extends Error {}
    Object.defineProperty(InjectError, 'name', { value: '<script>alert(1)</script>' });
    const message = await deliveryFailureMessage(new InjectError('boom'));
    expect(message).not.toContain('<script>');
    expect(message).not.toContain('alert(1)');
  });
});
