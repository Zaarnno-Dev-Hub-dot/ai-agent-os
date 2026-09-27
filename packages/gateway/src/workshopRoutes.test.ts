import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentState, Room, ServerEvent } from '@agent-os/shared';
import { createPoll, type Poll, type PollsState } from './polls.js';
import {
  applyWorkshopPoll,
  registerWorkshopRoute,
  type WorkshopApplyContext,
  type WorkshopRouteContext,
} from './workshopRoutes.js';
import { handlePollDecide, type PollsRouteContext } from './pollsRoutes.js';

/**
 * Wave 6, docs/DESIGN-workshop-flow.md. Same harness shape as
 * pollsRoutes.test.ts/bridge.test.ts: a REAL Fastify instance on an
 * ephemeral port, and — because this feature's whole point is running real
 * git commands — a REAL throwaway git repository (never the actual project
 * repo) standing in for `projectRoot`, torn down per test.
 */

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function must(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Polls a predicate rather than assuming a fixed delay is long enough — used
 * to wait on handlePollDecide's internal fire-and-forget settle (real git
 * subprocess calls, so timing varies more than the requester-notify/
 * Paperclip side effects pollsRoutes.test.ts's own fixed 30ms waits cover).
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A throwaway git repo (NEVER the real project repo) with one commit on `main`, docs/existing.md present so "modify an existing file" cases have something to diff against. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workshop-repo-'));
  must(dir, ['init', '-q', '-b', 'main']);
  must(dir, ['config', 'user.email', 'test@example.com']);
  must(dir, ['config', 'user.name', 'Test']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'existing.md'), 'original content\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), 'not touchable by workshop\n', 'utf8');
  must(dir, ['add', '-A']);
  must(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'workshop-data-'));
}

/** Fixed test humanToken (Wave 7 M3) — the propose->decide->apply e2e block below builds its own PollsRouteContext and must pass this exact value to handlePollDecide. */
const WORKSHOP_TEST_HUMAN_TOKEN = 'workshop-test-human-token-abcdef';

function seedDraft(
  dataDir: string,
  seatId: string,
  taskSlug: string,
  manifest: unknown,
  files: Record<string, string>
): void {
  const dir = join(dataDir, 'workspaces', seatId, 'workshop', taskSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest), 'utf8');
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

interface Harness {
  fastify: FastifyInstance;
  baseUrl: string;
  dataDir: string;
  projectRoot: string;
  rooms: Map<string, Room>;
  broadcastedEvents: ServerEvent[];
  postSystemLines: Array<{ roomId: string; content: string }>;
  ctx: WorkshopRouteContext;
  get pollsState(): PollsState;
  stateSyncCount: number;
}

async function buildHarness(projectRoot: string): Promise<Harness> {
  const dataDir = freshDataDir();
  const rooms = new Map<string, Room>();
  const broadcastedEvents: ServerEvent[] = [];
  const postSystemLines: Array<{ roomId: string; content: string }> = [];
  let pollsState: PollsState = { polls: [] };
  const state = { stateSyncCount: 0 };

  const ctx: WorkshopRouteContext = {
    rooms,
    dataDir,
    projectRoot,
    defaultRoomTurnCap: 12,
    getPollsState: () => pollsState,
    setPollsState: (s) => {
      pollsState = s;
    },
    broadcast: (event) => {
      broadcastedEvents.push(event);
    },
    broadcastStateSync: () => {
      state.stateSyncCount += 1;
    },
    postSystemLine: (roomId, content) => {
      postSystemLines.push({ roomId, content });
    },
    persistRoomMutation: (room) => {
      rooms.set(room.id, room);
    },
  };

  const fastify = Fastify({ logger: false });
  registerWorkshopRoute(fastify, ctx);
  const baseUrl = await fastify.listen({ port: 0, host: '127.0.0.1' });

  return {
    fastify,
    baseUrl,
    dataDir,
    projectRoot,
    rooms,
    broadcastedEvents,
    postSystemLines,
    ctx,
    get pollsState() {
      return pollsState;
    },
    get stateSyncCount() {
      return state.stateSyncCount;
    },
  } as unknown as Harness;
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

describe('POST /api/workshop/propose', () => {
  let h: Harness;
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = freshRepo();
    h = await buildHarness(projectRoot);
  });
  afterEach(async () => {
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('400s on a missing seatId', async () => {
    const { status, json } = await propose(h.baseUrl, { taskSlug: 'add-thing' });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });

  it('400s on an invalid taskSlug', async () => {
    const { status } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: '../etc' });
    expect(status).toBe(400);
  });

  it('400s when no draft directory exists for that seat/slug', async () => {
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'ghost-task' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/no draft/i);
  });

  it('400s when MANIFEST.json is missing', async () => {
    mkdirSync(join(h.dataDir, 'workspaces', 'hermes', 'workshop', 'no-manifest'), { recursive: true });
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'no-manifest' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/MANIFEST\.json/);
  });

  it('400s on invalid JSON in MANIFEST.json', async () => {
    const dir = join(h.dataDir, 'workspaces', 'hermes', 'workshop', 'bad-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MANIFEST.json'), '{not json', 'utf8');
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'bad-json' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/not valid JSON/);
  });

  it('400s on a manifest shape violation (missing title)', async () => {
    seedDraft(h.dataDir, 'hermes', 'no-title', { targets: [{ workspacePath: 'a.md', repoPath: 'docs/a.md' }] }, {
      'a.md': 'hi',
    });
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'no-title' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/title/i);
  });

  it('400s when a workspacePath file is missing from the draft', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'missing-file',
      { title: 'X', targets: [{ workspacePath: 'ghost.md', repoPath: 'docs/ghost.md' }] },
      {}
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'missing-file' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/not found/);
  });

  it('400s on a traversal repoPath', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'traversal',
      { title: 'X', targets: [{ workspacePath: 'a.md', repoPath: 'docs/../../../etc/passwd' }] },
      { 'a.md': 'hi' }
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'traversal' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/\.\./);
  });

  it('400s on a frozen repoPath (packages/gateway/src/relay.ts)', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'frozen',
      { title: 'X', targets: [{ workspacePath: 'a.ts', repoPath: 'packages/gateway/src/relay.ts' }] },
      { 'a.ts': 'export {};' }
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'frozen' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/frozen/i);
  });

  it('400s on a repoPath outside the v1 allowlist', async () => {
    seedDraft(h.dataDir, 'hermes', 'not-allowed', { title: 'X', targets: [{ workspacePath: 'a.md', repoPath: 'README.md' }] }, {
      'a.md': 'hi',
    });
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'not-allowed' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/allowlist/);
  });

  it('400s on an oversize file (>200KB)', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'oversize',
      { title: 'X', targets: [{ workspacePath: 'big.md', repoPath: 'docs/big.md' }] },
      { 'big.md': 'x'.repeat(200 * 1024 + 1) }
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'oversize' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/KB per-file cap/);
  });

  it('400s on a binary file', async () => {
    const dir = join(h.dataDir, 'workspaces', 'hermes', 'workshop', 'binary');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ title: 'X', targets: [{ workspacePath: 'img.md', repoPath: 'docs/img.md' }] }), 'utf8');
    writeFileSync(join(dir, 'img.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'binary' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/UTF-8/);
  });

  it('400s on a duplicate repoPath across two targets', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'dup',
      {
        title: 'X',
        targets: [
          { workspacePath: 'a.md', repoPath: 'docs/same.md' },
          { workspacePath: 'b.md', repoPath: 'docs/same.md' },
        ],
      },
      { 'a.md': 'one', 'b.md': 'two' }
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'dup' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Duplicate repoPath/);
  });

  it('creates a workshop poll for a brand-new file: diff against /dev/null, correct options/source, no defaultOptionId, audit system line + broadcasts', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'new-file',
      { title: 'Add a new doc', description: 'because reasons', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/brand-new.md' }] },
      { 'draft.md': 'hello\nworld\n' }
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'new-file' });
    expect(status).toBe(200);
    expect(json.source).toBe('workshop');
    expect(json.status).toBe('open');
    expect(json.defaultOptionId).toBeUndefined();
    expect(json.options).toEqual([
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ]);
    expect(json.requestedBy).toBe('hermes');
    expect(json.question).toBe('Add a new doc');
    expect(json.detail).toBe('because reasons');
    expect(json.diffAttachments).toHaveLength(1);
    expect(json.diffAttachments[0].repoPath).toBe('docs/brand-new.md');
    expect(json.diffAttachments[0].diff).toContain('/dev/null');
    expect(json.diffAttachments[0].diff).toContain('+hello');
    // Integration seam (Wave 6 merge): diffAttachments is also projected onto
    // the generic `attachments` field wave6/approvals-v2 shipped, as a
    // kind:'text' entry — this is what makes the diff actually show up in the
    // rich poll card (PollRichSections/pollPresent.ts render `attachments`,
    // not `diffAttachments`, which they have no knowledge of).
    expect(json.attachments).toHaveLength(1);
    expect(json.attachments[0].kind).toBe('text');
    expect(json.attachments[0].caption).toBe('docs/brand-new.md');
    expect(json.attachments[0].data).toBe(json.diffAttachments[0].diff);
    expect(json.workshopSnapshot.seatId).toBe('hermes');
    expect(json.workshopSnapshot.taskSlug).toBe('new-file');
    expect(json.workshopSnapshot.targets[0].content).toBe('hello\nworld\n');

    // Room found-or-created + poll actually lives in state.
    expect(h.rooms.size).toBe(1);
    const room = Array.from(h.rooms.values())[0];
    expect(room.name).toBe('Workshop');
    expect(room.memberIds).toEqual([]);
    expect(h.pollsState.polls).toHaveLength(1);

    // Audit trail: system line + broadcasts.
    expect(h.postSystemLines).toHaveLength(1);
    expect(h.postSystemLines[0].content).toContain('@hermes');
    expect(h.postSystemLines[0].content).toContain('Add a new doc');
    expect(h.postSystemLines[0].content).toContain('awaiting approval');
    expect(h.broadcastedEvents.some((e) => e.type === 'poll.updated')).toBe(true);
    expect(h.stateSyncCount).toBe(1);
  });

  it('creates a workshop poll for a MODIFIED existing file: diff shows old vs new, snapshot carries the NEW content', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'modify',
      { title: 'Tweak existing doc', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/existing.md' }] },
      { 'draft.md': 'changed content\n' }
    );
    const { status, json } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'modify' });
    expect(status).toBe(200);
    expect(json.diffAttachments[0].diff).toContain('-original content');
    expect(json.diffAttachments[0].diff).toContain('+changed content');
    expect(json.diffAttachments[0].diff).not.toContain('/dev/null');
    expect(json.workshopSnapshot.targets[0].content).toBe('changed content\n');
  });

  it('reuses the same Workshop room across multiple proposes', async () => {
    seedDraft(h.dataDir, 'hermes', 'first', { title: 'First', targets: [{ workspacePath: 'a.md', repoPath: 'docs/a1.md' }] }, {
      'a.md': 'one',
    });
    seedDraft(h.dataDir, 'hermes', 'second', { title: 'Second', targets: [{ workspacePath: 'a.md', repoPath: 'docs/a2.md' }] }, {
      'a.md': 'two',
    });
    await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'first' });
    await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'second' });
    expect(h.rooms.size).toBe(1);
    expect(h.pollsState.polls).toHaveLength(2);
  });
});

describe('applyWorkshopPoll', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = freshRepo();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function makePoll(overrides: Partial<Poll> = {}): Poll {
    const created = createPoll(
      { polls: [] },
      {
        roomId: 'workshop-room',
        question: 'Add a thing',
        detail: 'because reasons',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        requestedBy: 'hermes',
        source: 'workshop',
        workshopSnapshot: {
          seatId: 'hermes',
          taskSlug: `apply-test-${Math.random().toString(36).slice(2, 8)}`,
          targets: [{ repoPath: 'docs/new-from-apply.md', content: 'applied content\n' }],
        },
      }
    );
    if (!created.ok) throw new Error('setup failed: ' + created.error);
    return { ...created.poll, ...overrides };
  }

  it('applies a new file: branch created off main, correct content, commit message + Co-Authored-By trailer, worktree cleaned up, main untouched', async () => {
    const poll = makePoll();
    const ctx: WorkshopApplyContext = { projectRoot, agents: new Map() };
    const result = await applyWorkshopPoll(ctx, poll);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.branch).toBe(`workshop/${poll.workshopSnapshot!.taskSlug}`);
    expect(result.sha).toMatch(/^[0-9a-f]{7}$/);

    // Branch has the content, on ITS OWN commit.
    const show = must(projectRoot, ['show', `${result.branch}:docs/new-from-apply.md`]);
    expect(show).toBe('applied content\n');
    const log = must(projectRoot, ['log', '-1', '--format=%s%n%b', result.branch]);
    expect(log).toContain('workshop(hermes): Add a thing');
    expect(log).toContain('because reasons');
    expect(log).toContain('Co-Authored-By: hermes <hermes@agents.local>');
    const authorLine = must(projectRoot, ['log', '-1', '--format=%an <%ae> / %cn <%ce>', result.branch]).trim();
    expect(authorLine).toBe('Hermes Agent OS Workshop <workshop@agent-os.local> / Hermes Agent OS Workshop <workshop@agent-os.local>');

    // Worktree removed — only the main checkout remains registered.
    const wtList = must(projectRoot, ['worktree', 'list']);
    expect(wtList.trim().split('\n')).toHaveLength(1);

    // main is untouched.
    const mainLog = must(projectRoot, ['log', 'main', '--oneline']);
    expect(mainLog.trim().split('\n')).toHaveLength(1);
    expect(mainLog).toContain('init');
  });

  it('uses the seat manifest displayName in the Co-Authored-By trailer when the seat is known', async () => {
    const poll = makePoll();
    const agents = new Map<string, AgentState>();
    agents.set('hermes', {
      manifest: {
        id: 'hermes',
        displayName: 'Hermes',
        harness: 'hermes',
        flavor: 'http-openai',
        avatar: '✦',
        color: '#000',
        capabilities: [],
        identity: { modelPattern: '^hermes' },
      } as unknown as AgentState['manifest'],
      config: { transport: {} } as unknown as AgentState['config'],
      status: 'VERIFIED',
      lastHeartbeat: Date.now(),
      assignedRooms: [],
      challengeHistory: [],
    });
    const result = await applyWorkshopPoll({ projectRoot, agents }, poll);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const log = must(projectRoot, ['log', '-1', '--format=%b', result.branch]);
    expect(log).toContain('Co-Authored-By: Hermes <hermes@agents.local>');
  });

  it('modifies an existing file correctly and leaves main\'s copy unchanged', async () => {
    const created = createPoll(
      { polls: [] },
      {
        roomId: 'r',
        question: 'Update existing',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
        requestedBy: 'hermes',
        source: 'workshop',
        workshopSnapshot: {
          seatId: 'hermes',
          taskSlug: 'modify-apply',
          targets: [{ repoPath: 'docs/existing.md', content: 'modified via workshop\n' }],
        },
      }
    );
    if (!created.ok) throw new Error('setup failed');
    const result = await applyWorkshopPoll({ projectRoot, agents: new Map() }, created.poll);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const onBranch = must(projectRoot, ['show', `${result.branch}:docs/existing.md`]);
    expect(onBranch).toBe('modified via workshop\n');
    const onMain = must(projectRoot, ['show', 'main:docs/existing.md']);
    expect(onMain).toBe('original content\n');
  });

  it('fails closed when the branch already exists, leaving the pre-existing branch untouched and no stray worktree', async () => {
    must(projectRoot, ['branch', 'workshop/collide']);
    const poll = makePoll({
      workshopSnapshot: { seatId: 'hermes', taskSlug: 'collide', targets: [{ repoPath: 'docs/x.md', content: 'x' }] },
    });
    const result = await applyWorkshopPoll({ projectRoot, agents: new Map() }, poll);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already exists/);
    const wtList = must(projectRoot, ['worktree', 'list']);
    expect(wtList.trim().split('\n')).toHaveLength(1);
    const branchSha = must(projectRoot, ['rev-parse', 'workshop/collide']);
    const mainSha = must(projectRoot, ['rev-parse', 'main']);
    expect(branchSha).toBe(mainSha); // untouched — still points exactly at main's commit, nothing applied
  });

  it('rolls back the branch AND worktree on a mid-apply failure, leaving no trace', async () => {
    // docs/existing.md is a FILE on main; targeting a repoPath that tries to
    // use it as a DIRECTORY makes the write step's mkdirSync fail for real —
    // no mocking of child_process needed to exercise the cleanup path.
    const poll = makePoll({
      workshopSnapshot: {
        seatId: 'hermes',
        taskSlug: 'mid-fail',
        targets: [{ repoPath: 'docs/existing.md/nested.md', content: 'x' }],
      },
    });
    const result = await applyWorkshopPoll({ projectRoot, agents: new Map() }, poll);
    expect(result.ok).toBe(false);

    const wtList = must(projectRoot, ['worktree', 'list']);
    expect(wtList.trim().split('\n')).toHaveLength(1); // no stray worktree left registered
    const branchCheck = run(projectRoot, ['rev-parse', '--verify', '--quiet', 'workshop/mid-fail']);
    expect(branchCheck.status).not.toBe(0); // branch was rolled back, not left dangling with no commit
  });

  it('returns ok:false when the poll has no workshopSnapshot', async () => {
    const created = createPoll(
      { polls: [] },
      {
        roomId: 'r',
        question: 'Q',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
        requestedBy: 'hermes',
        source: 'workshop',
      }
    );
    if (!created.ok) throw new Error('setup failed');
    const result = await applyWorkshopPoll({ projectRoot, agents: new Map() }, created.poll);
    expect(result.ok).toBe(false);
  });

  it('refuses to apply a snapshot whose repoPath escapes the allowlist (traversal), creating no branch or worktree', async () => {
    const poll = makePoll({
      workshopSnapshot: {
        seatId: 'hermes',
        taskSlug: 'evil-traversal',
        targets: [{ repoPath: '../evil.md', content: 'pwned\n' }],
      },
    });
    const result = await applyWorkshopPoll({ projectRoot, agents: new Map() }, poll);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/refus/i);
    // Failed before touching git: no branch, no stray worktree.
    const branchCheck = run(projectRoot, ['rev-parse', '--verify', '--quiet', 'workshop/evil-traversal']);
    expect(branchCheck.status).not.toBe(0);
    const wtList = must(projectRoot, ['worktree', 'list']);
    expect(wtList.trim().split('\n')).toHaveLength(1);
  });

  it('refuses to apply a snapshot targeting a frozen path (packages/gateway/src/relay.ts), creating no branch', async () => {
    const poll = makePoll({
      workshopSnapshot: {
        seatId: 'hermes',
        taskSlug: 'evil-frozen',
        targets: [{ repoPath: 'packages/gateway/src/relay.ts', content: 'pwned\n' }],
      },
    });
    const result = await applyWorkshopPoll({ projectRoot, agents: new Map() }, poll);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/frozen|refus/i);
    const branchCheck = run(projectRoot, ['rev-parse', '--verify', '--quiet', 'workshop/evil-frozen']);
    expect(branchCheck.status).not.toBe(0);
  });
});

describe('end-to-end: propose -> decide -> apply (real HTTP route + real polls wiring + real git)', () => {
  let projectRoot: string;
  let h: Harness;
  let pollsCtx: PollsRouteContext;

  beforeEach(async () => {
    projectRoot = freshRepo();
    h = await buildHarness(projectRoot);

    // Wire a REAL PollsRouteContext sharing the SAME pollsState closure as
    // the workshop route's ctx, exactly like index.ts's pollsRouteCtx and
    // workshopRouteCtx share one `pollsState` variable in production. No
    // second Fastify instance needed — handlePollDecide is called directly.
    // NOTE: handlePollDecide already fires notifyPollSettled itself
    // (fire-and-forget, via settlePollAsync) — these tests do NOT also call
    // notifyPollSettled a second time (unlike pollsRoutes.test.ts's own
    // requester-notify tests, where a duplicate fire-and-forget racing an
    // explicit awaited call only sends one extra harmless chat message /
    // stub-POST). For workshop-apply a second invocation is NOT harmless —
    // it collides with the first on the SAME branch name — so these tests
    // poll for the git-visible outcome instead (waitUntil below) to observe
    // the ONE real settle, exactly like production.
    pollsCtx = {
      relayDeps: {
        db: undefined as unknown as PollsRouteContext['db'],
        dataDir: h.dataDir,
        agents: new Map(),
        rooms: h.rooms,
        messages: new Map(),
        roomRelay: new Map(),
        globalCost: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} },
        broadcast: h.ctx.broadcast,
        agentDisplayName: (id: string) => id,
      } as unknown as PollsRouteContext['relayDeps'],
      agents: new Map(),
      rooms: h.rooms,
      messages: new Map(),
      db: undefined as unknown as PollsRouteContext['db'],
      dataDir: h.dataDir,
      projectRoot,
      paperclipBaseUrl: 'http://127.0.0.1:1',
      getPollsState: h.ctx.getPollsState,
      setPollsState: h.ctx.setPollsState,
      broadcast: h.ctx.broadcast,
      markBusy: () => {},
      broadcastStateSync: h.ctx.broadcastStateSync,
      postSystemLine: h.ctx.postSystemLine,
      humanToken: WORKSHOP_TEST_HUMAN_TOKEN,
    };
  });

  afterEach(async () => {
    await h.fastify.close();
    rmSync(h.dataDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('approve: branch lands with correct content + attribution, both the generic decide line and the workshop-applied line post, main untouched', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'e2e-approve',
      { title: 'E2E approve', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/e2e.md' }] },
      { 'draft.md': 'e2e content\n' }
    );
    const { status, json: poll } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'e2e-approve' });
    expect(status).toBe(200);

    const outcome = handlePollDecide(pollsCtx, poll.id, 'approve', 'human', undefined, WORKSHOP_TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Wait for the EXACT observable signal (the "workshop applied" system
    // line), not just branch-ref existence — `git worktree add -b` creates
    // the branch ref immediately, pointing at main, well before the actual
    // apply commit lands, so that alone would be a racy predicate here.
    const branch = 'workshop/e2e-approve';
    await waitUntil(() => h.postSystemLines.some((l) => l.content.includes('workshop applied')));

    const content = must(projectRoot, ['show', `${branch}:docs/e2e.md`]);
    expect(content).toBe('e2e content\n');

    const lines = h.postSystemLines.map((l) => l.content);
    expect(lines.some((l) => l.includes('poll decided') && l.includes('Approve'))).toBe(true);
    expect(lines.some((l) => l.includes('workshop applied') && l.includes(branch))).toBe(true);
    expect(lines.some((l) => l.includes('workshop apply FAILED'))).toBe(false);

    const mainLog = must(projectRoot, ['log', 'main', '--oneline']);
    expect(mainLog.trim().split('\n')).toHaveLength(1);
  });

  it('reject: nothing applied — no branch created, only the generic decide system line', async () => {
    seedDraft(
      h.dataDir,
      'hermes',
      'e2e-reject',
      { title: 'E2E reject', targets: [{ workspacePath: 'draft.md', repoPath: 'docs/e2e-r.md' }] },
      { 'draft.md': 'should never land\n' }
    );
    const { json: poll } = await propose(h.baseUrl, { seatId: 'hermes', taskSlug: 'e2e-reject' });

    const outcome = handlePollDecide(pollsCtx, poll.id, 'reject', 'human', undefined, WORKSHOP_TEST_HUMAN_TOKEN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The generic "poll decided" system line posts SYNCHRONOUSLY inside
    // handlePollDecide, before settlePollAsync's fire-and-forget even starts
    // — so it is not a usable "settle finished" signal here. Reject's
    // workshop branch in notifyPollSettled does no git/fs I/O at all (a
    // synchronous console.log only, see pollsRoutes.ts), so there is no
    // further positive signal to poll for either; a short fixed wait (same
    // idiom pollsRoutes.test.ts's own requester-notify tests use for this
    // exact "let the fire-and-forget finish" situation) is the honest choice.
    await new Promise((r) => setTimeout(r, 50));

    const branchCheck = run(projectRoot, ['rev-parse', '--verify', '--quiet', 'workshop/e2e-reject']);
    expect(branchCheck.status).not.toBe(0);

    const lines = h.postSystemLines.map((l) => l.content);
    expect(lines.some((l) => l.includes('poll decided') && l.includes('Reject'))).toBe(true);
    expect(lines.some((l) => l.includes('workshop applied'))).toBe(false);
    expect(lines.some((l) => l.includes('workshop apply FAILED'))).toBe(false);
  });
});
