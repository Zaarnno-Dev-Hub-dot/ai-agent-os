/**
 * poll_reviews + poll_review_findings — normalized SQL persistence for the
 * Two-Reviewer Policy ledger.
 *
 * `DB_SCHEMA` (packages/shared/src/types.ts) is FROZEN, so these two tables
 * are NOT added there — this module applies its own idempotent DDL,
 * gateway-local, called once at boot right after db.ts's openDatabase()
 * (same "additional schema application" shape db.ts's own applySchema
 * already uses for the frozen base schema, just a second, separate call).
 *
 * Two tables, not one JSON blob column: `poll_reviews` holds one row per
 * reviewer slot (mutated across its lifecycle: pending -> attached/timed-out/
 * substituted); `poll_review_findings` holds one row per finding string,
 * FK'd to its review, each with its own independent `valid` tri-state
 * (NULL = unmarked, 0/1 = human-confirmed invalid/valid) — the true-catch /
 * precision ledger's only source of ground truth.
 */

import type { SqlDatabase } from './db.js';
import type { PollReview, ReviewVerdict } from '@agent-os/shared';

// ============================================================================
// Schema
// ============================================================================

const POLL_REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS poll_reviews (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  family TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot IN (1,2)),
  pool_size INTEGER NOT NULL,
  policy_mode TEXT NOT NULL,
  wake_at INTEGER NOT NULL,
  attach_at INTEGER,
  timeout_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','attached','timed-out','substituted')),
  raw_text TEXT,
  parse_ok INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  substitute_for TEXT,
  human_decision TEXT,
  human_decided_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poll_reviews_poll ON poll_reviews(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_reviews_seat ON poll_reviews(seat_id);

CREATE TABLE IF NOT EXISTS poll_review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES poll_reviews(id),
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  valid INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poll_review_findings_review ON poll_review_findings(review_id);
`;

/** Same idempotent per-statement try/catch as db.ts's applySchema (CREATE TABLE/INDEX IF NOT EXISTS races on a warm boot are expected, not errors). */
export function applyPollReviewsSchema(db: SqlDatabase): void {
  for (const stmt of POLL_REVIEWS_SCHEMA.split(';')) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    try {
      db.run(trimmed);
    } catch (e) {
      console.error('[pollReviewsDb] schema statement failed (idempotent swallow — may be expected on a warm boot):', e instanceof Error ? e.message : String(e));
    }
  }
}

// ============================================================================
// Writes
// ============================================================================

export interface NewPollReviewRow {
  id: string;
  pollId: string;
  seatId: string;
  family: string;
  slot: 1 | 2;
  poolSize: number;
  policyMode: 'mutations' | 'all';
  wakeAt: number;
  status: 'pending';
  substituteFor?: string;
}

export function insertPollReview(db: SqlDatabase, row: NewPollReviewRow): void {
  db.run(
    `INSERT INTO poll_reviews (id, poll_id, seat_id, family, slot, pool_size, policy_mode, wake_at, status, parse_ok, substitute_for, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [row.id, row.pollId, row.seatId, row.family, row.slot, row.poolSize, row.policyMode, row.wakeAt, row.status, row.substituteFor ?? null, Date.now()]
  );
}

export function markPollReviewAttached(
  db: SqlDatabase,
  id: string,
  fields: { attachAt: number; rawText: string; parseOk: boolean; verdict?: ReviewVerdict }
): void {
  db.run(`UPDATE poll_reviews SET status = 'attached', attach_at = ?, raw_text = ?, parse_ok = ?, verdict = ? WHERE id = ?`, [
    fields.attachAt,
    fields.rawText,
    fields.parseOk ? 1 : 0,
    fields.verdict ?? null,
    id,
  ]);
}

export function markPollReviewTimedOut(db: SqlDatabase, id: string, timeoutAt: number, rawText?: string): void {
  db.run(`UPDATE poll_reviews SET status = 'timed-out', timeout_at = ?, raw_text = COALESCE(?, raw_text) WHERE id = ?`, [
    timeoutAt,
    rawText ?? null,
    id,
  ]);
}

export function markPollReviewSubstituted(db: SqlDatabase, id: string): void {
  db.run(`UPDATE poll_reviews SET status = 'substituted' WHERE id = ?`, [id]);
}

export function insertFindings(db: SqlDatabase, reviewId: string, findings: string[]): void {
  const now = Date.now();
  findings.forEach((text, idx) => {
    db.run(`INSERT INTO poll_review_findings (review_id, idx, text, valid, created_at) VALUES (?, ?, ?, NULL, ?)`, [
      reviewId,
      idx,
      text,
      now,
    ]);
  });
}

/** Per-finding human ground truth. `valid: null` clears back to unmarked (the toggle is a 3-state cycle in the UI: unmarked -> valid -> invalid -> unmarked). */
export function setFindingValidity(db: SqlDatabase, reviewId: string, idx: number, valid: boolean | null): void {
  db.run(`UPDATE poll_review_findings SET valid = ? WHERE review_id = ? AND idx = ?`, [
    valid == null ? null : valid ? 1 : 0,
    reviewId,
    idx,
  ]);
}

/** Backfills the human decision onto every review row for a poll once it settles — feeds the red-override log. No-op for a poll with no review rows. */
export function backfillHumanDecision(db: SqlDatabase, pollId: string, decision: string, decidedAt: number): void {
  db.run(`UPDATE poll_reviews SET human_decision = ?, human_decided_at = ? WHERE poll_id = ?`, [decision, decidedAt, pollId]);
}

// ============================================================================
// Reads
// ============================================================================

interface ReviewRowRaw {
  id: string;
  poll_id: string;
  seat_id: string;
  family: string;
  slot: number;
  pool_size: number;
  policy_mode: string;
  wake_at: number;
  attach_at: number | null;
  timeout_at: number | null;
  status: string;
  raw_text: string | null;
  parse_ok: number;
  verdict: string | null;
  substitute_for: string | null;
}

function rowToReview(row: ReviewRowRaw, findings: string[], findingValid: Array<boolean | undefined>): PollReview {
  return {
    id: row.id,
    pollId: row.poll_id,
    seatId: row.seat_id,
    family: row.family,
    slot: row.slot === 1 ? 1 : 2,
    poolSizeAtSelection: row.pool_size,
    policyMode: row.policy_mode === 'all' ? 'all' : 'mutations',
    wakeAt: row.wake_at,
    attachAt: row.attach_at ?? undefined,
    timeoutAt: row.timeout_at ?? undefined,
    status: row.status as PollReview['status'],
    rawText: row.raw_text ?? undefined,
    parseOk: row.parse_ok === 1,
    verdict: (row.verdict ?? undefined) as ReviewVerdict | undefined,
    findings: findings.length ? findings : undefined,
    findingValid: findingValid.length ? findingValid : undefined,
    substituteForReviewId: row.substitute_for ?? undefined,
  };
}

function loadFindingsForReview(db: SqlDatabase, reviewId: string): { texts: string[]; valid: Array<boolean | undefined> } {
  const stmt = db.prepare(`SELECT idx, text, valid FROM poll_review_findings WHERE review_id = ? ORDER BY idx ASC`);
  (stmt as unknown as { bind: (params: unknown[]) => void }).bind([reviewId]);
  const texts: string[] = [];
  const valid: Array<boolean | undefined> = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, unknown>;
    texts.push(String(r.text));
    valid.push(r.valid == null ? undefined : Number(r.valid) === 1);
  }
  stmt.free();
  return { texts, valid };
}

export function loadReviewsForPoll(db: SqlDatabase, pollId: string): PollReview[] {
  const stmt = db.prepare(`SELECT * FROM poll_reviews WHERE poll_id = ? ORDER BY created_at ASC`);
  (stmt as unknown as { bind: (params: unknown[]) => void }).bind([pollId]);
  const rows: ReviewRowRaw[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as ReviewRowRaw);
  stmt.free();
  return rows.map((row) => {
    const { texts, valid } = loadFindingsForReview(db, row.id);
    return rowToReview(row, texts, valid);
  });
}

/** Every review row across every poll — used for state.sync hydration (bounded: caller slices to "open polls' reviews + recent N", same shape as pollsForStateSync). */
export function loadReviewsForPolls(db: SqlDatabase, pollIds: string[]): PollReview[] {
  if (pollIds.length === 0) return [];
  const placeholders = pollIds.map(() => '?').join(',');
  const stmt = db.prepare(`SELECT * FROM poll_reviews WHERE poll_id IN (${placeholders}) ORDER BY created_at ASC`);
  (stmt as unknown as { bind: (params: unknown[]) => void }).bind(pollIds);
  const rows: ReviewRowRaw[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as ReviewRowRaw);
  stmt.free();
  return rows.map((row) => {
    const { texts, valid } = loadFindingsForReview(db, row.id);
    return rowToReview(row, texts, valid);
  });
}

export function loadPollReviewById(db: SqlDatabase, id: string): PollReview | undefined {
  const stmt = db.prepare(`SELECT * FROM poll_reviews WHERE id = ?`);
  (stmt as unknown as { bind: (params: unknown[]) => void }).bind([id]);
  let row: ReviewRowRaw | undefined;
  if (stmt.step()) row = stmt.getAsObject() as unknown as ReviewRowRaw;
  stmt.free();
  if (!row) return undefined;
  const { texts, valid } = loadFindingsForReview(db, row.id);
  return rowToReview(row, texts, valid);
}

/**
 * Rotation source. MAX(wake_at) per seat across every review row ever created for
 * that seat — a seat never selected returns -Infinity so it sorts first.
 * Restart-durable by construction: this queries the SQL table, not an
 * in-memory cursor.
 */
export function lastSelectedAtBySeat(db: SqlDatabase): Map<string, number> {
  const out = new Map<string, number>();
  const stmt = db.prepare(`SELECT seat_id, MAX(wake_at) AS last_at FROM poll_reviews GROUP BY seat_id`);
  while (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, unknown>;
    out.set(String(r.seat_id), Number(r.last_at ?? 0));
  }
  stmt.free();
  return out;
}

// ============================================================================
// Digest — the keep/kill metric
// ============================================================================

export interface ReviewDigest {
  /** Human-confirmed true catches (a finding marked valid=1) in the window. */
  trueCatchCount: number;
  /** Per-reviewer-seat precision: valid / (valid + invalid) among MARKED findings only (unmarked findings don't count toward either side — precision is only defined over ground truth that actually exists). */
  precisionBySeat: Array<{ seatId: string; family: string; validCount: number; invalidCount: number; precision: number | null }>;
  precisionByFamily: Array<{ family: string; validCount: number; invalidCount: number; precision: number | null }>;
  /** Reject verdicts whose poll was ultimately decided with a DIFFERENT option than reject — i.e. the human overrode a reviewer's reject. */
  redOverrides: Array<{ reviewId: string; pollId: string; seatId: string; humanDecision: string }>;
  /** Milliseconds, sorted-median of (attach_at - wake_at) across every attached review in the window. Null if no attached reviews exist yet. */
  p50AttachLatencyMs: number | null;
  /** Distinct pool_size values seen and their counts. */
  poolSizeDistribution: Array<{ poolSize: number; count: number }>;
  /** attached reviews whose parse_ok=0 (should never happen — attach only happens after a reply arrives, and status stays 'pending'/'timed-out' otherwise, but this counts every reply that arrived and failed to parse regardless of eventual status) over every review that ever got a reply at all. */
  unparseableRate: number | null;
}

/**
 * Computes the original design's "keep bar" metrics in one pass over
 * poll_reviews/poll_review_findings. Documented query shape:
 *   - true-catch / precision: GROUP BY seat_id / family over
 *     poll_review_findings.valid (join back to poll_reviews for family).
 *   - red-override: poll_reviews WHERE verdict='reject' AND human_decision
 *     IS NOT NULL AND human_decision != 'reject'.
 *   - p50 attach latency: (attach_at - wake_at) over status='attached' rows,
 *     sorted, middle element.
 *   - pool-size distribution: GROUP BY pool_size.
 *   - unparseable rate: rows with a non-null raw_text (a reply arrived)
 *     where parse_ok=0, divided by every row with a non-null raw_text.
 */
export function computeReviewDigest(db: SqlDatabase): ReviewDigest {
  const findingRows: Array<{ seat_id: string; family: string; valid: number | null }> = [];
  {
    const stmt = db.prepare(
      `SELECT r.seat_id AS seat_id, r.family AS family, f.valid AS valid
       FROM poll_review_findings f JOIN poll_reviews r ON r.id = f.review_id`
    );
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      findingRows.push({ seat_id: String(row.seat_id), family: String(row.family), valid: row.valid == null ? null : Number(row.valid) });
    }
    stmt.free();
  }

  const trueCatchCount = findingRows.filter((f) => f.valid === 1).length;

  const seatTally = new Map<string, { family: string; valid: number; invalid: number }>();
  const familyTally = new Map<string, { valid: number; invalid: number }>();
  for (const f of findingRows) {
    if (f.valid == null) continue;
    const seatEntry = seatTally.get(f.seat_id) ?? { family: f.family, valid: 0, invalid: 0 };
    if (f.valid === 1) seatEntry.valid += 1;
    else seatEntry.invalid += 1;
    seatTally.set(f.seat_id, seatEntry);

    const familyEntry = familyTally.get(f.family) ?? { valid: 0, invalid: 0 };
    if (f.valid === 1) familyEntry.valid += 1;
    else familyEntry.invalid += 1;
    familyTally.set(f.family, familyEntry);
  }
  const precisionBySeat = Array.from(seatTally.entries()).map(([seatId, t]) => ({
    seatId,
    family: t.family,
    validCount: t.valid,
    invalidCount: t.invalid,
    precision: t.valid + t.invalid > 0 ? t.valid / (t.valid + t.invalid) : null,
  }));
  const precisionByFamily = Array.from(familyTally.entries()).map(([family, t]) => ({
    family,
    validCount: t.valid,
    invalidCount: t.invalid,
    precision: t.valid + t.invalid > 0 ? t.valid / (t.valid + t.invalid) : null,
  }));

  const redOverrides: ReviewDigest['redOverrides'] = [];
  const latencies: number[] = [];
  const poolSizeCounts = new Map<number, number>();
  let repliedCount = 0;
  let unparseableCount = 0;
  {
    const stmt = db.prepare(
      `SELECT id, poll_id, seat_id, verdict, human_decision, wake_at, attach_at, status, raw_text, parse_ok, pool_size FROM poll_reviews`
    );
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const verdict = row.verdict as string | null;
      const humanDecision = row.human_decision as string | null;
      if (verdict === 'reject' && humanDecision != null && humanDecision !== 'reject') {
        redOverrides.push({
          reviewId: String(row.id),
          pollId: String(row.poll_id),
          seatId: String(row.seat_id),
          humanDecision,
        });
      }
      if (row.status === 'attached' && row.attach_at != null) {
        latencies.push(Number(row.attach_at) - Number(row.wake_at));
      }
      const poolSize = Number(row.pool_size);
      poolSizeCounts.set(poolSize, (poolSizeCounts.get(poolSize) ?? 0) + 1);
      if (row.raw_text != null) {
        repliedCount += 1;
        if (Number(row.parse_ok) === 0) unparseableCount += 1;
      }
    }
    stmt.free();
  }

  latencies.sort((a, b) => a - b);
  const p50AttachLatencyMs = latencies.length > 0 ? latencies[Math.floor((latencies.length - 1) / 2)] : null;
  const poolSizeDistribution = Array.from(poolSizeCounts.entries())
    .map(([poolSize, count]) => ({ poolSize, count }))
    .sort((a, b) => a.poolSize - b.poolSize);
  const unparseableRate = repliedCount > 0 ? unparseableCount / repliedCount : null;

  return {
    trueCatchCount,
    precisionBySeat,
    precisionByFamily,
    redOverrides,
    p50AttachLatencyMs,
    poolSizeDistribution,
    unparseableRate,
  };
}
