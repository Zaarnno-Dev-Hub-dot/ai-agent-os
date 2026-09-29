/**
 * Workshop flow — route + git-apply orchestration. POST /api/workshop/propose reads a seat's
 * drafted MANIFEST.json + target files from its own workspace, validates
 * every rule in workshop.ts, and creates a POLL (source 'workshop') in the
 * "Workshop" room — same split as polls.ts (pure state) vs. pollsRoutes.ts
 * (route + settle side effects): workshop.ts owns the pure validation/diff
 * logic, this file owns the fs reads, the Fastify route, and the git
 * worktree apply that runs when pollsRoutes.ts's notifyPollSettled sees a
 * decided source==='workshop' poll (same "new source-conditional branch"
 * shape as that function's existing paperclip POST-back branch).
 *
 * Context is the SAME live maps/closures every other route/handler in
 * index.ts already reads, threaded explicitly instead of via module-scoped
 * globals — bridge.ts/pollsRoutes.ts precedent, unit-testable against a
 * throwaway Fastify instance + fake deps (no full gateway boot required).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import type { FastifyInstance } from 'fastify';
import type { AgentState, Room, ServerEvent } from '@agent-os/shared';
import {
  createPoll,
  savePolls,
  type Poll,
  type PollAttachment,
  type PollDiffAttachment,
  type PollsState,
  type WorkshopSnapshotTarget,
} from './polls.js';
import {
  buildUnifiedDiff,
  findWorkshopRoom,
  isUtf8Text,
  isValidSeatId,
  isValidTaskSlug,
  MAX_FILE_BYTES,
  parseManifest,
  validateRepoPath,
  validateWorkspacePath,
  WORKSHOP_ROOM_NAME,
} from './workshop.js';

/**
 * Context the propose route needs from index.ts — see the module doc
 * comment for why this is threaded explicitly rather than read off
 * module-scoped globals.
 */
export interface WorkshopRouteContext {
  rooms: Map<string, Room>;
  dataDir: string;
  /** Repo root — where `workshops/<seatId>/...` resolves FROM (dataDir) is separate from where repoPath resolves INTO (projectRoot). */
  projectRoot: string;
  defaultRoomTurnCap: number;
  getPollsState: () => PollsState;
  setPollsState: (state: PollsState) => void;
  broadcast: (event: ServerEvent) => void;
  broadcastStateSync: () => void;
  postSystemLine: (roomId: string, content: string) => void;
  persistRoomMutation: (room: Room) => void;
  /**
   * Two-Reviewer Policy hook. Fired AFTER the poll
   * is created/persisted/broadcast and the propose response is about to go
   * out — fire-and-forget from THIS route's perspective; a failed/absent
   * selection inside the hook must never fail or slow down propose itself
   *. Optional so
   * every pre-M3 test/caller keeps working unchanged; production wiring
   * (index.ts) always supplies it.
   */
  onPollProposed?: (poll: Poll) => void;
}

function findOrCreateWorkshopRoom(ctx: WorkshopRouteContext): Room {
  const existing = findWorkshopRoom(ctx.rooms);
  if (existing) return existing;
  const room: Room = {
    id: randomUUID(),
    name: WORKSHOP_ROOM_NAME,
    type: 'group',
    memberIds: [], // human-only review room, same convention as paperclip.ts's Approvals room
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: ctx.defaultRoomTurnCap,
  };
  ctx.persistRoomMutation(room);
  return room;
}

/**
 * Register `POST /api/workshop/propose`. REST,
 * loopback trust model — same convention as POST /api/polls / POST
 * /api/bridge/wake ("the gateway binds 127.0.0.1 and trusts local callers;
 * this endpoint invents no new auth system"). Fail-closed: the first
 * validation failure (shape, seatId/taskSlug format, per-target repoPath/
 * workspacePath policy, size/text caps) returns 4xx with a human-readable
 * reason and creates nothing.
 */
export function registerWorkshopRoute(fastify: FastifyInstance, ctx: WorkshopRouteContext): void {
  fastify.post<{ Body: Record<string, unknown> }>('/api/workshop/propose', async (req, reply) => {
    const body = req.body ?? {};
    const seatId = typeof body.seatId === 'string' ? body.seatId.trim() : '';
    const taskSlug = typeof body.taskSlug === 'string' ? body.taskSlug.trim() : '';

    if (!isValidSeatId(seatId)) {
      reply.code(400);
      return { error: 'seatId is required (letters, digits, "_", "-", "#" only).' };
    }
    if (!isValidTaskSlug(taskSlug)) {
      reply.code(400);
      return { error: 'taskSlug is required (1-80 chars of [a-zA-Z0-9_-], not starting with "-").' };
    }

    const draftDir = join(ctx.dataDir, 'workspaces', seatId, 'workshop', taskSlug);
    if (!existsSync(draftDir) || !statSync(draftDir).isDirectory()) {
      reply.code(400);
      return { error: `No draft found at workspaces/${seatId}/workshop/${taskSlug}.` };
    }

    const manifestPath = join(draftDir, 'MANIFEST.json');
    if (!existsSync(manifestPath)) {
      reply.code(400);
      return { error: 'MANIFEST.json not found in the draft directory.' };
    }

    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      reply.code(400);
      return { error: `MANIFEST.json is not valid JSON: ${(e as Error).message}` };
    }
    const manifestCheck = parseManifest(rawManifest);
    if (!manifestCheck.ok) {
      reply.code(400);
      return { error: manifestCheck.error };
    }
    const { manifest } = manifestCheck;

    const diffAttachments: PollDiffAttachment[] = [];
    const snapshotTargets: WorkshopSnapshotTarget[] = [];
    const seenRepoPaths = new Set<string>();

    for (const target of manifest.targets) {
      const wsCheck = validateWorkspacePath(target.workspacePath);
      if (!wsCheck.ok) {
        reply.code(400);
        return { error: wsCheck.error };
      }
      const repoCheck = validateRepoPath(target.repoPath);
      if (!repoCheck.ok) {
        reply.code(400);
        return { error: repoCheck.error };
      }
      if (seenRepoPaths.has(repoCheck.path)) {
        reply.code(400);
        return { error: `Duplicate repoPath in manifest: ${repoCheck.path}` };
      }
      seenRepoPaths.add(repoCheck.path);

      const absWorkspacePath = join(draftDir, ...wsCheck.path.split('/'));
      if (!existsSync(absWorkspacePath) || !statSync(absWorkspacePath).isFile()) {
        reply.code(400);
        return { error: `workspacePath file not found: ${wsCheck.path}` };
      }
      const size = statSync(absWorkspacePath).size;
      if (size > MAX_FILE_BYTES) {
        reply.code(400);
        return { error: `${wsCheck.path} exceeds the ${MAX_FILE_BYTES / 1024}KB per-file cap (${size} bytes).` };
      }
      const buf = readFileSync(absWorkspacePath);
      if (!isUtf8Text(buf)) {
        reply.code(400);
        return { error: `${wsCheck.path} is not valid UTF-8 text (binary files are rejected in v1).` };
      }
      const newText = buf.toString('utf8');

      const absRepoPath = join(ctx.projectRoot, ...repoCheck.path.split('/'));
      const oldText = existsSync(absRepoPath) && statSync(absRepoPath).isFile() ? readFileSync(absRepoPath, 'utf8') : undefined;

      const { diff, truncated } = buildUnifiedDiff(repoCheck.path, oldText, newText);
      diffAttachments.push({ repoPath: repoCheck.path, diff, truncated });
      snapshotTargets.push({ repoPath: repoCheck.path, content: newText });
    }

    const room = findOrCreateWorkshopRoom(ctx);

    // Integration seam (Wave 6 merge, 2026-07-09): also project diffAttachments
    // onto the generic `attachments` field wave6/approvals-v2 shipped in the
    // SAME design pass (8dc124e), as kind:'text' entries. workshop.ts/
    // workshopRoutes.ts built and tested diffAttachments/workshopSnapshot with
    // no knowledge of approvals-v2's rich card (parallel branches, both off
    // 73621e2); approvals-v2's PollCard/PollRichSections/pollPresent.ts only
    // ever render `poll.attachments` (resolveAttachmentView's plain-text
    // branch for kind:'text' — see pollPresent.ts) and have no idea
    // diffAttachments exists. Without this, a workshop poll's diff is present
    // on the wire (diffAttachments, still set below for workshopSnapshot's
    // sibling/applyWorkshopPoll's own use) but never rendered — "the poll
    // card carries the diff" would be false. Reuses already-
    // shipped, already-tested rendering; no UI change needed.
    const diffPollAttachments: PollAttachment[] = diffAttachments.map((d) => ({
      kind: 'text',
      data: d.diff,
      caption: d.truncated ? `${d.repoPath} (truncated)` : d.repoPath,
    }));

    const created = createPoll(ctx.getPollsState(), {
      roomId: room.id,
      question: manifest.title,
      detail: manifest.description,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      requestedBy: seatId,
      source: 'workshop',
      // No defaultOptionId — createPoll itself also enforces this for
      // source==='workshop' (defense in depth; see polls.ts's createPoll).
      diffAttachments,
      attachments: diffPollAttachments,
      workshopSnapshot: { seatId, taskSlug, targets: snapshotTargets },
    });
    if (!created.ok) {
      reply.code(400);
      return { error: created.error };
    }

    ctx.setPollsState(created.state);
    savePolls(ctx.dataDir, created.state);
    ctx.broadcast({ type: 'poll.updated', payload: created.poll } as unknown as ServerEvent);
    ctx.broadcastStateSync();

    const fileWord = manifest.targets.length === 1 ? 'file' : 'files';
    ctx.postSystemLine(
      room.id,
      `→ workshop: @${seatId} proposed "${manifest.title}" (${manifest.targets.length} ${fileWord}) — awaiting approval.`
    );
    console.log(`[workshop] propose seat=${seatId} slug=${taskSlug} poll=${created.poll.id} files=${manifest.targets.length}`);

    // Two-Reviewer Policy (Wave 7 M3): fire-and-forget — see the hook's own
    // doc comment on WorkshopRouteContext for why this must never fail or
    // slow down the propose response itself.
    try {
      ctx.onPollProposed?.(created.poll);
    } catch (e) {
      console.error('[workshop] review-policy propose hook failed', created.poll.id, e);
    }

    reply.code(200);
    return created.poll;
  });
}

// ============================================================================
// Apply (runs from pollsRoutes.ts's notifyPollSettled on a decided,
// approved, source==='workshop' poll)
// ============================================================================

export interface WorkshopApplyContext {
  projectRoot: string;
  agents: Map<string, AgentState>;
}

export type WorkshopApplyResult = { ok: true; branch: string; sha: string } | { ok: false; error: string };

const GIT_TIMEOUT_MS = 30_000;

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): GitResult {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.error ? result.error.message : result.stderr ?? '',
  };
}

/** Best-effort cleanup — swallows its own errors so a cleanup failure never masks the ORIGINAL error that triggered it. */
function cleanupWorktreeAndBranch(projectRoot: string, worktreeDir: string, branch: string): void {
  try {
    runGit(projectRoot, ['worktree', 'remove', worktreeDir, '--force']);
  } catch {
    /* best-effort */
  }
  try {
    runGit(projectRoot, ['branch', '-D', branch]);
  } catch {
    /* best-effort */
  }
}

/**
 * Approve → apply: `git worktree add` a throwaway
 * worktree on a new branch `workshop/<slug>` off `main`, write every
 * snapshotted target file, commit, capture the sha, remove the worktree
 * (keep the branch). NEVER touches `main` — the worktree is added FROM main
 * onto a brand-new branch, and no step here ever checks out or commits to
 * main itself.
 *
 * Fail-closed on a pre-existing `workshop/<slug>` branch (a task slug
 * re-propose/re-approve collision) rather than guessing reuse/merge
 * semantics. Any failure AFTER the branch is created rolls the branch back
 * out (`git branch -D`) alongside the worktree, so a broken apply leaves no
 * trace — same "nothing applied" spirit the original design gives the reject
 * path, extended to apply-time failures.
 *
 * Author/committer identity is an explicit system identity
 * (`workshop@agent-os.local`), never the ambient/global git config — so a
 * commit never silently depends on whatever `user.email` happens to be
 * configured on the machine running the gateway (also makes this
 * deterministic under test, including on a fresh checkout with no git
 * identity configured at all). The seat is credited via a `Co-Authored-By`
 * trailer instead, same convention as this project's own AI-assisted
 * commits.
 */
export async function applyWorkshopPoll(ctx: WorkshopApplyContext, poll: Poll): Promise<WorkshopApplyResult> {
  const snapshot = poll.workshopSnapshot;
  if (!snapshot) {
    return { ok: false, error: 'Poll has no workshopSnapshot to apply.' };
  }
  if (!isValidTaskSlug(snapshot.taskSlug)) {
    return { ok: false, error: `Refusing to apply: invalid taskSlug "${snapshot.taskSlug}".` };
  }
  if (snapshot.targets.length === 0) {
    return { ok: false, error: 'workshopSnapshot has no targets to apply.' };
  }

  // Defense-in-depth: the
  // snapshot was validated at propose time, but a corrupted/hand-edited
  // data/polls.json could carry a snapshot whose repoPath escapes the worktree
  // (traversal) or targets a frozen file. Re-validate every path against the
  // SAME allowlist/DENY policy the propose route uses (validateRepoPath) so the
  // two paths cannot diverge — fail closed before any branch/worktree is created.
  for (const target of snapshot.targets) {
    const repoCheck = validateRepoPath(target.repoPath);
    if (!repoCheck.ok) {
      return { ok: false, error: `Refusing to apply: ${repoCheck.error}` };
    }
  }

  const branch = `workshop/${snapshot.taskSlug}`;

  const existsCheck = runGit(ctx.projectRoot, ['rev-parse', '--verify', '--quiet', branch]);
  if (existsCheck.status === 0) {
    return { ok: false, error: `Branch ${branch} already exists — pick a different task slug.` };
  }

  const stagingRoot = join(ctx.projectRoot, '.workshop-worktrees');
  try {
    mkdirSync(stagingRoot, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Failed to prepare staging directory: ${(e as Error).message}` };
  }
  const worktreeDir = join(stagingRoot, randomUUID());

  const addResult = runGit(ctx.projectRoot, ['worktree', 'add', '-b', branch, worktreeDir, 'main']);
  if (addResult.status !== 0) {
    return { ok: false, error: `git worktree add failed: ${addResult.stderr.trim()}` };
  }

  try {
    for (const target of snapshot.targets) {
      const abs = join(worktreeDir, ...target.repoPath.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, target.content, 'utf8');
    }

    const addFilesResult = runGit(worktreeDir, ['add', '--', ...snapshot.targets.map((t) => t.repoPath)]);
    if (addFilesResult.status !== 0) {
      throw new Error(`git add failed: ${addFilesResult.stderr.trim()}`);
    }

    const seatName = ctx.agents.get(snapshot.seatId)?.manifest.displayName ?? snapshot.seatId;
    const messageParts = [`workshop(${snapshot.seatId}): ${poll.question}`, ''];
    if (poll.detail) messageParts.push(poll.detail, '');
    messageParts.push(`Co-Authored-By: ${seatName} <${snapshot.seatId}@agents.local>`);
    const message = messageParts.join('\n');

    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Hermes Agent OS Workshop',
      GIT_AUTHOR_EMAIL: 'workshop@agent-os.local',
      GIT_COMMITTER_NAME: 'Hermes Agent OS Workshop',
      GIT_COMMITTER_EMAIL: 'workshop@agent-os.local',
    };
    const commitResult = runGit(worktreeDir, ['commit', '-m', message], gitEnv);
    if (commitResult.status !== 0) {
      throw new Error(`git commit failed: ${commitResult.stderr.trim()}`);
    }

    const shaResult = runGit(worktreeDir, ['rev-parse', 'HEAD']);
    if (shaResult.status !== 0) {
      throw new Error(`git rev-parse failed: ${shaResult.stderr.trim()}`);
    }
    const sha = shaResult.stdout.trim();

    // Keep the branch even if worktree removal itself has trouble — the
    // commit already landed; a leftover staging dir is a cleanup nit, not a
    // reason to report apply as failed.
    runGit(ctx.projectRoot, ['worktree', 'remove', worktreeDir, '--force']);

    return { ok: true, branch, sha: sha.slice(0, 7) };
  } catch (e) {
    cleanupWorktreeAndBranch(ctx.projectRoot, worktreeDir, branch);
    return { ok: false, error: (e as Error).message };
  }
}
