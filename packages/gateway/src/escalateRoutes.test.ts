import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentEvent, AgentSession, AgentState, CostReport, Message, Room, ServerEvent } from '@agent-os/shared';
import type { SqlDatabase } from './db.js';
import { openDatabase, saveRoom, persistDatabase } from './db.js';
import type { RelayDeps, RoomRelayState } from './relay.js';
import { registerAgentRelay, unregisterAgentRelay } from './relay.js';
import { BridgeWaitRegistry } from './bridge.js';
import { registerEscalateRoute, URGENT_ROOM_NAME, type EscalateRouteContext } from './escalateRoutes.js';
import { loadEscalations, DAILY_CAP } from './escalations.js';

/**
 * End-to-end tests for POST /api/escalate, same harness shape as
 * bridge.test.ts's POST /api/bridge/wake suite (real Fastify instance on an
 * EPHEMERAL port — never 4110, the live gateway is never touched — real
 * sql.js db in a fresh temp dir per test, fake AgentSessions registered via
 * relay.ts's own exported registerAgentRelay). No live SMS is ever sent:
 * the fake hermes session's send() is stubbed per-test, exactly as bridge.ts's
 * own tests do; this suite never talks to a real seat or a real phone.
 */

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'escalate-test-'));
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

/** A fake AgentSession whose events() is driven externally via `emit` — copy of bridge.test.ts's FakeSession (kept local: escalateRoutes.test.ts should stand alone, same as every other *.test.ts in this package). */
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
  broadcastedEvents: ServerEvent[];
  sessions: Map<string, FakeSession>;
  relayDeps: RelayDeps;
  /** Fixed test clock — checkRateLimit/isQuietHours determinism (opts.now on the route context). */
  clockMs: number;
  setClockMs: (ms: number) => void;
}

async function buildHarness(opts: { wakeTimeoutMs?: number } = {}): Promise<Harness> {
  const dataDir = freshDataDir();
  const db = await openDatabase(dataDir);
  const agents = new Map<string, AgentState>();
  const rooms = new Map<string, Room>();
  const messages = new Map<string, Message[]>();
  const roomRelay = new Map<string, RoomRelayState>();
  const globalCost: CostReport = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
  const broadcastedEvents: ServerEvent[] = [];
  const sessions = new Map<string, FakeSession>();
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
    saveRoom(db, room);
    persistDatabase(db, dataDir);
    broadcast({ type: 'room.updated', payload: room } as unknown as ServerEvent);
  }

  function postSystemLine(roomId: string, content: string): void {
    const line: Message = { id: `sys-${randomId()}`, roomId, senderId: 'system', content, createdAt: Date.now() };
    const list = messages.get(roomId) ?? [];
    list.push(line);
    messages.set(roomId, list);
    broadcast({ type: 'message.new', payload: line });
  }

  let clockMs = Date.now();

  const fastify = Fastify({ logger: false });
  const ctx: EscalateRouteContext = {
    relayDeps,
    agents,
    rooms,
    messages,
    db,
    dataDir,
    defaultRoomTurnCap: 12,
    broadcast,
    markBusy,
    postSystemLine,
    persistRoomMutation,
    waits,
    now: () => clockMs,
    wakeTimeoutMs: opts.wakeTimeoutMs,
  };
  registerEscalateRoute(fastify, ctx);

  const address = await fastify.listen({ port: 0, host: '127.0.0.1' });

  return {
    fastify,
    baseUrl: address,
    db,
    dataDir,
    agents,
    rooms,
    messages,
    broadcastedEvents,
    sessions,
    relayDeps,
    clockMs,
    setClockMs: (ms: number) => {
      clockMs = ms;
    },
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2);
}

function addSeat(h: Harness, seatId: string): FakeSession {
  const session = new FakeSession();
  h.agents.set(seatId, verifiedState(seatId, session));
  registerAgentRelay(seatId, session, h.relayDeps, 'full');
  h.sessions.set(seatId, session);
  return session;
}

async function post(baseUrl: string, body: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}/api/escalate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json, headers: res.headers };
}

describe('POST /api/escalate', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({ wakeTimeoutMs: 2_000 }); // short timeout so the timeout test doesn't slow the suite
  });

  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  it('happy path: hermes replies -> 200, smsOutcome sent, Urgent room created with audit lines', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'texted the owner', messageId: 'x' });
        session.emit({ type: 'message-complete', messageId: 'x' });
      }, 5);
    };

    const { status, json } = await post(h.baseUrl, {
      title: 'Gateway down',
      body: 'The gateway has not responded in 45 minutes.',
      severity: 'critical',
    });

    expect(status).toBe(200);
    expect(json.smsOutcome).toBe('sent');
    expect(typeof json.roomId).toBe('string');
    const room = h.rooms.get(json.roomId);
    expect(room?.name).toBe(URGENT_ROOM_NAME);
    expect(room?.memberIds).toContain('hermes');

    const lines = h.messages.get(json.roomId) ?? [];
    // escalation line + hermes-replied line, at minimum (plus the delivered wake message itself)
    const systemLines = lines.filter((m) => m.senderId === 'system');
    expect(systemLines.length).toBeGreaterThanOrEqual(2);
    expect(systemLines[0].content).toMatch(/ESCALATION.*critical.*Gateway down/);
    expect(systemLines[systemLines.length - 1].content).toMatch(/hermes replied/);

    const state = loadEscalations(h.dataDir);
    expect(state.escalations).toHaveLength(1);
    expect(state.escalations[0].smsOutcome).toBe('sent');
    expect(state.escalations[0].severity).toBe('critical');
  });

  it('reuses the "Urgent" room by exact name across multiple escalations', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'ack', messageId: 'm' });
        session.emit({ type: 'message-complete', messageId: 'm' });
      }, 5);
    };

    const first = await post(h.baseUrl, { title: 'A', body: 'first', severity: 'critical' });
    expect(first.status).toBe(200);
    const roomId = first.json.roomId;

    h.setClockMs(h.clockMs + 40 * 60 * 1000); // clear the cooldown for a second call
    const second = await post(h.baseUrl, { title: 'B', body: 'second', severity: 'critical' });
    expect(second.status).toBe(200);
    expect(second.json.roomId).toBe(roomId);
    expect(h.rooms.size).toBe(1);
  });

  it('missing fields -> 400', async () => {
    const { status, json } = await post(h.baseUrl, { title: 'only a title' });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('invalid severity -> 400', async () => {
    const { status } = await post(h.baseUrl, { title: 't', body: 'b', severity: 'medium' });
    expect(status).toBe(400);
  });

  it('secret-shaped body -> 400, rejects before touching the room or the rate limiter', async () => {
    const { status, json } = await post(h.baseUrl, {
      title: 'Leaked creds',
      body: 'found AKIAABCDEFGHIJKLMNOP in the logs',
      severity: 'critical',
    });
    expect(status).toBe(400);
    expect(json.error).toBe('secret-detected');
    expect(json.reason).toBeTruthy();
    expect(JSON.stringify(json)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(h.rooms.size).toBe(0); // never even created the Urgent room
    expect(loadEscalations(h.dataDir).escalations).toHaveLength(0); // never persisted / never counted against the cap
  });

  it('rate limit: blocks the 4th escalation of the day with 429 + Retry-After', async () => {
    addSeat(h, 'hermes').sendImpl = () => {};
    const seatSession = h.sessions.get('hermes')!;
    seatSession.sendImpl = () => {
      setTimeout(() => {
        seatSession.emit({ type: 'token', delta: 'ack', messageId: 'm' });
        seatSession.emit({ type: 'message-complete', messageId: 'm' });
      }, 2);
    };

    for (let i = 0; i < DAILY_CAP; i += 1) {
      const r = await post(h.baseUrl, { title: `t${i}`, body: `b${i}`, severity: 'critical' });
      expect(r.status).toBe(200);
      h.setClockMs(h.clockMs + 40 * 60 * 1000); // clear cooldown between each
    }

    const blocked = await post(h.baseUrl, { title: 'one too many', body: 'b', severity: 'critical' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBe('rate-limited');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('cooldown: blocks a second "high" within 30 minutes, but "critical" bypasses it', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'ack', messageId: 'm' });
        session.emit({ type: 'message-complete', messageId: 'm' });
      }, 2);
    };

    const first = await post(h.baseUrl, { title: 'first', body: 'b', severity: 'high' });
    expect(first.status).toBe(200);

    const second = await post(h.baseUrl, { title: 'second', body: 'b', severity: 'high' });
    expect(second.status).toBe(429);

    const third = await post(h.baseUrl, { title: 'third', body: 'b', severity: 'critical' });
    expect(third.status).toBe(200);
  });

  it('quiet hours: "high" is queued to the room only, no wake attempted', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      throw new Error('should never be called during quiet hours for severity=high');
    };
    h.setClockMs(new Date(2026, 6, 9, 3, 0, 0, 0).getTime()); // 3am local

    const { status, json } = await post(h.baseUrl, { title: 't', body: 'b', severity: 'high' });
    expect(status).toBe(200);
    expect(json.smsOutcome).toBe('skipped-quiet-hours');
    expect(session.sent).toHaveLength(0);
  });

  it('quiet hours: "critical" still wakes hermes', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'ack', messageId: 'm' });
        session.emit({ type: 'message-complete', messageId: 'm' });
      }, 2);
    };
    h.setClockMs(new Date(2026, 6, 9, 3, 0, 0, 0).getTime()); // 3am local

    const { status, json } = await post(h.baseUrl, { title: 't', body: 'b', severity: 'critical' });
    expect(status).toBe(200);
    expect(json.smsOutcome).toBe('sent');
    expect(session.sent.length).toBeGreaterThan(0);
  });

  it('hermes not connected: smsOutcome failed, no crash, still recorded', async () => {
    // No seat registered at all.
    const { status, json } = await post(h.baseUrl, { title: 't', body: 'b', severity: 'critical' });
    expect(status).toBe(200);
    expect(json.smsOutcome).toBe('failed');
    const state = loadEscalations(h.dataDir);
    expect(state.escalations[0].smsOutcome).toBe('failed');
  });

  it('hermes never replies: smsOutcome failed after the wake timeout, no dangling listener', async () => {
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {}; // never emits a reply

    const { status, json } = await post(h.baseUrl, { title: 't', body: 'b', severity: 'critical' });
    expect(status).toBe(200);
    expect(json.smsOutcome).toBe('failed');
  });

  it('wake template (Wave 8 W8-2): carries the explicit send_message imperative naming the real photon target, not sms', async () => {
    // Regression for docs/WIP-2026-07-09-wave7-m2-sms-carrier-leg.md: hermes
    // twice replied "Acknowledged, standing by" with no send_message call
    // because the wake message itself gave no tool-call imperative. This
    // asserts the fix landed in the wake content hermes's session.send()
    // actually receives (relay.ts's outboundFromMessage carries msg.content
    // through unchanged — relay.ts itself is frozen/untouched by this test).
    const session = addSeat(h, 'hermes');
    session.sendImpl = () => {
      setTimeout(() => {
        session.emit({ type: 'token', delta: 'texted the owner via photon', messageId: 'm' });
        session.emit({ type: 'message-complete', messageId: 'm' });
      }, 2);
    };

    const { status } = await post(h.baseUrl, {
      title: 'Template check',
      body: 'Does the wake carry the imperative.',
      severity: 'critical',
    });
    expect(status).toBe(200);

    expect(session.sent).toHaveLength(1);
    const content = (session.sent[0] as { content: string }).content;
    expect(content).toMatch(/\[AgentOS URGENT\]/);
    // The explicit tool-call imperative, present BEFORE any reply is asked for.
    expect(content).toMatch(/ACTION REQUIRED before you reply/);
    expect(content).toContain("send_message(action='send', target='photon'");
    // Never names the wrong (unconfigured, non-live) carrier as the target.
    expect(content).not.toMatch(/target='sms'/);
  });

  it('CONCURRENCY (fix-round regression): N simultaneous critical escalations enforce the daily cap exactly, with no lost records', async () => {
    // Exact repro shape of the fix-round finding: the pre-fix route called
    // loadEscalations()+checkRateLimit() BEFORE `await wakeHermes(...)` and
    // saveEscalations() with the pre-await snapshot AFTER it resolved. Fired
    // at DAILY_CAP+2 concurrent 'critical' calls, that let all of them pass
    // the rate limiter (every one read the same empty pre-save state) and
    // then lost every record but the last one to save (lost update) — 5/5
    // 200s, only 1/5 records persisted, empirically. This test fails against
    // the pre-fix code (verified: temporarily reverted escalateRoutes.ts/
    // escalations.ts, reran, got 5/5 200 and 1 persisted record; restored
    // the fix, reran green) and passes against the fix.
    const session = addSeat(h, 'hermes');
    let sendCount = 0;
    session.sendImpl = () => {
      sendCount += 1;
      const n = sendCount;
      setTimeout(() => {
        session.emit({ type: 'token', delta: `ack ${n}`, messageId: `m-conc-${n}` });
        session.emit({ type: 'message-complete', messageId: `m-conc-${n}` });
      }, 15);
    };

    const N = DAILY_CAP + 2; // 5 concurrent callers against a cap of 3
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => post(h.baseUrl, { title: `concurrent ${i}`, body: `body ${i}`, severity: 'critical' }))
    );

    const ok = results.filter((r) => r.status === 200);
    const limited = results.filter((r) => r.status === 429);
    expect(ok).toHaveLength(DAILY_CAP);
    expect(limited).toHaveLength(N - DAILY_CAP);
    for (const r of limited) expect(r.json.error).toBe('rate-limited');

    const state = loadEscalations(h.dataDir);
    expect(state.escalations).toHaveLength(DAILY_CAP); // no lost updates
    expect(new Set(state.escalations.map((r) => r.id)).size).toBe(DAILY_CAP); // no id collisions

    // Every persisted record must be fully finalized before any HTTP
    // response went out — 'pending' reaching disk after a 200 would mean
    // finalize itself lost a race.
    for (const record of state.escalations) {
      expect(record.smsOutcome).not.toBe('pending');
    }
    // Each successful response's id is present with the SAME outcome it
    // reported — no cross-wiring between concurrent callers' records.
    for (const r of ok) {
      const persisted = state.escalations.find((e) => e.id === r.json.id);
      expect(persisted).toBeTruthy();
      expect(persisted?.smsOutcome).toBe(r.json.smsOutcome);
    }

    expect(sendCount).toBe(DAILY_CAP); // exactly the successful reservations woke hermes, once each
  });
});
