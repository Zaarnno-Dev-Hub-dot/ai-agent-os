/**
 * Workshop flow — pure logic (Wave 6, docs/DESIGN-workshop-flow.md): manifest
 * shape validation, the repoPath allow/deny policy, the seat-draft-relative
 * workspacePath traversal guard, a UTF-8/binary text check, a dependency-free
 * unified-diff builder, and the "Workshop" room finder. No fs/child_process/
 * fastify here — every rule in this file is a pure function of its inputs so
 * the design doc's "EVERY validation rule gets a unit test" requirement is
 * cheap to satisfy (call the function, assert on the result, no temp dirs or
 * git needed). The impure half (reading the draft dir, running git, the
 * Fastify route) lives in workshopRoutes.ts — same split as polls.ts (pure
 * state) vs. pollsRoutes.ts (route + side effects).
 */

import type { Room } from '@agent-os/shared';

// ============================================================================
// Caps (design doc "Validation" section)
// ============================================================================

/** ≤40 files per manifest. */
export const MAX_TARGETS = 40;
/** ≤200KB per file. */
export const MAX_FILE_BYTES = 200 * 1024;
/** Diff attachments truncate at 400 lines/file (header + hunks combined), with an honest "+N more" note. */
export const MAX_DIFF_LINES = 400;

export const WORKSHOP_ROOM_NAME = 'Workshop';

// ============================================================================
// repoPath policy
// ============================================================================

/**
 * v1 allowlist prefixes — every entry carries its trailing slash so a
 * sibling directory whose name merely starts with the same characters (e.g.
 * `packages/gateway/src-evil/`) can never prefix-match (`startsWith` would
 * otherwise treat "src-evil/" as matching "src" with no slash boundary).
 */
export const REPO_PATH_ALLOWLIST_PREFIXES = ['packages/ui/src/', 'packages/gateway/src/', 'docs/'] as const;
/** Single-file allowlist entries (exact match, not a prefix). */
export const REPO_PATH_ALLOWLIST_EXACT = ['data/dock-apps.json'] as const;

/** DENY always wins, even for a path that also matches an allowlist prefix (packages/gateway/src/relay.ts sits INSIDE the allowed packages/gateway/src/ prefix). */
export const REPO_PATH_DENY_PREFIXES = ['packages/shared/', 'scripts/'] as const;
export const REPO_PATH_DENY_EXACT = ['packages/gateway/src/relay.ts'] as const;

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * Structural safety shared by repoPath and workspacePath: rejects anything
 * that isn't a simple, relative, forward-slash path — no backslashes (this
 * repo's wire convention for these fields is POSIX-style, and accepting
 * backslashes would let a Windows-style traversal slip past string-prefix
 * checks written against forward-slash constants), no leading `/`, no drive
 * letter, no empty segments, no `.`/`..` segments. This is checked BEFORE any
 * allowlist/denylist string comparison so a traversal attempt can never reach
 * (and confuse) the prefix-matching logic below.
 */
function normalizeRelativePath(raw: unknown, label: string): PathCheck {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: `${label} is required.` };
  }
  const value = raw.trim();
  if (value.includes('\\')) {
    return { ok: false, error: `${label} must use forward slashes, not backslashes: ${value}` };
  }
  if (value.startsWith('/')) {
    return { ok: false, error: `${label} must be repo-relative, not absolute: ${value}` };
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return { ok: false, error: `${label} must not include a drive letter: ${value}` };
  }
  const segments = value.split('/');
  if (segments.some((s) => s.length === 0)) {
    return { ok: false, error: `${label} must not contain empty segments (a "//" or a trailing "/"): ${value}` };
  }
  if (segments.some((s) => s === '..')) {
    return { ok: false, error: `${label} must not contain '..': ${value}` };
  }
  if (segments.some((s) => s === '.')) {
    return { ok: false, error: `${label} must not contain '.' segments: ${value}` };
  }
  return { ok: true, path: segments.join('/') };
}

/** workspacePath: draft-dir-relative, traversal-checked only (no allowlist/dotfile policy — that's a repoPath-only concern; the draft dir is the seat's own scratch space). */
export function validateWorkspacePath(raw: unknown): PathCheck {
  return normalizeRelativePath(raw, 'workspacePath');
}

/**
 * repoPath: the full v1 policy from the design doc — structural safety
 * (above) plus dotfiles/.git denied always, the explicit deny list denied
 * always (even inside an allowed prefix), and otherwise must match the v1
 * allowlist. Order matters: structural checks first (closes the traversal-
 * bypasses-prefix-check class of bug), then deny, then allow — so deny is
 * never shadowed by a coincidental allowlist match.
 */
export function validateRepoPath(raw: unknown): PathCheck {
  const base = normalizeRelativePath(raw, 'repoPath');
  if (!base.ok) return base;
  const path = base.path;
  const segments = path.split('/');

  if (segments.some((s) => s.startsWith('.'))) {
    return { ok: false, error: `repoPath must not reference dotfiles or .git: ${path}` };
  }
  if ((REPO_PATH_DENY_EXACT as readonly string[]).includes(path)) {
    return { ok: false, error: `repoPath is frozen and cannot be targeted: ${path}` };
  }
  if (REPO_PATH_DENY_PREFIXES.some((p) => path.startsWith(p))) {
    return { ok: false, error: `repoPath is frozen and cannot be targeted: ${path}` };
  }
  const allowed =
    (REPO_PATH_ALLOWLIST_EXACT as readonly string[]).includes(path) ||
    REPO_PATH_ALLOWLIST_PREFIXES.some((p) => path.startsWith(p));
  if (!allowed) {
    return { ok: false, error: `repoPath is not in the v1 allowlist: ${path}` };
  }
  return { ok: true, path };
}

// ============================================================================
// Manifest shape
// ============================================================================

export interface ManifestTarget {
  workspacePath: string;
  repoPath: string;
}

export interface WorkshopManifest {
  title: string;
  description?: string;
  targets: ManifestTarget[];
}

export type ManifestCheck = { ok: true; manifest: WorkshopManifest } | { ok: false; error: string };

/** Shape-only validation of a parsed MANIFEST.json — path POLICY (allowlist/traversal/caps-per-file) is applied per-target by the caller via validateRepoPath/validateWorkspacePath, which need fs access this module doesn't have. */
export function parseManifest(raw: unknown): ManifestCheck {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    return { ok: false, error: 'MANIFEST.json must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (title.length < 1) {
    return { ok: false, error: 'MANIFEST.json "title" is required.' };
  }
  const description = typeof obj.description === 'string' && obj.description.trim().length > 0 ? obj.description.trim() : undefined;

  const rawTargets = obj.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length < 1) {
    return { ok: false, error: 'MANIFEST.json "targets" must be a non-empty array.' };
  }
  if (rawTargets.length > MAX_TARGETS) {
    return { ok: false, error: `MANIFEST.json "targets" exceeds the cap of ${MAX_TARGETS} files (got ${rawTargets.length}).` };
  }

  const targets: ManifestTarget[] = [];
  for (let i = 0; i < rawTargets.length; i++) {
    const t = rawTargets[i];
    if (typeof t !== 'object' || t == null) {
      return { ok: false, error: `targets[${i}] must be an object.` };
    }
    const rec = t as Record<string, unknown>;
    if (typeof rec.workspacePath !== 'string' || rec.workspacePath.trim().length === 0) {
      return { ok: false, error: `targets[${i}].workspacePath is required.` };
    }
    if (typeof rec.repoPath !== 'string' || rec.repoPath.trim().length === 0) {
      return { ok: false, error: `targets[${i}].repoPath is required.` };
    }
    targets.push({ workspacePath: rec.workspacePath, repoPath: rec.repoPath });
  }

  return { ok: true, manifest: { title, description, targets } };
}

// ============================================================================
// taskSlug
// ============================================================================

/** Filesystem- and git-branch-safe: 1..80 chars, [a-zA-Z0-9_-], never starting with '-' (so it can never be misread as a flag by a CLI it's later interpolated into positionally). */
const TASK_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function isValidTaskSlug(raw: unknown): raw is string {
  return typeof raw === 'string' && TASK_SLUG_PATTERN.test(raw);
}

/**
 * seatId is interpolated directly into a filesystem path
 * (`join(workspaceRoot, seatId, 'workshop', taskSlug)`) — unlike taskSlug's
 * pattern this must also allow '#' (the real instance-suffix shape used
 * throughout this codebase, e.g. `grok-build#fast`, `hermes#judge` — see
 * data/workspaces/*), but still excludes '.', '/', and '\\' so a value like
 * `../../etc` can never climb out of workspaceRoot via path.join's own '..'
 * normalization.
 */
const SEAT_ID_PATTERN = /^[a-zA-Z0-9_#-]{1,80}$/;

export function isValidSeatId(raw: unknown): raw is string {
  return typeof raw === 'string' && SEAT_ID_PATTERN.test(raw);
}

// ============================================================================
// UTF-8 / binary text check
// ============================================================================

/**
 * True only for UTF-8 text: no NUL byte anywhere (git's own binary heuristic
 * — a NUL is technically a valid UTF-8 codepoint but no real text file has
 * one, and it survives a naive utf8-encode/decode round-trip so the second
 * check alone would miss it) AND the buffer round-trips identically through
 * a utf8 decode+re-encode (Buffer#toString('utf8') silently replaces invalid
 * byte sequences with U+FFFD rather than throwing, so a byte-for-byte
 * re-encode comparison is what actually catches invalid UTF-8).
 */
export function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  const decoded = buf.toString('utf8');
  const reencoded = Buffer.from(decoded, 'utf8');
  return reencoded.equals(buf);
}

// ============================================================================
// Unified diff (dependency-free — no npm package in this repo does this; see
// docs/DESIGN-workshop-flow.md's "attachments = per-file unified diffs")
// ============================================================================

interface DiffOp {
  type: 'ctx' | 'del' | 'add';
  line: string;
}

/**
 * Split on '\n' and drop a single trailing empty element (i.e. "a file that
 * ends with a newline" — the vast majority of real text files). This means a
 * change that ONLY adds/removes a final trailing newline shows as NO diff —
 * an accepted fidelity trade-off for a human-review diff (this is never used
 * to construct a patch; apply always writes the full snapshotted content
 * verbatim, never patches).
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Full O(n*m) LCS-based line diff — used only when both sides are small
 * enough (see LCS_LINE_LIMIT) that the DP table is cheap. Classic textbook
 * algorithm: dp[i][j] = LCS length of a[i:]/b[j:], built backwards, then a
 * forward walk picks context/del/add greedily following the higher of the
 * two neighboring LCS lengths.
 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

/**
 * Bounded-compute fallback for files too large for the O(n*m) DP table
 * (default cap ~2.25M cells at the threshold below — fast and small; a
 * pathological 200KB-vs-200KB pair could be tens of millions of cells, which
 * is why this fallback exists at all). Trims the common leading and trailing
 * lines, then reports the entire differing middle as one wholesale del+add
 * block. Less minimal than lcsDiff but always O(n+m) and always correct —
 * an acceptable trade-off since the diff is truncated to MAX_DIFF_LINES for
 * display anyway and is never used to construct a patch.
 */
function trimDiff(a: string[], b: string[]): DiffOp[] {
  const maxCommon = Math.min(a.length, b.length);
  let start = 0;
  while (start < maxCommon && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let k = 0; k < start; k++) ops.push({ type: 'ctx', line: a[k] });
  for (let k = start; k < endA; k++) ops.push({ type: 'del', line: a[k] });
  for (let k = start; k < endB; k++) ops.push({ type: 'add', line: b[k] });
  for (let k = endA; k < a.length; k++) ops.push({ type: 'ctx', line: a[k] });
  return ops;
}

/** Both sides must be at or under this many lines to take the full LCS pass; above it, trimDiff's bounded O(n+m) fallback runs instead. */
const LCS_LINE_LIMIT = 1500;

function diffOps(a: string[], b: string[]): DiffOp[] {
  if (a.length <= LCS_LINE_LIMIT && b.length <= LCS_LINE_LIMIT) return lcsDiff(a, b);
  return trimDiff(a, b);
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/** Groups a flat op list into unified-diff hunks with `context` lines of surrounding context, same clustering convention as `diff -U3`/git. */
function buildHunks(ops: DiffOp[], context = 3): Hunk[] {
  interface Numbered extends DiffOp {
    oldNo?: number;
    newNo?: number;
  }
  const withNums: Numbered[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.type === 'ctx') {
      withNums.push({ ...op, oldNo, newNo });
      oldNo++;
      newNo++;
    } else if (op.type === 'del') {
      withNums.push({ ...op, oldNo });
      oldNo++;
    } else {
      withNums.push({ ...op, newNo });
      newNo++;
    }
  }

  const changedIdx: number[] = [];
  withNums.forEach((op, idx) => {
    if (op.type !== 'ctx') changedIdx.push(idx);
  });
  if (changedIdx.length === 0) return [];

  const clusters: Array<[number, number]> = [];
  let clStart = changedIdx[0];
  let clEnd = changedIdx[0];
  for (let k = 1; k < changedIdx.length; k++) {
    const idx = changedIdx[k];
    if (idx - clEnd <= 2 * context + 1) {
      clEnd = idx;
    } else {
      clusters.push([clStart, clEnd]);
      clStart = idx;
      clEnd = idx;
    }
  }
  clusters.push([clStart, clEnd]);

  return clusters.map(([first, last]) => {
    const from = Math.max(0, first - context);
    const to = Math.min(withNums.length - 1, last + context);
    const slice = withNums.slice(from, to + 1);
    const oldStart = slice.find((s) => s.oldNo !== undefined)?.oldNo ?? 0;
    const newStart = slice.find((s) => s.newNo !== undefined)?.newNo ?? 0;
    const oldCount = slice.filter((s) => s.type !== 'add').length;
    const newCount = slice.filter((s) => s.type !== 'del').length;
    const lines = slice.map((s) => (s.type === 'ctx' ? ' ' : s.type === 'del' ? '-' : '+') + s.line);
    return { oldStart, oldCount, newStart, newCount, lines };
  });
}

export interface UnifiedDiffResult {
  diff: string;
  truncated: boolean;
}

/**
 * Builds one file's unified diff, honestly truncated to `maxLines` total
 * lines (header + hunks) with a trailing "+N more" note when cut short —
 * exactly the design doc's "attachments = per-file unified diffs (text
 * attachments, truncated 400 lines/file with honest '+N more' note)".
 * `oldText === undefined` means the repoPath doesn't exist yet in the repo
 * (a brand-new file) — rendered `--- /dev/null`, same convention git itself
 * uses for a new-file diff.
 */
export function buildUnifiedDiff(
  repoPath: string,
  oldText: string | undefined,
  newText: string,
  maxLines: number = MAX_DIFF_LINES
): UnifiedDiffResult {
  const oldLines = oldText === undefined ? [] : toLines(oldText);
  const newLines = toLines(newText);
  const ops = diffOps(oldLines, newLines);
  const hunks = buildHunks(ops);

  const header = [oldText === undefined ? '--- /dev/null' : `--- a/${repoPath}`, `+++ b/${repoPath}`];
  if (hunks.length === 0) {
    return { diff: [...header, '(no textual changes)'].join('\n'), truncated: false };
  }

  const body: string[] = [];
  for (const h of hunks) {
    body.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    body.push(...h.lines);
  }

  const all = [...header, ...body];
  if (all.length <= maxLines) {
    return { diff: all.join('\n'), truncated: false };
  }
  const shown = all.slice(0, maxLines);
  const more = all.length - maxLines;
  shown.push(`... (+${more} more line${more === 1 ? '' : 's'})`);
  return { diff: shown.join('\n'), truncated: true };
}

// ============================================================================
// Workshop room
// ============================================================================

/** Same find-by-name convention as paperclip.ts's findApprovalsRoom. */
export function findWorkshopRoom(rooms: Map<string, Room>): Room | undefined {
  return Array.from(rooms.values()).find((r) => r.name === WORKSHOP_ROOM_NAME && r.archivedAt == null);
}
