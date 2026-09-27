import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, type SqlDatabase } from './db.js';
import {
  applyPollReviewsSchema,
  backfillHumanDecision,
  computeReviewDigest,
  insertFindings,
  insertPollReview,
  lastSelectedAtBySeat,
  loadPollReviewById,
  loadReviewsForPoll,
  loadReviewsForPolls,
  markPollReviewAttached,
  markPollReviewSubstituted,
  markPollReviewTimedOut,
  setFindingValidity,
} from './pollReviewsDb.js';

let dataDir: string;
let db: SqlDatabase;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'poll-reviews-db-'));
  db = await openDatabase(dataDir);
  applyPollReviewsSchema(db);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('applyPollReviewsSchema', () => {
  it('is idempotent — applying twice does not throw', () => {
    expect(() => applyPollReviewsSchema(db)).not.toThrow();
  });
});

describe('insertPollReview / loadPollReviewById / loadReviewsForPoll', () => {
  it('round-trips a freshly-inserted pending review', () => {
    insertPollReview(db, {
      id: 'r1',
      pollId: 'p1',
      seatId: 'ollama',
      family: 'homebrew',
      slot: 1,
      poolSize: 3,
      policyMode: 'mutations',
      wakeAt: 1000,
      status: 'pending',
    });
    const row = loadPollReviewById(db, 'r1');
    expect(row).toMatchObject({
      id: 'r1',
      pollId: 'p1',
      seatId: 'ollama',
      family: 'homebrew',
      slot: 1,
      poolSizeAtSelection: 3,
      policyMode: 'mutations',
      wakeAt: 1000,
      status: 'pending',
      parseOk: false,
    });
    expect(row?.findings).toBeUndefined();
    expect(row?.substituteForReviewId).toBeUndefined();
  });

  it('loadReviewsForPoll returns rows for that poll only, in creation order', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'pending' });
    insertPollReview(db, { id: 'r2', pollId: 'p1', seatId: 'b', family: 'fb', slot: 2, poolSize: 2, policyMode: 'mutations', wakeAt: 2, status: 'pending' });
    insertPollReview(db, { id: 'r3', pollId: 'p2', seatId: 'c', family: 'fc', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 3, status: 'pending' });
    const p1 = loadReviewsForPoll(db, 'p1');
    expect(p1.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('loadReviewsForPolls filters across multiple poll ids and returns [] for an empty list', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'pending' });
    insertPollReview(db, { id: 'r2', pollId: 'p2', seatId: 'b', family: 'fb', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 2, status: 'pending' });
    insertPollReview(db, { id: 'r3', pollId: 'p3', seatId: 'c', family: 'fc', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 3, status: 'pending' });
    expect(loadReviewsForPolls(db, []).map((r) => r.id)).toEqual([]);
    expect(loadReviewsForPolls(db, ['p1', 'p3']).map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('a substitute row carries substituteForReviewId', () => {
    insertPollReview(db, { id: 'orig', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'pending' });
    insertPollReview(db, {
      id: 'sub',
      pollId: 'p1',
      seatId: 'b',
      family: 'fa',
      slot: 1,
      poolSize: 2,
      policyMode: 'mutations',
      wakeAt: 2,
      status: 'pending',
      substituteFor: 'orig',
    });
    expect(loadPollReviewById(db, 'sub')?.substituteForReviewId).toBe('orig');
  });
});

describe('markPollReviewAttached / markPollReviewTimedOut / markPollReviewSubstituted', () => {
  beforeEach(() => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 100, status: 'pending' });
  });

  it('attach: sets status/attachAt/rawText/parseOk/verdict', () => {
    markPollReviewAttached(db, 'r1', { attachAt: 200, rawText: 'raw reply text', parseOk: true, verdict: 'approve' });
    const row = loadPollReviewById(db, 'r1');
    expect(row).toMatchObject({ status: 'attached', attachAt: 200, rawText: 'raw reply text', parseOk: true, verdict: 'approve' });
  });

  it('attach with parseOk=false leaves verdict undefined — never coerced', () => {
    markPollReviewAttached(db, 'r1', { attachAt: 200, rawText: 'garbage', parseOk: false });
    const row = loadPollReviewById(db, 'r1');
    expect(row?.status).toBe('attached');
    expect(row?.parseOk).toBe(false);
    expect(row?.verdict).toBeUndefined();
  });

  it('timeout: sets status/timeoutAt', () => {
    markPollReviewTimedOut(db, 'r1', 300);
    const row = loadPollReviewById(db, 'r1');
    expect(row).toMatchObject({ status: 'timed-out', timeoutAt: 300 });
  });

  it('substituted: sets status without clobbering existing fields', () => {
    markPollReviewTimedOut(db, 'r1', 300);
    markPollReviewSubstituted(db, 'r1');
    const row = loadPollReviewById(db, 'r1');
    expect(row?.status).toBe('substituted');
    expect(row?.timeoutAt).toBe(300);
  });
});

describe('insertFindings / setFindingValidity', () => {
  beforeEach(() => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'pending' });
  });

  it('inserts findings index-aligned, all unmarked initially', () => {
    insertFindings(db, 'r1', ['finding zero', 'finding one']);
    const row = loadPollReviewById(db, 'r1');
    expect(row?.findings).toEqual(['finding zero', 'finding one']);
    expect(row?.findingValid).toEqual([undefined, undefined]);
  });

  it('setFindingValidity marks one finding valid/invalid without touching the other', () => {
    insertFindings(db, 'r1', ['a', 'b']);
    setFindingValidity(db, 'r1', 0, true);
    setFindingValidity(db, 'r1', 1, false);
    const row = loadPollReviewById(db, 'r1');
    expect(row?.findingValid).toEqual([true, false]);
  });

  it('setFindingValidity(null) clears back to unmarked', () => {
    insertFindings(db, 'r1', ['a']);
    setFindingValidity(db, 'r1', 0, true);
    setFindingValidity(db, 'r1', 0, null);
    expect(loadPollReviewById(db, 'r1')?.findingValid).toEqual([undefined]);
  });
});

describe('backfillHumanDecision', () => {
  it('sets human_decision on every review row for a poll', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    insertPollReview(db, { id: 'r2', pollId: 'p1', seatId: 'b', family: 'fb', slot: 2, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    insertPollReview(db, { id: 'r3', pollId: 'other-poll', seatId: 'c', family: 'fc', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    backfillHumanDecision(db, 'p1', 'approve', 5000);
    const p1Rows = loadReviewsForPoll(db, 'p1');
    // human_decision isn't itself surfaced on PollReview's read shape (it's a
    // digest-only column) — verify indirectly via the red-override digest
    // query instead, which is the sole consumer.
    expect(p1Rows).toHaveLength(2);
    const other = loadReviewsForPoll(db, 'other-poll');
    expect(other).toHaveLength(1);
  });
});

describe('lastSelectedAtBySeat', () => {
  it('returns MAX(wake_at) per seat across every review row', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 100, status: 'pending' });
    insertPollReview(db, { id: 'r2', pollId: 'p2', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 500, status: 'pending' });
    insertPollReview(db, { id: 'r3', pollId: 'p1', seatId: 'b', family: 'fb', slot: 2, poolSize: 2, policyMode: 'mutations', wakeAt: 50, status: 'pending' });
    const map = lastSelectedAtBySeat(db);
    expect(map.get('a')).toBe(500);
    expect(map.get('b')).toBe(50);
    expect(map.has('never-selected')).toBe(false);
  });
});

describe('computeReviewDigest', () => {
  it('returns all-empty/null shape on a fresh (empty) ledger', () => {
    const digest = computeReviewDigest(db);
    expect(digest.trueCatchCount).toBe(0);
    expect(digest.precisionBySeat).toEqual([]);
    expect(digest.redOverrides).toEqual([]);
    expect(digest.p50AttachLatencyMs).toBeNull();
    expect(digest.poolSizeDistribution).toEqual([]);
    expect(digest.unparseableRate).toBeNull();
  });

  it('true-catch count + per-seat/per-family precision only count MARKED findings', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'ollama', family: 'homebrew', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    insertFindings(db, 'r1', ['real bug', 'noise', 'unmarked one']);
    setFindingValidity(db, 'r1', 0, true); // true catch
    setFindingValidity(db, 'r1', 1, false); // false positive
    // idx 2 left unmarked on purpose

    const digest = computeReviewDigest(db);
    expect(digest.trueCatchCount).toBe(1);
    const seatEntry = digest.precisionBySeat.find((e) => e.seatId === 'ollama');
    expect(seatEntry).toMatchObject({ family: 'homebrew', validCount: 1, invalidCount: 1, precision: 0.5 });
    const familyEntry = digest.precisionByFamily.find((e) => e.family === 'homebrew');
    expect(familyEntry).toMatchObject({ validCount: 1, invalidCount: 1, precision: 0.5 });
  });

  it('precision is null (not NaN/0) for a seat with only unmarked findings', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'x', family: 'fx', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    insertFindings(db, 'r1', ['unmarked']);
    const digest = computeReviewDigest(db);
    expect(digest.precisionBySeat).toEqual([]); // seat never enters the tally without at least one marked finding
  });

  it('red-override: a reject verdict overridden by a different human decision is logged; a reject that WAS honored is not', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'grok-build', family: 'grok-build', slot: 2, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    markPollReviewAttached(db, 'r1', { attachAt: 2, rawText: 'x', parseOk: true, verdict: 'reject' });
    insertPollReview(db, { id: 'r2', pollId: 'p2', seatId: 'grok-build', family: 'grok-build', slot: 2, poolSize: 2, policyMode: 'mutations', wakeAt: 1, status: 'attached' });
    markPollReviewAttached(db, 'r2', { attachAt: 2, rawText: 'x', parseOk: true, verdict: 'reject' });

    backfillHumanDecision(db, 'p1', 'approve', 100); // OVERRIDE: reject -> approve anyway
    backfillHumanDecision(db, 'p2', 'reject', 100); // HONORED: reject -> reject

    const digest = computeReviewDigest(db);
    expect(digest.redOverrides).toHaveLength(1);
    expect(digest.redOverrides[0]).toMatchObject({ reviewId: 'r1', pollId: 'p1', seatId: 'grok-build', humanDecision: 'approve' });
  });

  it('p50 attach latency over attached rows only, pool-size distribution, and unparseable rate', () => {
    insertPollReview(db, { id: 'r1', pollId: 'p1', seatId: 'a', family: 'fa', slot: 1, poolSize: 2, policyMode: 'mutations', wakeAt: 0, status: 'attached' });
    markPollReviewAttached(db, 'r1', { attachAt: 100, rawText: 'ok', parseOk: true, verdict: 'approve' });
    insertPollReview(db, { id: 'r2', pollId: 'p1', seatId: 'b', family: 'fb', slot: 2, poolSize: 2, policyMode: 'mutations', wakeAt: 0, status: 'attached' });
    markPollReviewAttached(db, 'r2', { attachAt: 300, rawText: 'garbage', parseOk: false });
    insertPollReview(db, { id: 'r3', pollId: 'p2', seatId: 'c', family: 'fc', slot: 1, poolSize: 3, policyMode: 'mutations', wakeAt: 0, status: 'pending' }); // no reply yet — excluded from unparseable rate

    const digest = computeReviewDigest(db);
    expect(digest.p50AttachLatencyMs).not.toBeNull();
    expect(digest.poolSizeDistribution).toEqual(
      expect.arrayContaining([
        { poolSize: 2, count: 2 },
        { poolSize: 3, count: 1 },
      ])
    );
    // 1 of 2 REPLIED reviews failed to parse (r3 never replied, excluded).
    expect(digest.unparseableRate).toBe(0.5);
  });
});
