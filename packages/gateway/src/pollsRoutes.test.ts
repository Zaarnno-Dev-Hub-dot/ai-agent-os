import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentEvent, AgentSession, AgentState, CostReport, Message, Room, ServerEvent } from '@agent-os/shared';
import type { SqlDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { RelayDeps, RoomRelayState } from './relay.js';
import { registerAgentRelay, unregisterAgentRelay } from './relay.js';
import {
  broadcastPollUpdated,
  handlePollDecide,
  handlePollDefer,
  handlePollInfoRequested,
  handlePollWithdraw,
  notifyPollInfoRequested,
  notifyPollSettled,
  registerPollsRoute,
  sweepAndSettlePolls,
  type PollsRouteContext,
} from './pollsRoutes.js';
import { createPoll, type PollsState } from './polls.js';

/**
 * End-to-end tests for the polls/approvals rail wiring (Wave 4). Same
 * harness shape as bridge.test.ts: a REAL Fastify instance on an EPHEMERAL
 * port, a real sql.js db in a fresh temp dir per test, and fake
 * AgentSessions registered via relay.ts's own exported registerAgentRelay —
 * so the requester-notify path exercises the REAL relayMessageToAgents /
 * AgentRelayWorker path, not a mock of it.
 */

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'polls-routes-test-'));
}

/** Fixed test humanToken (Wave 7 M3) — every handlePollDecide call in this file must pass this exact value; the dedicated describe block below covers the gate itself (missing/wrong token). */
const TEST_HUMAN_TOKEN = 'test-human-token-0123456789abcdef';

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
  pollsState: PollsState;
  ctx: PollsRouteContext;
  stateSyncCount: number;
  postSystemLines: Array<{ roomId: string; content: string }>;
}

async function buildHarness(paperclipBaseUrl = 'http://127.0.0.1:1'): Promise<Harness> {
  const dataDir = freshDataDir();
  const db = await openDatabase(dataDir);
  const agents = new Map<string, AgentState>();
  const rooms = new Map<string, Room>();
  const messages = new Map<string, Message[]>();
  const roomRelay = new Map<string, RoomRelayState>();
  const globalCost: CostReport = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
  const broadcastedEvents: ServerEvent[] = [];
  const sessions = new Map<string, FakeSession>();

  const busySeats = new Set<string>();
  function markBusy(ids: Iterable<string>): void {
    for (const id of ids) busySeats.add(id);
  }

  function broadcast(event: ServerEvent): void {
    broadcastedEvents.push(event);
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

  let pollsState: PollsState = { polls: [] };
  const postSystemLines: Array<{ roomId: string; content: string }> = [];
  const state = { stateSyncCount: 0 };

  const ctx: PollsRouteContext = {
    relayDeps,
    agents,
    rooms,
    messages,
    db,
    dataDir,
    // No test in this file creates a source:'workshop' poll (see
    // workshopRoutes.test.ts for those, against a real throwaway git repo) —
    // this value is never read by notifyPollSettled's workshop branch here,
    // it only needs to satisfy PollsRouteContext's shape.
    projectRoot: dataDir,
    paperclipBaseUrl,
    getPollsState: () => pollsState,
    setPollsState: (s) => {
      pollsState = s;
    },
    broadcast,
    markBusy,
    broadcastStateSync: () => {
      state.stateSyncCount += 1;
    },
    postSystemLine: (roomId, content) => {
      postSystemLines.push({ roomId, content });
    },
    humanToken: TEST_HUMAN_TOKEN,
  };

  const fastify = Fastify({ logger: false });
  registerPollsRoute(fastify, ctx);
  const baseUrl = await fastify.listen({ port: 0, host: '127.0.0.1' });

  return {
    fastify,
    baseUrl,
    db,
    dataDir,
    agents,
    rooms,
    messages,
    broadcastedEvents,
    sessions,
    get pollsState() {
      return pollsState;
    },
    ctx,
    get stateSyncCount() {
      return state.stateSyncCount;
    },
    postSystemLines,
  } as unknown as Harness;
}

function addSeat(h: Harness, seatId: string): FakeSession {
  const session = new FakeSession();
  h.agents.set(seatId, verifiedState(seatId, session));
  registerAgentRelay(seatId, session, h.ctx.relayDeps, 'full');
  h.sessions.set(seatId, session);
  return session;
}

function makeRoom(id: string, memberIds: string[] = ['human']): Room {
  return { id, name: `Room ${id}`, type: 'group', memberIds, createdAt: Date.now(), updatedAt: Date.now(), turnCap: 12 };
}

async function post(baseUrl: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/polls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

/**
 * Wait until `count` seat-authored replies have FULLY committed. Each relay
 * delivery to a FakeSession seat ends in AgentRelayWorker.commitAgentReply,
 * which runs insertMessage → persistDatabase → broadcast('message.new')
 * synchronously — so once the Nth seat-authored message.new broadcast is
 * observable, the Nth db write has already finished and afterEach can rmSync
 * the temp data dir safely. Replaces the old blind `setTimeout(30)` waits,
 * which lost the race on a loaded event loop: the fake seat's 5ms reply timer
 * could fire after the test ended, and the worker's persistDatabase then hit
 * writeFileSync ENOENT against the already-removed temp dir — an unhandled
 * rejection that intermittently escalated into a failed run.
 */
async function waitForSeatReplyCommits(h: Harness, seatId: string, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const committed = h.broadcastedEvents.filter(
      (e) => e.type === 'message.new' && e.payload.senderId === seatId
    ).length;
    if (committed >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} committed ${seatId} replies, saw ${committed} after 2s`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function postWithdraw(baseUrl: string, pollId: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/polls/${encodeURIComponent(pollId)}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

describe('POST /api/polls', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  it('creates an open poll and broadcasts poll.updated + state.sync', async () => {
    h.rooms.set('room-1', makeRoom('room-1'));
    const { status, json } = await post(h.baseUrl, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      requestedBy: 'hermes',
    });
    expect(status).toBe(200);
    expect(json.status).toBe('open');
    expect(h.pollsState.polls).toHaveLength(1);
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('400s when roomId is missing', async () => {
    const { status, json } = await post(h.baseUrl, { question: 'Q', options: [{ label: 'A' }, { label: 'B' }], requestedBy: 'hermes' });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('400s when the room does not exist', async () => {
    const { status } = await post(h.baseUrl, {
      roomId: 'does-not-exist',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    expect(status).toBe(400);
  });

  it('400s when the room is archived', async () => {
    h.rooms.set('room-archived', { ...makeRoom('room-archived'), archivedAt: Date.now() });
    const { status } = await post(h.baseUrl, {
      roomId: 'room-archived',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    expect(status).toBe(400);
  });

  it('400s on fewer than 2 or more than 6 options', async () => {
    h.rooms.set('room-1', makeRoom('room-1'));
    const tooFew = await post(h.baseUrl, { roomId: 'room-1', question: 'Q', options: [{ label: 'A' }], requestedBy: 'hermes' });
    expect(tooFew.status).toBe(400);
    const tooMany = await post(h.baseUrl, {
      roomId: 'room-1',
      question: 'Q',
      options: Array.from({ length: 7 }, (_, i) => ({ label: `${i}` })),
      requestedBy: 'hermes',
    });
    expect(tooMany.status).toBe(400);
  });

  it('400s when recommendationId/defaultOptionId do not match a real option id', async () => {
    h.rooms.set('room-1', makeRoom('room-1'));
    const { status, json } = await post(h.baseUrl, {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      recommendationId: 'ghost',
      requestedBy: 'hermes',
    });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('400s on a missing requestedBy', async () => {
    h.rooms.set('room-1', makeRoom('room-1'));
    const { status } = await post(h.baseUrl, { roomId: 'room-1', question: 'Q', options: [{ label: 'A' }, { label: 'B' }] });
    expect(status).toBe(400);
  });

  describe('attachments validation (SECURITY: design doc correction #1, reopened)', () => {
    it('400s when an attachment kind is missing entirely — the exact PoC shape from the reopened finding', async () => {
      h.rooms.set('room-1', makeRoom('room-1'));
      const { status, json } = await post(h.baseUrl, {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [{ url: 'data:image/svg+xml;base64,AAAA', caption: 'View screenshot' }],
      });
      expect(status).toBe(400);
      expect(json.error).toBeTruthy();
      expect(h.pollsState.polls).toHaveLength(0); // never entered live state
    });

    it('400s when an attachment kind is outside the declared union (e.g. a typo)', async () => {
      h.rooms.set('room-1', makeRoom('room-1'));
      const { status } = await post(h.baseUrl, {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [{ kind: 'screenshot', url: 'data:image/svg+xml;base64,AAAA' }],
      });
      expect(status).toBe(400);
    });

    it('creates the poll when attachments are well-formed', async () => {
      h.rooms.set('room-1', makeRoom('room-1'));
      const { status, json } = await post(h.baseUrl, {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,abc=', caption: 'ok' }],
      });
      expect(status).toBe(200);
      expect(json.attachments).toHaveLength(1);
    });

    it('400s when a disputeSide evidence attachment has an invalid kind', async () => {
      h.rooms.set('room-1', makeRoom('room-1'));
      const { status } = await post(h.baseUrl, {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        disputeSides: [{ agent: 'hermes', statement: 'x', evidence: [{ kind: 'screenshot', url: 'x' }] }],
      });
      expect(status).toBe(400);
    });
  });
});

describe('handlePollDecide', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  function seedPoll(requestedBy = 'human'): { pollId: string; approveId: string; rejectId: string } {
    h.rooms.set('room-1', makeRoom('room-1', ['human', requestedBy]));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy,
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    return { pollId: result.poll.id, approveId: 'approve', rejectId: 'reject' };
  }

  it('decides an open poll: persists, posts a system line, broadcasts poll.updated + state.sync', () => {
    const { pollId, approveId } = seedPoll();
    const outcome = handlePollDecide(h.ctx, pollId, approveId, 'human', 'go ahead', TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.poll.status).toBe('decided');
    expect(outcome.poll.decision?.optionId).toBe(approveId);
    expect(h.postSystemLines).toHaveLength(1);
    expect(h.postSystemLines[0].content).toContain('Approve');
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('rejects an unknown pollId', () => {
    seedPoll();
    const outcome = handlePollDecide(h.ctx, 'ghost', 'approve', 'human', undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(false);
  });

  it('double-decide race: the second decide (WS replay / duplicate frame) is rejected, first write wins', () => {
    const { pollId, approveId, rejectId } = seedPoll();
    const first = handlePollDecide(h.ctx, pollId, approveId, 'human', undefined, TEST_HUMAN_TOKEN);
    expect(first.ok).toBe(true);
    const second = handlePollDecide(h.ctx, pollId, rejectId, 'human', undefined, TEST_HUMAN_TOKEN);
    expect(second.ok).toBe(false);
    expect(h.pollsState.polls.find((p) => p.id === pollId)?.decision?.optionId).toBe(approveId);
  });

  it('replay after decide: the poll stays decided, no duplicate system line from a repeated identical call', () => {
    const { pollId, approveId } = seedPoll();
    handlePollDecide(h.ctx, pollId, approveId, 'human', undefined, TEST_HUMAN_TOKEN);
    handlePollDecide(h.ctx, pollId, approveId, 'human', undefined, TEST_HUMAN_TOKEN); // replay with the SAME optionId
    expect(h.postSystemLines).toHaveLength(1); // second call rejected before any system line
  });

  it('requester-notify: decide on a poll requested by a currently-VERIFIED seat wakes that seat with the decision', async () => {
    const seat = addSeat(h, 'hermes');
    seat.sendImpl = () => {
      setTimeout(() => {
        seat.emit({ type: 'token', delta: 'ack', messageId: 'm1' });
        seat.emit({ type: 'message-complete', messageId: 'm1' });
      }, 5);
    };
    const { pollId, approveId } = seedPoll('hermes');
    const outcome = handlePollDecide(h.ctx, pollId, approveId, 'human', undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // handlePollDecide fires the notify fire-and-forget — await it directly
    // via notifyPollSettled for a deterministic assertion point.
    await notifyPollSettled(h.ctx, outcome.poll);
    expect(seat.sent.length).toBeGreaterThan(0);
    const persisted = (h.messages.get('room-1') ?? []).find((m) => m.senderId === 'poll-system');
    expect(persisted?.content).toContain('@hermes');
    expect(persisted?.content).toContain('Approve');
    // relayMessageToAgents hands off to the worker's async event loop rather
    // than awaiting its completion (same fire-and-forget shape as bridge.ts's
    // own delivery) — and the seat is woken TWICE here (handlePollDecide's own
    // settlePollAsync + the explicit notifyPollSettled above), so wait for
    // BOTH replies to fully commit (incl. persistDatabase) before afterEach
    // removes the temp data dir out from under a still-in-flight write.
    await waitForSeatReplyCommits(h, 'hermes', 2);
  });

  it('requester-notify: a requester that is NOT a currently-VERIFIED seat (e.g. "paperclip" or a disconnected id) is silently skipped, no throw', async () => {
    const { pollId, approveId } = seedPoll('paperclip'); // not registered as an agent at all
    const outcome = handlePollDecide(h.ctx, pollId, approveId, 'human', undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await expect(notifyPollSettled(h.ctx, outcome.poll)).resolves.toBeUndefined();
    expect((h.messages.get('room-1') ?? []).some((m) => m.senderId === 'poll-system')).toBe(false);
  });

  it('Paperclip POST-back: a decided source=paperclip poll POSTs approve/reject with the decision note; failure is caught and logged-once, never thrown', async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      h.rooms.set('room-1', makeRoom('room-1'));
      const created = createPoll(h.pollsState, {
        roomId: 'room-1',
        question: 'Hire agent: X',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
        requestedBy: 'paperclip',
        source: 'paperclip',
        externalRef: { approvalId: 'appr-1', companyId: 'co-1' },
      });
      if (!created.ok) throw new Error('setup failed');
      h.ctx.setPollsState(created.state);
      const outcome = handlePollDecide(h.ctx, created.poll.id, 'approve', 'human', 'owner approved', TEST_HUMAN_TOKEN);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // h.ctx.paperclipBaseUrl points at an unreachable port (harness default)
      // — the POST-back MUST fail, and MUST be swallowed rather than thrown.
      await expect(notifyPollSettled(h.ctx, outcome.poll)).resolves.toBeUndefined();
      expect(errors.some((e) => String((e as unknown[])[0]).includes('[polls] Paperclip POST-back failed'))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});

describe('handlePollDecide humanToken gate (Wave 7 M3, docs/DESIGN-two-reviewer-policy.md B2)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  function seedPoll(): { pollId: string } {
    h.rooms.set('room-1', makeRoom('room-1'));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: 'human',
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    return { pollId: result.poll.id };
  }

  it('rejects with NO token at all — the exact "raw client that never knew to send one" shape', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollDecide(h.ctx, pollId, 'approve', 'human');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/unauthorized/i);
    expect(h.pollsState.polls.find((p) => p.id === pollId)?.status).toBe('open'); // nothing decided
    expect(h.postSystemLines).toHaveLength(0); // no side effects ran
    expect(h.broadcastedEvents).toHaveLength(0);
  });

  it('rejects an EMPTY-STRING token', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollDecide(h.ctx, pollId, 'approve', 'human', undefined, '');
    expect(outcome.ok).toBe(false);
  });

  it('rejects a WRONG token (same length, different value)', () => {
    const { pollId } = seedPoll();
    const wrong = 'x'.repeat(TEST_HUMAN_TOKEN.length);
    const outcome = handlePollDecide(h.ctx, pollId, 'approve', 'human', undefined, wrong);
    expect(outcome.ok).toBe(false);
  });

  it('rejects a non-string token (e.g. a forged number/object in the payload)', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollDecide(h.ctx, pollId, 'approve', 'human', undefined, 12345 as unknown as string);
    expect(outcome.ok).toBe(false);
  });

  it('accepts the EXACT correct token — the legitimate served-page path', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollDecide(h.ctx, pollId, 'approve', 'human', undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
  });

  it('a rejected (no-token) attempt does not consume the settle-once guard — a SUBSEQUENT correctly-authenticated decide still succeeds', () => {
    const { pollId } = seedPoll();
    const unauthorized = handlePollDecide(h.ctx, pollId, 'approve', 'human');
    expect(unauthorized.ok).toBe(false);
    const authorized = handlePollDecide(h.ctx, pollId, 'approve', 'human', undefined, TEST_HUMAN_TOKEN);
    expect(authorized.ok).toBe(true);
  });
});

describe('handlePollWithdraw', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  function seedPoll(requestedBy = 'human'): { pollId: string } {
    h.rooms.set('room-1', makeRoom('room-1', ['human', requestedBy]));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Pick a base model?',
      options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
      requestedBy,
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    return { pollId: result.poll.id };
  }

  it('withdraws an open poll: persists, posts a system line, broadcasts poll.updated + state.sync', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollWithdraw(h.ctx, pollId, 'Superseded', TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.poll.status).toBe('withdrawn');
    expect(outcome.poll.decision).toBeUndefined();
    expect(h.postSystemLines).toHaveLength(1);
    expect(h.postSystemLines[0].content).toContain('withdrawn');
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('rejects an unknown pollId', () => {
    seedPoll();
    const outcome = handlePollWithdraw(h.ctx, 'ghost', undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(false);
  });

  it('rejects withdrawing an already-decided poll (settle-once)', () => {
    const { pollId } = seedPoll();
    const decided = handlePollDecide(h.ctx, pollId, 'a', 'human', undefined, TEST_HUMAN_TOKEN);
    expect(decided.ok).toBe(true);
    const outcome = handlePollWithdraw(h.ctx, pollId, undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(false);
  });

  it('never fires the requester-notify/Paperclip/workshop settle side effects (deliberately not the notifyPollSettled path)', () => {
    const seat = addSeat(h, 'hermes');
    const { pollId } = seedPoll('hermes');
    const outcome = handlePollWithdraw(h.ctx, pollId, undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    // No requester-notify message was ever inserted — unlike handlePollDecide,
    // which requires an explicit await of notifyPollSettled to observe it,
    // withdraw never calls it at all, so there is nothing to await here.
    expect((h.messages.get('room-1') ?? []).some((m) => m.senderId === 'poll-system')).toBe(false);
    expect(seat.sent).toHaveLength(0);
  });
});

describe('handlePollWithdraw humanToken gate', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  function seedPoll(): { pollId: string } {
    h.rooms.set('room-1', makeRoom('room-1'));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: 'human',
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    return { pollId: result.poll.id };
  }

  it('rejects with NO token at all', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollWithdraw(h.ctx, pollId, undefined, undefined);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/unauthorized/i);
    expect(h.pollsState.polls.find((p) => p.id === pollId)?.status).toBe('open');
  });

  it('rejects a WRONG token (same length, different value)', () => {
    const { pollId } = seedPoll();
    const wrong = 'x'.repeat(TEST_HUMAN_TOKEN.length);
    const outcome = handlePollWithdraw(h.ctx, pollId, undefined, wrong);
    expect(outcome.ok).toBe(false);
  });

  it('accepts the EXACT correct token', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollWithdraw(h.ctx, pollId, undefined, TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
  });
});

describe('POST /api/polls/:id/withdraw (REST route wiring)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  function seedPoll(): { pollId: string } {
    h.rooms.set('room-1', makeRoom('room-1'));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      requestedBy: 'human',
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    return { pollId: result.poll.id };
  }

  it('200s and withdraws with a valid humanToken + note', async () => {
    const { pollId } = seedPoll();
    const { status, json } = await postWithdraw(h.baseUrl, pollId, { note: 'stale', humanToken: TEST_HUMAN_TOKEN });
    expect(status).toBe(200);
    expect(json.status).toBe('withdrawn');
  });

  it('401s with a missing humanToken — an agent/raw caller cannot withdraw a poll', async () => {
    const { pollId } = seedPoll();
    const { status, json } = await postWithdraw(h.baseUrl, pollId, {});
    expect(status).toBe(401);
    expect(json.error).toMatch(/unauthorized/i);
    expect(h.pollsState.polls.find((p) => p.id === pollId)?.status).toBe('open');
  });

  it('401s with a wrong humanToken', async () => {
    const { pollId } = seedPoll();
    const { status } = await postWithdraw(h.baseUrl, pollId, { humanToken: 'wrong-token-wrong-token' });
    expect(status).toBe(401);
  });

  it('400s for an unknown pollId even with a valid token', async () => {
    seedPoll();
    const { status } = await postWithdraw(h.baseUrl, 'ghost', { humanToken: TEST_HUMAN_TOKEN });
    expect(status).toBe(400);
  });
});

describe('handlePollDefer', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  // Returns the poll's ACTUAL originalExpiresAt/createdAt (read back from the
  // created poll, not a timestamp captured separately in the test) —
  // createPoll takes its own Date.now() reading a fraction of a millisecond
  // apart from anything the test reads before/after calling it, so an
  // earlier version of this test (comparing against a separately-captured
  // `Date.now()`) was flaky by exactly 1ms on an unlucky tick. Deriving the
  // expected extension from the poll's own recorded fields — the exact same
  // two values deferPoll itself subtracts — makes the assertion robust
  // regardless of that jitter, without needing fake timers around a real
  // Fastify server + sql.js file I/O.
  function seedPollWithExpiry(
    durationMs: number,
    requestedBy = 'human'
  ): { pollId: string; originalExpiresAt: number; nominalDurationMs: number } {
    h.rooms.set('room-1', makeRoom('room-1', ['human', requestedBy]));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy,
      expiresAt: Date.now() + durationMs,
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    const originalExpiresAt = result.poll.originalExpiresAt!;
    return { pollId: result.poll.id, originalExpiresAt, nominalDurationMs: originalExpiresAt - result.poll.createdAt };
  }

  it('defers an open poll: extends expiresAt, posts a system line, broadcasts poll.updated + state.sync, poll stays open', () => {
    const { pollId, originalExpiresAt, nominalDurationMs } = seedPollWithExpiry(50_000);
    const outcome = handlePollDefer(h.ctx, pollId, 'human', 'need more time');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.poll.status).toBe('open');
    expect(outcome.poll.expiresAt).toBe(originalExpiresAt + nominalDurationMs);
    expect(outcome.poll.deferrals).toHaveLength(1);
    expect(h.postSystemLines).toHaveLength(1);
    expect(h.postSystemLines[0].content).toContain('deferred');
    expect(h.postSystemLines[0].content).toContain('1/3');
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('caps at 3 deferrals — the 4th WS call is rejected server-side even if a stale tab never disabled its button', () => {
    const { pollId } = seedPollWithExpiry(10_000);
    for (let i = 0; i < 3; i++) {
      expect(handlePollDefer(h.ctx, pollId, 'human').ok).toBe(true);
    }
    const fourth = handlePollDefer(h.ctx, pollId, 'human');
    expect(fourth.ok).toBe(false);
    expect(h.pollsState.polls.find((p) => p.id === pollId)?.deferrals).toHaveLength(3);
  });

  it('rejects an unknown pollId', () => {
    seedPollWithExpiry(10_000);
    const outcome = handlePollDefer(h.ctx, 'ghost', 'human');
    expect(outcome.ok).toBe(false);
  });

  it('rejects deferring an already-decided poll', () => {
    const { pollId } = seedPollWithExpiry(10_000);
    const decide = handlePollDecide(h.ctx, pollId, 'approve', 'human', undefined, TEST_HUMAN_TOKEN);
    expect(decide.ok).toBe(true);
    const outcome = handlePollDefer(h.ctx, pollId, 'human');
    expect(outcome.ok).toBe(false);
  });

  it('does NOT notify the requester or POST back to Paperclip — defer is not a settle', async () => {
    const seat = addSeat(h, 'hermes');
    const { pollId } = seedPollWithExpiry(10_000, 'hermes');
    const outcome = handlePollDefer(h.ctx, pollId, 'human');
    expect(outcome.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(seat.sent.length).toBe(0);
    expect((h.messages.get('room-1') ?? []).some((m) => m.senderId === 'poll-system')).toBe(false);
  });
});

describe('handlePollInfoRequested', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  function seedPoll(requestedBy = 'human'): { pollId: string } {
    h.rooms.set('room-1', makeRoom('room-1', ['human', requestedBy]));
    const result = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy,
    });
    if (!result.ok) throw new Error('setup failed');
    h.ctx.setPollsState(result.state);
    return { pollId: result.poll.id };
  }

  it('posts the needs-info message, no status change, broadcasts poll.updated + state.sync', () => {
    const { pollId } = seedPoll();
    const outcome = handlePollInfoRequested(h.ctx, pollId, 'human', 'what is the cost?');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.poll.status).toBe('open');
    expect(outcome.poll.messages).toHaveLength(1);
    expect(outcome.poll.messages?.[0].severity).toBe('needs-info');
    expect(h.postSystemLines).toHaveLength(1);
    expect(h.postSystemLines[0].content).toContain('more info requested');
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('rejects an unknown pollId', () => {
    seedPoll();
    const outcome = handlePollInfoRequested(h.ctx, 'ghost', 'human');
    expect(outcome.ok).toBe(false);
  });

  it('requester-notify: a VERIFIED requester seat is woken with the more-info ask', async () => {
    const seat = addSeat(h, 'hermes');
    seat.sendImpl = () => {
      setTimeout(() => {
        seat.emit({ type: 'token', delta: 'ack', messageId: 'm-info' });
        seat.emit({ type: 'message-complete', messageId: 'm-info' });
      }, 5);
    };
    const { pollId } = seedPoll('hermes');
    const outcome = handlePollInfoRequested(h.ctx, pollId, 'human', 'need the budget breakdown');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // handlePollInfoRequested fires the notify fire-and-forget — await the
    // exported function directly for a deterministic assertion point, same
    // pattern as the handlePollDecide requester-notify test above.
    await notifyPollInfoRequested(h.ctx, outcome.poll, 'need the budget breakdown');
    expect(seat.sent.length).toBeGreaterThan(0);
    const persisted = (h.messages.get('room-1') ?? []).find((m) => m.senderId === 'poll-system');
    expect(persisted?.content).toContain('@hermes');
    expect(persisted?.content).toContain('budget breakdown');
    // Two deliveries in flight (handlePollInfoRequested's own fire-and-forget
    // notify + the explicit awaited one above) — wait for both replies to
    // fully commit before teardown; see waitForSeatReplyCommits.
    await waitForSeatReplyCommits(h, 'hermes', 2);
  });

  it('requester-notify: a requester that is NOT currently-VERIFIED is silently skipped, no throw', async () => {
    const { pollId } = seedPoll('paperclip'); // not registered as an agent at all
    const outcome = handlePollInfoRequested(h.ctx, pollId, 'human');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await expect(notifyPollInfoRequested(h.ctx, outcome.poll)).resolves.toBeUndefined();
    expect((h.messages.get('room-1') ?? []).some((m) => m.senderId === 'poll-system')).toBe(false);
  });
});

describe('sweepAndSettlePolls (expiry)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    for (const seatId of h.sessions.keys()) unregisterAgentRelay(seatId);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  it('auto-defaults an expired poll, posts a system line, broadcasts poll.updated + state.sync', () => {
    h.rooms.set('room-1', makeRoom('room-1'));
    const created = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Auto Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      defaultOptionId: 'a',
      expiresAt: Date.now() - 1,
      requestedBy: 'human',
    });
    if (!created.ok) throw new Error('setup failed');
    h.ctx.setPollsState(created.state);

    sweepAndSettlePolls(h.ctx);

    const settled = h.pollsState.polls.find((p) => p.id === created.poll.id);
    expect(settled?.status).toBe('decided');
    expect(settled?.decision?.decidedBy).toBe('auto-default');
    expect(h.postSystemLines.some((l) => l.content.includes('auto-default'))).toBe(true);
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('no-op (no broadcast) when nothing has expired', () => {
    h.rooms.set('room-1', makeRoom('room-1'));
    const created = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Not yet',
      options: [{ label: 'A' }, { label: 'B' }],
      expiresAt: Date.now() + 60_000,
      requestedBy: 'human',
    });
    if (!created.ok) throw new Error('setup failed');
    h.ctx.setPollsState(created.state);
    sweepAndSettlePolls(h.ctx);
    expect(h.stateSyncCount).toBe(0);
    expect(h.postSystemLines).toHaveLength(0);
  });

  it('notifies a VERIFIED requester seat on auto-default expiry, same as a manual decide', async () => {
    const seat = addSeat(h, 'hermes');
    seat.sendImpl = () => {
      setTimeout(() => {
        seat.emit({ type: 'token', delta: 'noted', messageId: 'm-exp' });
        seat.emit({ type: 'message-complete', messageId: 'm-exp' });
      }, 5);
    };
    h.rooms.set('room-1', makeRoom('room-1', ['human', 'hermes']));
    const created = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Auto Q for hermes',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      defaultOptionId: 'a',
      expiresAt: Date.now() - 1,
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    h.ctx.setPollsState(created.state);

    sweepAndSettlePolls(h.ctx);
    // sweepAndSettlePolls's notify is fire-and-forget; wait for the seat's
    // reply to fully commit (incl. persistDatabase) before asserting and
    // before afterEach tears down the temp data dir.
    await waitForSeatReplyCommits(h, 'hermes', 1);
    expect(seat.sent.length).toBeGreaterThan(0);
  });
});

describe('broadcastPollUpdated', () => {
  it('broadcasts a poll.updated event carrying the full poll', async () => {
    const h = await buildHarness();
    const created = createPoll(h.pollsState, {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'human',
    });
    if (!created.ok) throw new Error('setup failed');
    broadcastPollUpdated(h.ctx, created.poll);
    const evt = h.broadcastedEvents.find((e) => e.type === 'poll.updated');
    expect(evt).toBeTruthy();
    expect((evt as unknown as { payload: { id: string } }).payload.id).toBe(created.poll.id);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  });
});
