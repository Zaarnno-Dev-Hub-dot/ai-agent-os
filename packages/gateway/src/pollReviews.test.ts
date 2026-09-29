import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AdapterManifest, AgentEvent, AgentSession, AgentState, CostReport, Message, Room, ServerEvent } from '@agent-os/shared';
import { openDatabase, type SqlDatabase } from './db.js';
import type { RelayDeps, RoomRelayState } from './relay.js';
import { registerAgentRelay, unregisterAgentRelay } from './relay.js';
import { BridgeWaitRegistry } from './bridge.js';
import { createPoll, findPoll, type Poll, type PollsState } from './polls.js';
import { handlePollDecide, registerPollsRoute, type PollsRouteContext } from './pollsRoutes.js';
import { registerWorkshopRoute, type WorkshopRouteContext } from './workshopRoutes.js';
import {
  PollReviewTracker,
  applyPollReviewsSchema,
  onPollSettled,
  onSeatDisconnected,
  registerPollReviewRoutes,
  startPollReview,
  type PollReviewRouteContext,
} from './pollReviews.js';
import { loadPollReviewById, loadReviewsForPoll } from './pollReviewsDb.js';
import type { ReviewPolicyState } from './reviewPolicy.js';

// ============================================================================
// Shared fixtures
// ============================================================================

function run(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function must(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-repo-'));
  must(dir, ['init', '-q', '-b', 'main']);
  must(dir, ['config', 'user.email', 'test@example.com']);
  must(dir, ['config', 'user.name', 'Test']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'existing.md'), 'original content\n', 'utf8');
  must(dir, ['add', '-A']);
  must(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}
function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'review-data-'));
}
function seedDraft(dataDir: string, seatId: string, taskSlug: string, manifest: unknown, files: Record<string, string>): void {
  const dir = join(dataDir, 'workspaces', seatId, 'workshop', taskSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest), 'utf8');
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}
async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 15): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function baseManifest(id: string, harness: AdapterManifest['harness']): AdapterManifest {
  return {
    id,
    displayName: id,
    harness,
    flavor: 'cli-stream',
    avatar: '✦',
    color: '#000',
    capabilities: [],
    identity: { modelPattern: '^test' },
    trust: 'full',
    manifestVersion: 1,
    billing: { kind: harness === 'homebrew' ? 'local' : 'subscription' },
  };
}
/** ollama-shaped: `verification: 'attested'` cast the same way attestedVerifier.ts's isAttestedManifest reads it (packages/shared frozen, no such field on the type). */
function attestedManifest(id: string): AdapterManifest {
  return { ...baseManifest(id, 'homebrew'), ...( { verification: 'attested' } as unknown as Partial<AdapterManifest>) };
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

function verifiedState(manifest: AdapterManifest, session?: AgentSession): AgentState {
  return {
    manifest,
    config: { transport: {} },
    status: 'VERIFIED',
    session,
    lastHeartbeat: Date.now(),
    assignedRooms: [],
    challengeHistory: [],
  };
}

function verdictReply(verdict: 'approve' | 'concerns' | 'reject', findings: string[] = []): string {
  return '```verdict\n' + JSON.stringify({ verdict, findings }) + '\n```';
}

// ============================================================================
// Full harness — REAL Fastify + real relay wiring (small real timeouts, no
// fake timers) for the integration-shaped tests (happy path / one-down /
// isolation). This is production's ACTUAL wiring shape: workshop propose ->
// startPollReview hook -> review wakes -> handlePollDecide.
// ============================================================================

interface FullHarness {
  fastify: FastifyInstance;
  baseUrl: string;
  db: SqlDatabase;
  dataDir: string;
  projectRoot: string;
  agents: Map<string, AgentState>;
  rooms: Map<string, Room>;
  messages: Map<string, Message[]>;
  sessions: Map<string, FakeSession>;
  tracker: PollReviewTracker;
  reviewPolicy: ReviewPolicyState;
  pollsCtx: PollsRouteContext;
  reviewsCtx: PollReviewRouteContext;
  getPollsState: () => PollsState;
  humanToken: string;
  postSystemLines: Array<{ roomId: string; content: string }>;
}

async function buildFullHarness(opts?: { wakeTimeoutMs?: number; cardDeadlineMs?: number }): Promise<FullHarness> {
  const dataDir = freshDataDir();
  const projectRoot = freshRepo();
  const db = await openDatabase(dataDir);
  applyPollReviewsSchema(db);

  const agents = new Map<string, AgentState>();
  const rooms = new Map<string, Room>();
  const messages = new Map<string, Message[]>();
  const roomRelay = new Map<string, RoomRelayState>();
  const globalCost: CostReport = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
  const sessions = new Map<string, FakeSession>();
  const postSystemLines: Array<{ roomId: string; content: string }> = [];
  const humanToken = 'full-harness-token';
  // SAME BridgeWaitRegistry instance threaded into reviewsCtx.waits below —
  // must be observed against every message.new from broadcast() (mirroring
  // index.ts's own broadcast() hook exactly; that hook is what actually
  // resolves a pending review wake when the seat's reply lands).
  const waits = new BridgeWaitRegistry();

  function broadcast(event: ServerEvent): void {
    if (event.type === 'message.new') {
      const msg = event.payload;
      waits.observe(msg.roomId, msg.senderId, { messageId: msg.id, text: msg.content, senderId: msg.senderId, ts: msg.createdAt, replyTo: msg.replyTo });
    }
  }
  function markBusy(): void {}
  function postSystemLine(roomId: string, content: string): void {
    postSystemLines.push({ roomId, content });
  }
  function persistRoomMutation(room: Room): void {
    rooms.set(room.id, room);
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
  let reviewPolicy: ReviewPolicyState = { mode: 'mutations' };
  const tracker = new PollReviewTracker();

  const reviewsCtx: PollReviewRouteContext = {
    relayDeps,
    agents,
    rooms,
    messages,
    db,
    dataDir,
    projectRoot,
    defaultRoomTurnCap: 12,
    broadcast,
    markBusy,
    persistRoomMutation,
    postSystemLine,
    waits,
    getReviewPolicy: () => reviewPolicy,
    setReviewPolicy: (s) => {
      reviewPolicy = s;
    },
    getPoll: (pollId) => findPoll(pollsState, pollId),
    humanToken,
    getPollsState: () => pollsState,
    wakeTimeoutMs: opts?.wakeTimeoutMs,
    cardDeadlineMs: opts?.cardDeadlineMs,
  };

  const pollsCtx: PollsRouteContext = {
    relayDeps,
    agents,
    rooms,
    messages,
    db,
    dataDir,
    projectRoot,
    paperclipBaseUrl: 'http://127.0.0.1:1',
    getPollsState: () => pollsState,
    setPollsState: (s) => {
      pollsState = s;
    },
    broadcast,
    markBusy,
    broadcastStateSync: () => {},
    postSystemLine,
    humanToken,
    onPollSettled: (poll) => onPollSettled(reviewsCtx, tracker, poll),
  };

  const workshopCtx: WorkshopRouteContext = {
    rooms,
    dataDir,
    projectRoot,
    defaultRoomTurnCap: 12,
    getPollsState: () => pollsState,
    setPollsState: (s) => {
      pollsState = s;
    },
    broadcast,
    broadcastStateSync: () => {},
    postSystemLine,
    persistRoomMutation,
    onPollProposed: (poll) => startPollReview(reviewsCtx, tracker, poll, 'workshop-propose'),
  };

  const fastify = Fastify({ logger: false });
  registerWorkshopRoute(fastify, workshopCtx);
  registerPollsRoute(fastify, pollsCtx);
  registerPollReviewRoutes(fastify, reviewsCtx);
  const baseUrl = await fastify.listen({ port: 0, host: '127.0.0.1' });

  return {
    fastify,
    baseUrl,
    db,
    dataDir,
    projectRoot,
    agents,
    rooms,
    messages,
    sessions,
    tracker,
    get reviewPolicy() {
      return reviewPolicy;
    },
    pollsCtx,
    reviewsCtx,
    getPollsState: () => pollsState,
    humanToken,
    postSystemLines,
  } as unknown as FullHarness;
}

function addReviewerSeat(h: FullHarness, id: string, manifest: AdapterManifest): FakeSession {
  const session = new FakeSession();
  h.agents.set(id, verifiedState(manifest, session));
  registerAgentRelay(id, session, h.pollsCtx.relayDeps, manifest.trust);
  h.sessions.set(id, session);
  return session;
}

/** Auto-reply a seat's NEXT turn with a fixed verdict block, delivered a few ms after send() is called (mirrors the existing FakeSession pattern in pollsRoutes.test.ts / workshopRoutes.test.ts). */
function autoReplyOnce(session: FakeSession, text: string, delayMs = 10): void {
  session.sendImpl = () => {
    setTimeout(() => {
      session.emit({ type: 'token', delta: text, messageId: 'm1' });
      session.emit({ type: 'message-complete', messageId: 'm1' });
    }, delayMs);
  };
}

async function propose(baseUrl: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/workshop/propose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

// ============================================================================
// Happy path: propose (covered action) -> both reviewers wake, isolated ->
// both attach valid verdicts -> human decide.
// ============================================================================

describe('end-to-end: propose -> 2 verdicts -> human decide', () => {
  let h: FullHarness;
  beforeEach(async () => {
    h = await buildFullHarness();
    h.agents.set('claude-code', verifiedState(baseManifest('claude-code', 'claude-code'))); // proposer, no session needed
  });
  afterEach(async () => {
    for (const id of h.sessions.keys()) unregisterAgentRelay(id);
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
    rmSync(h.projectRoot, { recursive: true, force: true });
  });

  it('assigns an attested + a diverse-family reviewer, both attach, and decide still works normally', async () => {
    const ollama = addReviewerSeat(h, 'ollama', attestedManifest('ollama'));
    const grok = addReviewerSeat(h, 'grok-build', baseManifest('grok-build', 'grok-build'));
    autoReplyOnce(ollama, verdictReply('approve'));
    autoReplyOnce(grok, verdictReply('concerns', ['minor nit']));

    seedDraft(h.dataDir, 'claude-code', 'feat-1', { title: 'Add feature', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/feat.md' }] }, {
      'draft.md': 'feature content\n',
    });
    const { status, json: poll } = await propose(h.baseUrl, { seatId: 'claude-code', taskSlug: 'feat-1' });
    expect(status).toBe(200);

    await waitUntil(() => {
      const reviews = loadReviewsForPoll(h.db, poll.id);
      return reviews.length === 2 && reviews.every((r) => r.status === 'attached');
    });

    const reviews = loadReviewsForPoll(h.db, poll.id);
    expect(reviews.find((r) => r.seatId === 'ollama')).toMatchObject({ slot: 1, family: 'homebrew', verdict: 'approve', parseOk: true });
    expect(reviews.find((r) => r.seatId === 'grok-build')).toMatchObject({ slot: 2, family: 'grok-build', verdict: 'concerns', parseOk: true, findings: ['minor nit'] });

    // Reviews are advisory only — decide still runs through the ordinary
    // humanToken-gated path, unaffected by verdict content.
    const outcome = handlePollDecide(h.pollsCtx, poll.id, 'approve', 'human', undefined, h.humanToken);
    expect(outcome.ok).toBe(true);

    await waitUntil(() => h.postSystemLines.some((l) => l.content.includes('workshop applied')));
    const backfilled = loadReviewsForPoll(h.db, poll.id);
    expect(backfilled.every((r) => r.status === 'attached')).toBe(true); // settle backfill doesn't clobber attached rows
  }, 15000);

  it('no auto-approve / no reviewer veto: BOTH reviewers reject, yet a human "approve" decide still applies the workshop change exactly as if no reviews existed', async () => {
    const ollama = addReviewerSeat(h, 'ollama', attestedManifest('ollama'));
    const grok = addReviewerSeat(h, 'grok-build', baseManifest('grok-build', 'grok-build'));
    autoReplyOnce(ollama, verdictReply('reject', ['ollama: this is broken']));
    autoReplyOnce(grok, verdictReply('reject', ['grok-build: also broken']));

    seedDraft(h.dataDir, 'claude-code', 'feat-veto', { title: 'Both reject', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/veto.md' }] }, {
      'draft.md': 'x\n',
    });
    const { json: poll } = await propose(h.baseUrl, { seatId: 'claude-code', taskSlug: 'feat-veto' });

    await waitUntil(() => {
      const reviews = loadReviewsForPoll(h.db, poll.id);
      return reviews.length === 2 && reviews.every((r) => r.verdict === 'reject');
    });

    // Verdicts are advisory-only ledger data — decidePoll/handlePollDecide
    // have no parameter, branch, or lookup that reads PollReview at all
    // (grep-verifiable: neither pollsRoutes.ts nor polls.ts imports
    // anything from pollReviews.ts/pollReviewsDb.ts). A human "approve"
    // still applies the change.
    const outcome = handlePollDecide(h.pollsCtx, poll.id, 'approve', 'human', undefined, h.humanToken);
    expect(outcome.ok).toBe(true);

    await waitUntil(() => h.postSystemLines.some((l) => l.content.includes('workshop applied')));
    const branchLine = h.postSystemLines.find((l) => l.content.includes('workshop applied'));
    expect(branchLine?.content).toContain('workshop/feat-veto');
  }, 15000);

  it('isolation: reviewer 2 never sees reviewer 1\'s seat id, room, or reply — separate rooms, disjoint message histories', async () => {
    const ollama = addReviewerSeat(h, 'ollama', attestedManifest('ollama'));
    const grok = addReviewerSeat(h, 'grok-build', baseManifest('grok-build', 'grok-build'));
    autoReplyOnce(ollama, verdictReply('reject', ['ollama found a real bug: XSS in the diff']));
    autoReplyOnce(grok, verdictReply('approve'));

    seedDraft(h.dataDir, 'claude-code', 'feat-2', { title: 'Isolation check', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/iso.md' }] }, {
      'draft.md': 'x\n',
    });
    const { json: poll } = await propose(h.baseUrl, { seatId: 'claude-code', taskSlug: 'feat-2' });

    await waitUntil(() => {
      const reviews = loadReviewsForPoll(h.db, poll.id);
      return reviews.length === 2 && reviews.every((r) => r.status === 'attached');
    });

    const room1 = Array.from(h.rooms.values()).find((r) => r.name === 'Review — ollama');
    const room2 = Array.from(h.rooms.values()).find((r) => r.name === 'Review — grok-build');
    expect(room1).toBeTruthy();
    expect(room2).toBeTruthy();
    expect(room1!.id).not.toBe(room2!.id);
    expect(room1!.memberIds).toEqual(['ollama']);
    expect(room2!.memberIds).toEqual(['grok-build']);

    const room1Text = (h.messages.get(room1!.id) ?? []).map((m) => m.content).join('\n');
    const room2Text = (h.messages.get(room2!.id) ?? []).map((m) => m.content).join('\n');
    // Reviewer 2's room must contain no trace of reviewer 1's identity or verdict.
    expect(room2Text).not.toContain('ollama');
    expect(room2Text.toLowerCase()).not.toContain('xss');
    // And vice versa.
    expect(room1Text).not.toContain('grok-build');
  }, 15000);

  it('one-reviewer-down: the responsive reviewer still attaches; the silent one times out and a substitute is assigned', async () => {
    const h2 = await buildFullHarness({ wakeTimeoutMs: 60, cardDeadlineMs: 500 });
    try {
      h2.agents.set('claude-code', verifiedState(baseManifest('claude-code', 'claude-code')));
      const ollama = addReviewerSeat(h2, 'ollama', attestedManifest('ollama'));
      addReviewerSeat(h2, 'ollama2', attestedManifest('ollama2')); // substitute candidate for slot 1
      const grok = addReviewerSeat(h2, 'grok-build', baseManifest('grok-build', 'grok-build'));
      autoReplyOnce(grok, verdictReply('approve')); // slot 2 responds promptly
      // ollama (slot 1) NEVER replies — no sendImpl set — forcing the wake to time out.

      seedDraft(h2.dataDir, 'claude-code', 'feat-3', { title: 'One down', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/down.md' }] }, {
        'draft.md': 'x\n',
      });
      const { json: poll } = await propose(h2.baseUrl, { seatId: 'claude-code', taskSlug: 'feat-3' });

      // slot 2 (grok-build) attaches quickly.
      await waitUntil(() => loadReviewsForPoll(h2.db, poll.id).some((r) => r.seatId === 'grok-build' && r.status === 'attached'));

      // slot 1 (ollama) times out at wakeTimeoutMs and a substitute (ollama2) is assigned.
      await waitUntil(() => {
        const reviews = loadReviewsForPoll(h2.db, poll.id);
        const original = reviews.find((r) => r.seatId === 'ollama');
        const substitute = reviews.find((r) => r.seatId === 'ollama2');
        return original?.status === 'substituted' && substitute != null && substitute.substituteForReviewId === original!.id;
      }, 3000);

      const reviews = loadReviewsForPoll(h2.db, poll.id);
      expect(reviews).toHaveLength(3); // slot1-original + slot1-substitute + slot2
      expect(reviews.find((r) => r.seatId === 'grok-build')?.verdict).toBe('approve');

      // Decide still proceeds fine — a timed-out reviewer never gates it.
      const outcome = handlePollDecide(h2.pollsCtx, poll.id, 'reject', 'human', undefined, h2.humanToken);
      expect(outcome.ok).toBe(true);
    } finally {
      for (const id of h2.sessions.keys()) unregisterAgentRelay(id);
      await h2.fastify.close();
      rmSync(h2.dataDir, { recursive: true, force: true });
      rmSync(h2.projectRoot, { recursive: true, force: true });
    }
  }, 15000);

  it('zero eligible reviewers: propose still succeeds (fail-open) and decide is unaffected', async () => {
    // Only the proposer is VERIFIED — no attested seat, no diverse full-harness seat.
    seedDraft(h.dataDir, 'claude-code', 'feat-4', { title: 'No reviewers available', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/none.md' }] }, {
      'draft.md': 'x\n',
    });
    const { status, json: poll } = await propose(h.baseUrl, { seatId: 'claude-code', taskSlug: 'feat-4' });
    expect(status).toBe(200);
    await waitUntil(() => h.postSystemLines.some((l) => l.content.includes('no reviewers assigned')));
    expect(loadReviewsForPoll(h.db, poll.id)).toHaveLength(0);

    const outcome = handlePollDecide(h.pollsCtx, poll.id, 'approve', 'human', undefined, h.humanToken);
    expect(outcome.ok).toBe(true);
  });

  it('review_policy=off: no reviews are ever created for a covered action', async () => {
    h.reviewsCtx.setReviewPolicy({ mode: 'off' });
    addReviewerSeat(h, 'ollama', attestedManifest('ollama'));
    addReviewerSeat(h, 'grok-build', baseManifest('grok-build', 'grok-build'));
    seedDraft(h.dataDir, 'claude-code', 'feat-5', { title: 'Policy off', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/off.md' }] }, { 'draft.md': 'x\n' });
    const { json: poll } = await propose(h.baseUrl, { seatId: 'claude-code', taskSlug: 'feat-5' });
    await new Promise((r) => setTimeout(r, 60));
    expect(loadReviewsForPoll(h.db, poll.id)).toHaveLength(0);
  });
});

// ============================================================================
// review_policy REST route + humanToken gate + per-finding validity + digest
// ============================================================================

describe('review_policy routes', () => {
  let h: FullHarness;
  beforeEach(async () => {
    h = await buildFullHarness();
  });
  afterEach(async () => {
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
    rmSync(h.projectRoot, { recursive: true, force: true });
  });

  it('GET returns the current mode', async () => {
    const res = await fetch(`${h.baseUrl}/api/review-policy`);
    expect(await res.json()).toEqual({ mode: 'mutations' });
  });

  it('POST without humanToken is rejected (401), mode unchanged', async () => {
    const res = await fetch(`${h.baseUrl}/api/review-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all' }),
    });
    expect(res.status).toBe(401);
    expect(h.reviewPolicy.mode).toBe('mutations');
  });

  it('POST with the WRONG humanToken is rejected (401)', async () => {
    const res = await fetch(`${h.baseUrl}/api/review-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all', humanToken: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST with the correct humanToken toggles the mode', async () => {
    const res = await fetch(`${h.baseUrl}/api/review-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'off', humanToken: h.humanToken }),
    });
    expect(res.status).toBe(200);
    expect(h.reviewPolicy.mode).toBe('off');
  });

  it('POST rejects an invalid mode value even with a correct token', async () => {
    const res = await fetch(`${h.baseUrl}/api/review-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'yolo', humanToken: h.humanToken }),
    });
    expect(res.status).toBe(400);
  });
});

describe('per-finding validity toggle + digest route', () => {
  let h: FullHarness;
  beforeEach(async () => {
    h = await buildFullHarness();
  });
  afterEach(async () => {
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
    rmSync(h.projectRoot, { recursive: true, force: true });
  });

  it('toggles a finding valid, then invalid, then back to unmarked — no humanToken required', async () => {
    const { insertPollReview, insertFindings } = await import('./pollReviewsDb.js');
    insertPollReview(h.db, { id: 'r1', pollId: 'p1', seatId: 'ollama', family: 'homebrew', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    insertFindings(h.db, 'r1', ['a real bug']);

    const mark = async (valid: boolean | null) =>
      fetch(`${h.baseUrl}/api/poll-reviews/r1/findings/0`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valid }),
      });

    let res = await mark(true);
    expect(res.status).toBe(200);
    expect((await res.json()).findingValid).toEqual([true]);

    res = await mark(false);
    expect((await res.json()).findingValid).toEqual([false]);

    res = await mark(null);
    // JSON has no `undefined` — an `undefined` array element serializes as
    // `null` over the wire (this is a transport-encoding fact, not a review
    // semantics change: pollReviewsDb.test.ts's direct-DB round-trip above
    // already asserts the in-process shape is `undefined`).
    expect((await res.json()).findingValid).toEqual([null]);
  });

  it('404s for an unknown reviewId', async () => {
    const res = await fetch(`${h.baseUrl}/api/poll-reviews/ghost/findings/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid: true }),
    });
    expect(res.status).toBe(404);
  });

  it('digest route returns the computed shape', async () => {
    const res = await fetch(`${h.baseUrl}/api/poll-reviews/digest`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('trueCatchCount');
    expect(json).toHaveProperty('precisionBySeat');
    expect(json).toHaveProperty('redOverrides');
  });
});

// ============================================================================
// Disconnect-mid-review: timeout, logged, NO re-selection.
// Direct-context test (no HTTP) — exercises onSeatDisconnected/startPollReview
// against a hand-built ctx, matching pollReviews.ts's own unit-test seam.
// ============================================================================

describe('onSeatDisconnected — disconnect-mid-review', () => {
  it('marks the seat\'s pending review timed-out immediately and spawns NO substitute', async () => {
    const dataDir = freshDataDir();
    const db = await openDatabase(dataDir);
    applyPollReviewsSchema(db);
    const agents = new Map<string, AgentState>();
    const rooms = new Map<string, Room>();
    const messages = new Map<string, Message[]>();
    const roomRelay = new Map<string, RoomRelayState>();
    const globalCost: CostReport = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
    const relayDeps: RelayDeps = { db, dataDir, agents, rooms, messages, roomRelay, globalCost, broadcast: () => {}, agentDisplayName: (id) => id };

    const proposer = 'claude-code';
    agents.set(proposer, verifiedState(baseManifest(proposer, 'claude-code')));
    const ollama = addBareSeat(agents, relayDeps, 'ollama', attestedManifest('ollama'));
    addBareSeat(agents, relayDeps, 'ollama2', attestedManifest('ollama2')); // would-be substitute — must NOT be used
    addBareSeat(agents, relayDeps, 'grok-build', baseManifest('grok-build', 'grok-build')); // never replies either — irrelevant to this assertion

    const poll: Poll = {
      id: 'poll-1',
      roomId: 'room-1',
      question: 'Disconnect test',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: proposer,
      createdAt: Date.now(),
      status: 'open',
      source: 'workshop',
    };
    let pollsState: PollsState = { polls: [poll] };
    let reviewPolicy: ReviewPolicyState = { mode: 'mutations' };
    const ctx: PollReviewRouteContext = {
      relayDeps,
      agents,
      rooms,
      messages,
      db,
      dataDir,
      projectRoot: dataDir,
      defaultRoomTurnCap: 12,
      broadcast: () => {},
      markBusy: () => {},
      persistRoomMutation: (room) => rooms.set(room.id, room),
      postSystemLine: () => {},
      waits: new BridgeWaitRegistry(),
      getReviewPolicy: () => reviewPolicy,
      setReviewPolicy: (s) => {
        reviewPolicy = s;
      },
      getPoll: (pollId) => pollsState.polls.find((p) => p.id === pollId),
      humanToken: 'x',
      getPollsState: () => pollsState,
      wakeTimeoutMs: 5 * 60_000, // long enough that the natural timeout never fires during this test
      cardDeadlineMs: 10 * 60_000,
    };

    const tracker = new PollReviewTracker();
    startPollReview(ctx, tracker, poll, 'workshop-propose');

    await waitUntil(() => loadReviewsForPoll(db, poll.id).some((r) => r.seatId === 'ollama' && r.status === 'pending'));

    onSeatDisconnected(ctx, tracker, 'ollama');

    const reviews = loadReviewsForPoll(db, poll.id);
    const ollamaReview = reviews.find((r) => r.seatId === 'ollama');
    expect(ollamaReview?.status).toBe('timed-out');
    // NO re-selection: ollama2 must never have been woken as a result of the disconnect.
    expect(reviews.find((r) => r.seatId === 'ollama2')).toBeUndefined();
    expect(reviews).toHaveLength(2); // exactly the original slot-1 (ollama) + slot-2 rows, no third row

    rmSync(dataDir, { recursive: true, force: true });
  });
});

function addBareSeat(agents: Map<string, AgentState>, relayDeps: RelayDeps, id: string, manifest: AdapterManifest): FakeSession {
  const session = new FakeSession();
  agents.set(id, verifiedState(manifest, session));
  registerAgentRelay(id, session, relayDeps, manifest.trust);
  return session;
}

// ============================================================================
// Timeout math (fake timers) — design doc F7: 4-min wake / parallel T+4
// substitute / 10-min card deadline. No HTTP, no registered relay workers
// (nobody replies, on purpose) — isolates the pure timer/state-machine
// behavior from any real socket/watchdog interaction. Small injected
// wakeTimeoutMs/cardDeadlineMs exercise the EXACT SAME algorithm as the
// 4-min/10-min production defaults without needing to fast-forward that far.
// ============================================================================

describe('timeout math (fake timers)', () => {
  it('both originals time out at T+wake; substitutes wake IN PARALLEL (same tick); substitutes themselves time out at T+2*wake with NO further chaining; card deadline at T+deadline is then a no-op (everything already resolved)', async () => {
    const dataDir = freshDataDir();
    const db = await openDatabase(dataDir);
    applyPollReviewsSchema(db);
    const agents = new Map<string, AgentState>();
    const rooms = new Map<string, Room>();
    const messages = new Map<string, Message[]>();
    const roomRelay = new Map<string, RoomRelayState>();
    const globalCost: CostReport = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
    const relayDeps: RelayDeps = { db, dataDir, agents, rooms, messages, roomRelay, globalCost, broadcast: () => {}, agentDisplayName: (id) => id };

    const proposer = 'claude-code';
    agents.set(proposer, verifiedState(baseManifest(proposer, 'claude-code')));
    agents.set('ollama', verifiedState(attestedManifest('ollama'))); // slot-1 original
    agents.set('ollama2', verifiedState(attestedManifest('ollama2'))); // slot-1 substitute candidate
    agents.set('grok-build', verifiedState(baseManifest('grok-build', 'grok-build'))); // slot-2 original
    agents.set('openclaw', verifiedState(baseManifest('openclaw', 'openclaw'))); // slot-2 substitute candidate
    // No registerAgentRelay for any of them — relayMessageToAgents no-ops on
    // an unregistered agent (relay.ts: `if (!worker) continue;`), so nobody
    // ever replies and no TURN_WATCHDOG_MS interaction is possible here.

    const poll: Poll = {
      id: 'poll-timeout',
      roomId: 'room-1',
      question: 'Timeout math',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: proposer,
      createdAt: Date.now(),
      status: 'open',
      source: 'workshop',
    };
    const pollsState: PollsState = { polls: [poll] };
    let reviewPolicy: ReviewPolicyState = { mode: 'mutations' };
    const WAKE_MS = 1000;
    const DEADLINE_MS = 3500;
    const ctx: PollReviewRouteContext = {
      relayDeps,
      agents,
      rooms,
      messages,
      db,
      dataDir,
      projectRoot: dataDir,
      defaultRoomTurnCap: 12,
      broadcast: () => {},
      markBusy: () => {},
      persistRoomMutation: (room) => rooms.set(room.id, room),
      postSystemLine: () => {},
      waits: new BridgeWaitRegistry(),
      getReviewPolicy: () => reviewPolicy,
      setReviewPolicy: (s) => {
        reviewPolicy = s;
      },
      getPoll: (pollId) => pollsState.polls.find((p) => p.id === pollId),
      humanToken: 'x',
      getPollsState: () => pollsState,
      wakeTimeoutMs: WAKE_MS,
      cardDeadlineMs: DEADLINE_MS,
    };
    const tracker = new PollReviewTracker();

    vi.useFakeTimers();
    try {
      startPollReview(ctx, tracker, poll, 'workshop-propose');

      // Just before T+wake: both originals still pending.
      await vi.advanceTimersByTimeAsync(WAKE_MS - 1);
      let reviews = loadReviewsForPoll(db, poll.id);
      expect(reviews).toHaveLength(2);
      expect(reviews.every((r) => r.status === 'pending')).toBe(true);

      // Cross T+wake: both time out; a substitute is spawned for EACH slot
      // (parallel — neither substitute waits on the other original).
      await vi.advanceTimersByTimeAsync(2);
      reviews = loadReviewsForPoll(db, poll.id);
      expect(reviews).toHaveLength(4);
      const slot1Orig = reviews.find((r) => r.seatId === 'ollama')!;
      const slot1Sub = reviews.find((r) => r.seatId === 'ollama2')!;
      const slot2Orig = reviews.find((r) => r.seatId === 'grok-build')!;
      const slot2Sub = reviews.find((r) => r.seatId === 'openclaw')!;
      expect(slot1Orig.status).toBe('substituted');
      expect(slot2Orig.status).toBe('substituted');
      expect(slot1Sub.status).toBe('pending');
      expect(slot1Sub.substituteForReviewId).toBe(slot1Orig.id);
      expect(slot2Sub.status).toBe('pending');
      expect(slot2Sub.substituteForReviewId).toBe(slot2Orig.id);
      expect(slot1Sub.slot).toBe(1);
      expect(slot2Sub.slot).toBe(2);

      // Just before the substitutes' OWN wake window elapses (T+2*wake).
      await vi.advanceTimersByTimeAsync(WAKE_MS - 2);
      reviews = loadReviewsForPoll(db, poll.id);
      expect(reviews.find((r) => r.seatId === 'ollama2')?.status).toBe('pending');

      // Cross T+2*wake: substitutes time out too — capped at ONE substitute
      // per slot, so no third wave is spawned even though ollama/grok-build's
      // "family pool" would technically still have no other member here.
      await vi.advanceTimersByTimeAsync(4);
      reviews = loadReviewsForPoll(db, poll.id);
      expect(reviews).toHaveLength(4); // still exactly 4 — no chaining
      expect(reviews.find((r) => r.seatId === 'ollama2')?.status).toBe('timed-out');
      expect(reviews.find((r) => r.seatId === 'openclaw')?.status).toBe('timed-out');

      // Card deadline (T+3500, set at T+0) fires after everything already
      // resolved on its own — a documented no-op, not a crash or a
      // duplicate state transition.
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100);
      reviews = loadReviewsForPoll(db, poll.id);
      expect(reviews).toHaveLength(4);
      expect(reviews.every((r) => r.status === 'substituted' || r.status === 'timed-out')).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
