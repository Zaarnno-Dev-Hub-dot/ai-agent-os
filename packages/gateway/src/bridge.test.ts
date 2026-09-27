import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  AgentEvent,
  AgentSession,
  AgentState,
  CostReport,
  Message,
  Room,
  ServerEvent,
} from '@agent-os/shared';
import type { SqlDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { RelayDeps, RoomRelayState } from './relay.js';
import { registerAgentRelay, relayMessageToAgents, unregisterAgentRelay } from './relay.js';
import { BridgeIdempotencyStore, BridgeWaitRegistry, registerBridgeRoute } from './bridge.js';
import type { LoopsConfig } from './loop.js';

/**
 * End-to-end tests for POST /api/bridge/wake (F2a). A REAL Fastify instance
 * on an EPHEMERAL port (never 4110 — the live gateway is never touched), a
 * real sql.js db in a fresh temp dir per test, and fake AgentSessions
 * registered via relay.ts's own exported registerAgentRelay — the same
 * registration path agents.ts uses for a real adapter connection. Delivery
 * therefore exercises the REAL relayMessageToAgents / AgentRelayWorker /
 * commitAgentReply path, not a mock of it.
 */

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-test-'));
}

function manifestFor(id: string): AgentState['manifest'] {
  return {
    id,
    displayName: id,
    harness: 'hermes',
    flavor: 'cli-stream',
    avatar: '✦',
    color: '#000',
    capabilities: [],
    identity: { modelPattern: '^test' },
    trust: 'full',
    manifestVersion: 1,
    billing: { kind: 'local' },
  };
}

/** A fake AgentSession whose events() is driven externally via `emit`. Mirrors the shape real adapters implement. */
class FakeSession implements AgentSession {
  private queue: AgentEvent[] = [];
  private waiters: ((ev: AgentEvent) => void)[] = [];
  public sent: unknown[] = [];
  public sendImpl: ((msg: Parameters<AgentSession['send']>[0]) => void) | null = null;

  async send(msg: Parameters<AgentSession['send']>[0]): Promise<void> {
    this.sent.push(msg);
    this.sendImpl?.(msg);
  }

  emit(ev: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev);
    else this.queue.push(ev);
  }

  async *events(): AsyncIterable<AgentEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      const ev = await new Promise<AgentEvent>((resolve) => this.waiters.push(resolve));
      yield ev;
    }
  }

  async prove(): Promise<never> {
    throw new Error('not used in tests');
  }
  async health() {
    return { ok: true, latencyMs: 1, modelId: 'test', sessionAgeMs: 0 };
  }
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function verifiedState(id: string, session: AgentSession): AgentState {
  return {
    manifest: manifestFor(id),
    config: { transport: {} },
    status: 'VERIFIED',
    session,
    lastHeartbeat: Date.now(),
    assignedRooms: [],
    challengeHistory: [],
  };
}

interface Harness {
  fastify: FastifyInstance;
  baseUrl: string;
  db: SqlDatabase;
  dataDir: string;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  loopsConfig: LoopsConfig;
  broadcastedEvents: ServerEvent[];
  sessions: Map<string, FakeSession>;
  relayDeps: RelayDeps;
}

async function buildHarness(): Promise<Harness> {
  const dataDir = freshDataDir();
  const db = await openDatabase(dataDir);
  const agents = new Map<string, AgentState>();
  const rooms = new Map<string, Room>();
  const messages = new Map<string, Message[]>();
  const roomRelay = new Map<string, RoomRelayState>();
  const loopsConfig: LoopsConfig = {};
  const globalCost: CostReport = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
  const broadcastedEvents: ServerEvent[] = [];
  const sessions = new Map<string, FakeSession>();

  const idempotency = new BridgeIdempotencyStore();
  const waits = new BridgeWaitRegistry();

  const busySeats = new Set<string>();
  function markBusy(ids: Iterable<string>): void {
    for (const id of ids) busySeats.add(id);
  }

  function broadcast(event: ServerEvent): void {
    broadcastedEvents.push(event);
    if (event.type === 'message.new') {
      const msg = (event as unknown as { payload: Message }).payload;
      waits.observe(msg.roomId, msg.senderId, {
        messageId: msg.id,
        text: msg.content,
        senderId: msg.senderId,
        ts: msg.createdAt,
        replyTo: msg.replyTo,
      });
    }
  }

  const relayDeps: RelayDeps = {
    db,
    dataDir,
    agents,
    rooms,
    messages,
    roomRelay,
    globalCost,
    broadcast,
    agentDisplayName: (id) => agents.get(id)?.manifest.displayName ?? id,
  };

  function persistRoomMutation(room: Room): void {
    rooms.set(room.id, room);
    broadcast({ type: 'room.updated', payload: room } as unknown as ServerEvent);
  }

  const fastify = Fastify({ logger: false });
  registerBridgeRoute(fastify, {
    relayDeps,
    agents,
    rooms,
    messages,
    db,
    dataDir,
    defaultRoomTurnCap: 12,
    loopsConfig,
    idempotency,
    waits,
    broadcast,
    markBusy,
    persistRoomMutation,
  });

  const address = await fastify.listen({ port: 0, host: '127.0.0.1' });

  return {
    fastify,
    baseUrl: address,
    db,
    dataDir,
    agents,
    rooms,
    messages,
    loopsConfig,
    broadcastedEvents,
    sessions,
    relayDeps,
  };
}

/**
 * Register a VERIFIED seat with a fake, externally-drivable session (real
 * registerAgentRelay wiring) — using the SAME relayDeps/broadcast the
 * harness's bridge route was built with, so the worker's message.new
 * broadcast (commitAgentReply) is observed by the SAME BridgeWaitRegistry
 * the route registered its wait against, exactly as in the real gateway
 * (one broadcast() function, one set of listeners).
 */
function addSeat(h: Harness, seatId: string): FakeSession {
  const session = new FakeSession();
  h.agents.set(seatId, verifiedState(seatId, session));
  registerAgentRelay(seatId, session, h.relayDeps, 'full');
  h.sessions.set(seatId, session);
  return session;
}

function makeRoom(id: string, name: string, memberIds: string[]): Room {
  return {
    id,
    name,
    type: 'group',
    memberIds,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: 12,
  };
}

async function post(baseUrl: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/bridge/wake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

describe('POST /api/bridge/wake', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  it('happy path: seat replies -> 200 with the reply', async () => {
    const session = addSeat(h, 'hermes');

    // Real relay delivery calls session.send(); react to it as the fake seat.
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'Hello from hermes', messageId: 'x' });
        session.emit({ type: 'message-complete', messageId: 'x' });
      }, 5);
    };

    const promise = post(h.baseUrl, {
      seatId: 'hermes',
      prompt: 'please pick up ticket #42',
      idempotencyKey: 'k-happy-1',
    });

    const { status, json } = await promise;
    expect(status).toBe(200);
    expect(json.roomId).toBeTruthy();
    expect(json.reply.senderId).toBe('hermes');
    expect(json.reply.text).toBe('Hello from hermes');
    expect(typeof json.reply.messageId).toBe('string');
    expect(typeof json.reply.ts).toBe('number');
  });

  it('find-or-creates a room named "Paperclip — <seatId>" and reuses it by exact name on a later wake', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'ack1', messageId: 'm1' });
        session.emit({ type: 'message-complete', messageId: 'm1' });
      }, 5);
    };

    const first = await post(h.baseUrl, {
      seatId: 'hermes',
      prompt: 'first wake',
      idempotencyKey: 'k-room-1',
    });
    expect(first.status).toBe(200);
    const roomId = first.json.roomId;
    const room = h.rooms.get(roomId);
    expect(room?.name).toBe('Paperclip — hermes');

    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'ack2', messageId: 'm2' });
        session.emit({ type: 'message-complete', messageId: 'm2' });
      }, 5);
    };
    const second = await post(h.baseUrl, {
      seatId: 'hermes',
      prompt: 'second wake',
      idempotencyKey: 'k-room-2',
    });
    expect(second.status).toBe(200);
    expect(second.json.roomId).toBe(roomId);
    expect(h.rooms.size).toBe(1);
  });

  it('timeout path: 408 with timedOut:true and stops observing (no dangling listener resolves it later)', async () => {
    const session = addSeat(h, 'hermes');
    // Seat never replies within the timeout.
    session.sendImpl = () => {};

    const { status, json } = await post(h.baseUrl, {
      seatId: 'hermes',
      prompt: 'never answered',
      idempotencyKey: 'k-timeout-1',
      timeoutMs: 50,
    });

    expect(status).toBe(408);
    expect(json.timedOut).toBe(true);
    expect(json.roomId).toBeTruthy();

    // A late reply after the timeout must not throw / must not resurrect the wait.
    session.emit({ type: 'token', delta: 'too late', messageId: 'late' });
    session.emit({ type: 'message-complete', messageId: 'late' });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('unverified seat -> 404 { error: "seat_unverified" }', async () => {
    // Not registered at all.
    const res1 = await post(h.baseUrl, {
      seatId: 'ghost',
      prompt: 'hi',
      idempotencyKey: 'k-unverified-1',
    });
    expect(res1.status).toBe(404);
    expect(res1.json.error).toBe('seat_unverified');

    // Registered but not VERIFIED.
    h.agents.set('half-connected', {
      manifest: manifestFor('half-connected'),
      config: { transport: {} },
      status: 'CHALLENGED',
      lastHeartbeat: Date.now(),
      assignedRooms: [],
      challengeHistory: [],
    });
    const res2 = await post(h.baseUrl, {
      seatId: 'half-connected',
      prompt: 'hi',
      idempotencyKey: 'k-unverified-2',
    });
    expect(res2.status).toBe(404);
    expect(res2.json.error).toBe('seat_unverified');
  });

  it('idempotent replay after completion returns the SAME stored result without waking the seat again', async () => {
    const session = addSeat(h, 'hermes');
    let sendCount = 0;
    session.sendImpl = () => {
      sendCount += 1;
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'first reply', messageId: 'm-idem' });
        session.emit({ type: 'message-complete', messageId: 'm-idem' });
      }, 5);
    };

    const key = 'k-idem-1';
    const first = await post(h.baseUrl, { seatId: 'hermes', prompt: 'do the thing', idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(sendCount).toBe(1);

    const second = await post(h.baseUrl, { seatId: 'hermes', prompt: 'do the thing', idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.json.reply.messageId).toBe(first.json.reply.messageId);
    expect(second.json.reply.text).toBe(first.json.reply.text);
    // The seat's session.send was NOT invoked again for the replay.
    expect(sendCount).toBe(1);
  });

  it('a replay while the original call is still in-flight attaches to the SAME wait (single seat wake, both callers get the one reply)', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'shared reply', messageId: 'm-inflight' });
        session.emit({ type: 'message-complete', messageId: 'm-inflight' });
      }, 30);
    };

    const key = 'k-inflight-1';
    const p1 = post(h.baseUrl, { seatId: 'hermes', prompt: 'shared', idempotencyKey: key });
    // Fire the replay shortly after, while the first is still waiting.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = post(h.baseUrl, { seatId: 'hermes', prompt: 'shared', idempotencyKey: key });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.reply.messageId).toBe(r2.json.reply.messageId);
  });

  it('mention-gating: a second seat in the room does NOT get woken by the bridge wake', async () => {
    const target = addSeat(h, 'hermes');
    const bystander = addSeat(h, 'grok-build');

    target.sendImpl = () => {
      setTimeout(() => {
        target.emit({ type: 'token', delta: 'only me', messageId: 'm-target' });
        target.emit({ type: 'message-complete', messageId: 'm-target' });
      }, 5);
    };
    let bystanderCalled = false;
    bystander.sendImpl = () => {
      bystanderCalled = true;
    };

    // Pre-create the shared room with BOTH seats as members so resolveRelayTargets
    // has both available, and assert only the addressed one is targeted.
    const roomId = 'room-both';
    h.rooms.set(roomId, makeRoom(roomId, 'Shared Room', ['human', 'hermes', 'grok-build']));

    const { status, json } = await post(h.baseUrl, {
      seatId: 'hermes',
      roomId,
      prompt: 'only hermes should wake',
      idempotencyKey: 'k-mention-1',
    });

    expect(status).toBe(200);
    expect(json.reply.senderId).toBe('hermes');
    expect(bystander.sent.length).toBe(0);
    expect(bystanderCalled).toBe(false);
  });

  it('room guard: an active loop on the target room -> 409', async () => {
    addSeat(h, 'hermes');
    const roomId = 'room-loop';
    h.rooms.set(roomId, makeRoom(roomId, 'Loop Room', ['human', 'hermes']));
    h.loopsConfig[roomId] = {
      builderSeat: 'hermes',
      judgeSeat: 'grok-build',
      maxRounds: 6,
      active: true,
      round: 0,
      phase: 'awaiting-builder',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    const { status, json } = await post(h.baseUrl, {
      seatId: 'hermes',
      roomId,
      prompt: 'blocked by loop',
      idempotencyKey: 'k-loop-1',
    });

    expect(status).toBe(409);
    expect(json.error).toBeTruthy();
  });

  it('400s when roomId is given but the seat is not a member', async () => {
    addSeat(h, 'hermes');
    const roomId = 'room-no-member';
    h.rooms.set(roomId, makeRoom(roomId, 'Not A Member Room', ['human']));

    const { status, json } = await post(h.baseUrl, {
      seatId: 'hermes',
      roomId,
      prompt: 'hi',
      idempotencyKey: 'k-notmember-1',
    });

    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('400s when a roomId is given but does not exist', async () => {
    addSeat(h, 'hermes');
    const { status } = await post(h.baseUrl, {
      seatId: 'hermes',
      roomId: 'does-not-exist',
      prompt: 'hi',
      idempotencyKey: 'k-noroom-1',
    });
    expect(status).toBe(400);
  });

  it('400s on a malformed body (missing required fields)', async () => {
    const { status } = await post(h.baseUrl, { seatId: 'hermes' });
    expect(status).toBe(400);
  });
});

describe('REGRESSION (review findings, wave3/f2a): concurrent wakes + mention injection', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  it('B7 (2026-07-21, single-flight removed): a second concurrent wake to the same seat+room no longer 409s — it queues behind the first (normal per-agent serialization) and resolves off its OWN replyTo once the seat gets to it', async () => {
    const session = addSeat(h, 'hermes');
    let sendCount = 0;
    session.sendImpl = () => {
      sendCount += 1;
      const n = sendCount;
      setTimeout(() => {
        session.emit({ type: 'token', delta: `reply ${n}`, messageId: `m-race-${n}` });
        session.emit({ type: 'message-complete', messageId: `m-race-${n}` });
      }, 15);
    };

    const p1 = post(h.baseUrl, { seatId: 'hermes', prompt: 'first concurrent wake', idempotencyKey: 'k-race-1' });
    await new Promise((r) => setTimeout(r, 5));
    // Distinct idempotencyKey = a genuinely different caller. Pre-B7 this
    // 409'd (wake_in_flight); post-B7 it is accepted — relay.ts's per-agent
    // worker queues it FIFO behind the first turn, and it resolves off its
    // own bridge message's id (stamped as replyTo on the seat's reply),
    // never the first caller's.
    const p2 = post(h.baseUrl, { seatId: 'hermes', prompt: 'second concurrent wake', idempotencyKey: 'k-race-2' });

    // A replay of the FIRST wake (same idempotencyKey) still attaches to the
    // in-flight wait rather than queueing a THIRD job.
    const replay = post(h.baseUrl, { seatId: 'hermes', prompt: 'first concurrent wake', idempotencyKey: 'k-race-1' });

    const [r1, r2, rReplay] = await Promise.all([p1, p2, replay]);
    expect(r1.status).toBe(200);
    expect(r1.json.reply.text).toBe('reply 1');
    expect(r2.status).toBe(200);
    expect(r2.json.reply.text).toBe('reply 2'); // the seat's SECOND turn, not a 409
    expect(rReplay.status).toBe(200);
    expect(rReplay.json.reply.messageId).toBe(r1.json.reply.messageId);
    expect(sendCount).toBe(2); // both distinct wakes reached the seat; the replay did not
  });

  it('scoped correctly per (roomId, seatId): same seat in two rooms, and two seats in one room, wake concurrently', async () => {
    const hermes = addSeat(h, 'hermes');
    const grok = addSeat(h, 'grok-build');
    for (const [session, tag] of [[hermes, 'hermes'], [grok, 'grok']] as const) {
      let n = 0;
      session.sendImpl = () => {
        n += 1;
        const id = `m-scope-${tag}-${n}`;
        setTimeout(() => {
          session.emit({ type: 'token', delta: `${tag} reply ${n}`, messageId: id });
          session.emit({ type: 'message-complete', messageId: id });
        }, 15);
      };
    }
    h.rooms.set('room-a', makeRoom('room-a', 'Room A', ['human', 'hermes', 'grok-build']));
    h.rooms.set('room-b', makeRoom('room-b', 'Room B', ['human', 'hermes']));

    const [rA1, rB, rA2] = await Promise.all([
      post(h.baseUrl, { seatId: 'hermes', roomId: 'room-a', prompt: 'a', idempotencyKey: 'k-scope-1' }),
      post(h.baseUrl, { seatId: 'hermes', roomId: 'room-b', prompt: 'b', idempotencyKey: 'k-scope-2' }),
      post(h.baseUrl, { seatId: 'grok-build', roomId: 'room-a', prompt: 'c', idempotencyKey: 'k-scope-3' }),
    ]);
    expect(rA1.status).toBe(200);
    expect(rB.status).toBe(200);
    expect(rA2.status).toBe(200);
  });

  it('B7 (2026-07-21): two truly-simultaneous wakes to the same seat+room — fired with zero delay via Promise.all, no setTimeout stagger — BOTH succeed and never swap replies', async () => {
    const session = addSeat(h, 'hermes');
    let sendCount = 0;
    session.sendImpl = () => {
      sendCount += 1;
      const n = sendCount;
      setTimeout(() => {
        session.emit({ type: 'token', delta: `race reply ${n}`, messageId: `m-truerace-${n}` });
        session.emit({ type: 'message-complete', messageId: `m-truerace-${n}` });
      }, 10);
    };

    // No await, no setTimeout stagger between these two — they race the
    // route handler's register-then-enqueue on the same tick. Pre-B7 this
    // 409'd one of them (hasPending-check-then-register atomicity); post-B7
    // there is no such guard to race — both register their OWN wait keyed to
    // their OWN bridge message id, and relay.ts's per-agent worker queues
    // both turns FIFO regardless.
    const [rFirst, rSecond] = await Promise.all([
      post(h.baseUrl, { seatId: 'hermes', prompt: 'caller A', idempotencyKey: 'k-truerace-A' }),
      post(h.baseUrl, { seatId: 'hermes', prompt: 'caller B', idempotencyKey: 'k-truerace-B' }),
    ]);

    // Both callers get through — no 409, no dropped caller.
    expect(rFirst.status).toBe(200);
    expect(rSecond.status).toBe(200);
    // Never swapped: each reply's messageId is unique and each caller's text
    // corresponds to a distinct underlying seat turn (never the SAME turn
    // answering both, which would be the cross-wired-reply bug this pins).
    expect(rFirst.json.reply.messageId).not.toBe(rSecond.json.reply.messageId);
    const texts = [rFirst.json.reply.text, rSecond.json.reply.text].sort();
    expect(texts).toEqual(['race reply 1', 'race reply 2']);
    // Both wakes actually reached the seat as two distinct turns (serialized
    // by relay.ts's per-agent worker, not by the bridge's own single-flight
    // guard, which no longer exists).
    expect(sendCount).toBe(2);
  });

  it('mention injection: a prompt containing another verified seat\'s @id (and @all) never wakes the bystander', async () => {
    const target = addSeat(h, 'hermes');
    const bystander = addSeat(h, 'grok-build');

    target.sendImpl = () => {
      setTimeout(() => {
        target.emit({ type: 'token', delta: 'target only', messageId: 'm-inject' });
        target.emit({ type: 'message-complete', messageId: 'm-inject' });
      }, 5);
    };
    let bystanderCalled = false;
    bystander.sendImpl = () => {
      bystanderCalled = true;
    };

    const roomId = 'room-inject';
    h.rooms.set(roomId, makeRoom(roomId, 'Injection Room', ['human', 'hermes', 'grok-build']));

    const { status, json } = await post(h.baseUrl, {
      seatId: 'hermes',
      roomId,
      prompt: 'please coordinate with @grok-build on this, and tell @all about it',
      idempotencyKey: 'k-inject-1',
    });

    expect(status).toBe(200);
    expect(json.reply.senderId).toBe('hermes');
    // The original bug: relay.ts's content-based mention scanner picked the
    // raw '@grok-build' out of the prompt text and woke the bystander too.
    expect(bystander.sent.length).toBe(0);
    expect(bystanderCalled).toBe(false);

    // The persisted bridge message carries the NEUTRALIZED prompt: '@' and
    // 'grok-build' separated by a zero-width space, so the text still reads
    // naturally but no longer matches the mention pattern.
    const zwsp = String.fromCharCode(0x200b);
    const bridgeMsg = (h.messages.get(roomId) ?? []).find((m) => m.senderId === 'paperclip-bridge');
    expect(bridgeMsg?.content).toContain(`@${zwsp}grok-build`);
    expect(bridgeMsg?.content).toContain(`@${zwsp}all`);
    expect(bridgeMsg?.content.startsWith('@hermes ')).toBe(true);
  });
});

/**
 * B7 (TOP-TIER-QUEUE.md, design 2026-07-09, landed 2026-07-21): end-to-end
 * regressions for the two residual holes fix/bridge-wake-single-flight
 * @21e9dcc documented as unfixable while relay.ts stayed frozen. Both drive
 * the REAL relay.ts/bridge.ts pipeline (same harness as the rest of this
 * file) — not a unit test of BridgeWaitRegistry in isolation.
 */
describe('B7 — closes the two residual holes (real relay.ts + bridge.ts pipeline)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  it('hole 1: a reply triggered by a NON-bridge mention in the same room does not resolve the pending bridge wait', async () => {
    const session = addSeat(h, 'hermes');
    const roomId = 'room-hole1';
    h.rooms.set(roomId, makeRoom(roomId, 'Hole 1 Room', ['human', 'hermes']));

    // Manual, per-call control: nothing auto-emits. The test drives exactly
    // when each queued turn "completes" so it can assert what has (and has
    // not) resolved in between.
    session.sendImpl = () => {};

    // Job A: an ordinary room mention, NOT through the bridge — queued and
    // dispatched first (worker is idle).
    const mentionMsg: Message = {
      id: 'msg-nonbridge-trigger',
      roomId,
      senderId: 'human',
      content: '@hermes take a look at this, unrelated to the bridge',
      mentions: ['hermes'],
      createdAt: Date.now(),
    };
    h.messages.set(roomId, [mentionMsg]);
    relayMessageToAgents(h.relayDeps, roomId, mentionMsg);

    // Job B: the bridge wake, fired right after — queues behind job A in the
    // SAME per-agent worker (relay.ts serializes; single-flight is not what
    // enforces this ordering anymore).
    const wakePromise = post(h.baseUrl, {
      seatId: 'hermes',
      roomId,
      prompt: 'the actual bridge ask',
      idempotencyKey: 'k-hole1-1',
    });

    // Let job A "complete" as if the seat replied to the mention — its reply
    // carries replyTo = mentionMsg.id (relay.ts's commitAgentReply stamps the
    // TRUE trigger), which must NOT match the bridge wait's triggerMessageId.
    session.emit({ type: 'token', delta: 'off-topic reply to the mention', messageId: 'm-nonbridge-reply' });
    session.emit({ type: 'message-complete', messageId: 'm-nonbridge-reply' });

    // Give the broadcast -> observe() chain a chance to run; the bridge wake
    // must still be unresolved (job B hasn't even been dispatched yet — it's
    // still queued behind job A, and the non-bridge reply must not have
    // resolved it early).
    const stillPending = await Promise.race([
      wakePromise.then(() => 'resolved' as const),
      new Promise((r) => setTimeout(r, 20)).then(() => 'pending' as const),
    ]);
    expect(stillPending).toBe('pending');

    // Now let job B (the real bridge turn) complete with its own reply.
    session.emit({ type: 'token', delta: 'the real bridge reply', messageId: 'm-bridge-reply' });
    session.emit({ type: 'message-complete', messageId: 'm-bridge-reply' });

    const { status, json } = await wakePromise;
    expect(status).toBe(200);
    // The persisted message's own id is relay.ts's internally-generated
    // draftMessageId, not the FakeSession's emitted AgentEvent messageId —
    // text is the correctness signal here (which turn's content came back).
    expect(json.reply.text).toBe('the real bridge reply');
  });

  it('hole 2: a late reply landing after its OWN wake already timed out does not resolve a DIFFERENT, later wake for the same seat', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {}; // manual control, same as hole 1

    // Wake 1: short timeout, seat never replies before it fires.
    const wake1 = post(h.baseUrl, {
      seatId: 'hermes',
      prompt: 'first wake, will time out',
      idempotencyKey: 'k-hole2-1',
      timeoutMs: 30,
    });
    const r1 = await wake1;
    expect(r1.status).toBe(408);
    expect(r1.json.timedOut).toBe(true);
    const roomId: string = r1.json.roomId;

    // Wake 2: a genuinely later wake to the SAME (roomId, seatId) — queues
    // behind job 1 in the worker (job 1's underlying turn is still in
    // flight; the bridge's own timeout does not cancel it).
    const wake2 = post(h.baseUrl, {
      seatId: 'hermes',
      roomId,
      prompt: 'second wake, should get its own reply',
      idempotencyKey: 'k-hole2-2',
    });

    // Job 1's reply finally lands, late — replyTo names wake 1's (already-
    // timed-out) bridge message id.
    session.emit({ type: 'token', delta: 'late reply to wake 1', messageId: 'm-late-1' });
    session.emit({ type: 'message-complete', messageId: 'm-late-1' });

    // This must NOT resolve wake 2 (whose triggerMessageId is wake 2's own
    // bridge message, not wake 1's) — wake 2 stays pending until job 2 runs.
    const afterLateReply = await Promise.race([
      wake2.then(() => 'resolved' as const),
      new Promise((r) => setTimeout(r, 20)).then(() => 'pending' as const),
    ]);
    expect(afterLateReply).toBe('pending');

    // Now job 2 (the seat's actual next turn, dispatched once job 1's turn
    // finished) gets its own reply.
    session.emit({ type: 'token', delta: 'reply to wake 2', messageId: 'm-wake2-reply' });
    session.emit({ type: 'message-complete', messageId: 'm-wake2-reply' });

    const r2 = await wake2;
    expect(r2.status).toBe(200);
    // Same note as hole 1: the persisted message id is relay.ts's own
    // draftMessageId, not the FakeSession's emitted event id — text is the
    // correctness signal (wake 2 got ITS OWN reply, not wake 1's stale one).
    expect(r2.json.reply.text).toBe('reply to wake 2');
  });
});

describe('sanitizePromptMentions (bridge.ts pure helper)', () => {
  const zwsp = String.fromCharCode(0x200b);

  it('neutralizes foreign seat ids, aliases, and @everyone/@all — keeps the target', async () => {
    const { sanitizePromptMentions } = await import('./bridge.js');
    const out = sanitizePromptMentions('ask @grok-build and @grok and @everyone and @all but @hermes is fine', 'hermes');
    expect(out).toContain(`@${zwsp}grok-build`);
    expect(out).toContain(`@${zwsp}grok`);
    expect(out).toContain(`@${zwsp}everyone`);
    expect(out).toContain(`@${zwsp}all`);
    expect(out).toContain('@hermes is fine');
    expect(out).not.toContain(`@${zwsp}hermes`);
  });

  it('is case-insensitive and covers multi-instance ids', async () => {
    const { sanitizePromptMentions } = await import('./bridge.js');
    const out = sanitizePromptMentions('ping @Grok-Build and @claude-code#test', 'hermes');
    expect(out).toContain(`@${zwsp}Grok-Build`);
    expect(out).toContain(`@${zwsp}claude-code#test`);
  });

  it('neutralizes aliases that resolve to a foreign seat (claude -> claude-code)', async () => {
    const { sanitizePromptMentions } = await import('./bridge.js');
    const out = sanitizePromptMentions('tell @claude and @grok', 'hermes');
    expect(out).toContain(`@${zwsp}claude`);
    expect(out).toContain(`@${zwsp}grok`);
    // ...but the SAME alias is kept when it resolves to the target itself.
    const kept = sanitizePromptMentions('tell @claude something', 'claude-code');
    expect(kept).toContain('@claude something');
    expect(kept).not.toContain(zwsp);
  });
});

describe('resolveTimeoutMs / defaults (bridge.ts pure helpers)', () => {
  it('defaults to 570000ms when absent or invalid', async () => {
    const { resolveTimeoutMs, DEFAULT_TIMEOUT_MS } = await import('./bridge.js');
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(-5)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs('600000')).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(0)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('clamps to the 600000ms hard cap', async () => {
    const { resolveTimeoutMs, MAX_TIMEOUT_MS } = await import('./bridge.js');
    expect(resolveTimeoutMs(999_999)).toBe(MAX_TIMEOUT_MS);
    expect(resolveTimeoutMs(600_000)).toBe(MAX_TIMEOUT_MS);
  });

  it('passes through a valid in-range value', async () => {
    const { resolveTimeoutMs } = await import('./bridge.js');
    expect(resolveTimeoutMs(12_345)).toBe(12_345);
  });
});

describe('BridgeIdempotencyStore', () => {
  it('FIFO-evicts the oldest entry once at capacity', async () => {
    const { BridgeIdempotencyStore: Store } = await import('./bridge.js');
    const store = new Store(2);
    store.start('a', Promise.resolve({ kind: 'timeout', roomId: 'r' } as const));
    store.start('b', Promise.resolve({ kind: 'timeout', roomId: 'r' } as const));
    expect(store.size()).toBe(2);
    store.start('c', Promise.resolve({ kind: 'timeout', roomId: 'r' } as const));
    expect(store.size()).toBe(2);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });
});

describe('BridgeWaitRegistry', () => {
  it('only resolves a wait whose room+seat+triggerMessageId all match the observed reply\'s replyTo', () => {
    const registry = new BridgeWaitRegistry();
    let resolved: unknown = null;
    registry.register('room-1', 'hermes', 5000, (r) => (resolved = r), 'trigger-1');

    // Wrong seat.
    registry.observe('room-1', 'grok-build', { messageId: 'x', text: 'not it', senderId: 'grok-build', ts: 1, replyTo: 'trigger-1' });
    expect(resolved).toBeNull();
    expect(registry.pendingCount()).toBe(1);

    // Wrong room.
    registry.observe('room-2', 'hermes', { messageId: 'x', text: 'wrong room', senderId: 'hermes', ts: 1, replyTo: 'trigger-1' });
    expect(resolved).toBeNull();

    // B7: right room+seat, but replyTo names a DIFFERENT trigger (e.g. a
    // reply to some other mention entirely) — must NOT resolve.
    registry.observe('room-1', 'hermes', { messageId: 'y', text: 'off-topic reply', senderId: 'hermes', ts: 2, replyTo: 'some-other-trigger' });
    expect(resolved).toBeNull();
    expect(registry.pendingCount()).toBe(1);

    // No replyTo at all (pre-B7 shape) — must NOT resolve.
    registry.observe('room-1', 'hermes', { messageId: 'z', text: 'no replyTo', senderId: 'hermes', ts: 3 });
    expect(resolved).toBeNull();
    expect(registry.pendingCount()).toBe(1);

    // Right room+seat+triggerMessageId — resolves.
    registry.observe('room-1', 'hermes', { messageId: 'm', text: 'yes', senderId: 'hermes', ts: 4, replyTo: 'trigger-1' });
    expect(resolved).toEqual({
      kind: 'ok',
      reply: { messageId: 'm', text: 'yes', senderId: 'hermes', ts: 4, replyTo: 'trigger-1' },
      roomId: 'room-1',
    });
    expect(registry.pendingCount()).toBe(0);
  });

  it('single-flight removed (B7): two concurrent waits for the SAME (roomId, seatId) coexist and each resolves off its OWN triggerMessageId, never the other\'s', () => {
    const registry = new BridgeWaitRegistry();
    let resolvedA: unknown = null;
    let resolvedB: unknown = null;
    registry.register('room-1', 'hermes', 5000, (r) => (resolvedA = r), 'trigger-A');
    registry.register('room-1', 'hermes', 5000, (r) => (resolvedB = r), 'trigger-B');
    expect(registry.pendingCount()).toBe(2); // no 409 / no eviction of the first

    // A reply naming trigger-B resolves ONLY wait B, even though both waits
    // share the exact same room+seat.
    registry.observe('room-1', 'hermes', { messageId: 'm-b', text: 'reply to B', senderId: 'hermes', ts: 1, replyTo: 'trigger-B' });
    expect(resolvedB).not.toBeNull();
    expect(resolvedA).toBeNull();
    expect(registry.pendingCount()).toBe(1);

    // A reply naming trigger-A resolves the remaining wait.
    registry.observe('room-1', 'hermes', { messageId: 'm-a', text: 'reply to A', senderId: 'hermes', ts: 2, replyTo: 'trigger-A' });
    expect(resolvedA).not.toBeNull();
    expect(registry.pendingCount()).toBe(0);
  });

  it('hasPending tracks register, observe, cancel, and timeout (diagnostic only post-B7 — no longer gates the route)', async () => {
    const registry = new BridgeWaitRegistry();
    expect(registry.hasPending('room-1', 'hermes')).toBe(false);

    const cancel = registry.register('room-1', 'hermes', 5000, () => {}, 'trigger-1');
    expect(registry.hasPending('room-1', 'hermes')).toBe(true);
    expect(registry.hasPending('room-2', 'hermes')).toBe(false); // scoped per room
    expect(registry.hasPending('room-1', 'grok-build')).toBe(false); // scoped per seat

    registry.observe('room-1', 'hermes', { messageId: 'm', text: 'done', senderId: 'hermes', ts: 1, replyTo: 'trigger-1' });
    expect(registry.hasPending('room-1', 'hermes')).toBe(false);

    cancel(); // idempotent after settle

    registry.register('room-1', 'hermes', 10, (r) => expect(r.kind).toBe('timeout'), 'trigger-2');
    expect(registry.hasPending('room-1', 'hermes')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(registry.hasPending('room-1', 'hermes')).toBe(false); // timeout frees the slot
  });

  it('times out and removes the wait when nothing observes it in time', async () => {
    const registry = new BridgeWaitRegistry();
    let resolved: unknown = null;
    registry.register('room-1', 'hermes', 20, (r) => (resolved = r), 'trigger-1');
    expect(registry.pendingCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(resolved).toEqual({ kind: 'timeout', roomId: 'room-1' });
    expect(registry.pendingCount()).toBe(0);
  });
});
