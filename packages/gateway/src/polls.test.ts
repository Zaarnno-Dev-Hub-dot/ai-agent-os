import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createPoll,
  decidePoll,
  deferPoll,
  requestPollInfo,
  findPoll,
  hasApprovalRef,
  loadPolls,
  MAX_POLL_DEFERRALS,
  pollsForStateSync,
  savePolls,
  sweepExpiredPolls,
  withdrawPoll,
  type Poll,
  type PollAttachment,
  type PollsState,
} from './polls.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'polls-test-'));
}

/**
 * Build an attachment the way real caller input (a POST /api/polls body) can
 * actually arrive: NOT checked against PollAttachment's `kind` union at
 * compile time — a missing/misnamed `kind` is exactly the reopened gap these
 * createPoll tests cover.
 */
function hostileAttachment(raw: Record<string, unknown>): PollAttachment {
  return raw as unknown as PollAttachment;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function empty(): PollsState {
  return { polls: [] };
}

describe('loadPolls / savePolls', () => {
  it('returns empty state when the file is absent', () => {
    const dataDir = freshDataDir();
    dirs.push(dataDir);
    expect(loadPolls(dataDir)).toEqual({ polls: [] });
  });

  it('round-trips a saved state', () => {
    const dataDir = freshDataDir();
    dirs.push(dataDir);
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    savePolls(dataDir, result.state);
    const reloaded = loadPolls(dataDir);
    expect(reloaded.polls.length).toBe(1);
    expect(reloaded.polls[0].question).toBe('Ship it?');
  });

  it('falls back to empty state on a corrupt file instead of throwing', () => {
    const dataDir = freshDataDir();
    dirs.push(dataDir);
    savePolls(dataDir, empty());
    const path = join(dataDir, 'polls.json');
    writeFileSync(path, 'not json {{{', 'utf8');
    expect(() => loadPolls(dataDir)).not.toThrow();
    expect(loadPolls(dataDir)).toEqual({ polls: [] });
  });

  it('drops a source:"workshop" poll carrying defaultOptionId on load (corrupted file), keeping valid polls', () => {
    const dataDir = freshDataDir();
    dirs.push(dataDir);
    const good = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Normal poll',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!good.ok) throw new Error('setup failed');
    const hostileWorkshop = {
      id: 'wshop-corrupt',
      roomId: 'room-1',
      question: 'Auto-apply me',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: 'hermes',
      createdAt: Date.now(),
      expiresAt: Date.now() - 1,
      defaultOptionId: 'approve',
      status: 'open',
      source: 'workshop',
    };
    const path = join(dataDir, 'polls.json');
    writeFileSync(path, JSON.stringify({ polls: [good.poll, hostileWorkshop] }, null, 2), 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = loadPolls(dataDir);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    expect(loaded.polls).toHaveLength(1);
    expect(loaded.polls[0].id).toBe(good.poll.id);
    expect(loaded.polls.some((p) => p.source === 'workshop')).toBe(false);
  });
});

describe('createPoll', () => {
  it('creates an open, local-source poll with generated option ids', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Merge PR #42?',
      options: [{ label: 'Merge' }, { label: 'Hold' }],
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.status).toBe('open');
    expect(result.poll.source).toBe('local');
    expect(result.poll.options).toHaveLength(2);
    expect(result.poll.options[0].id).toBeTruthy();
    expect(result.poll.options[0].id).not.toBe(result.poll.options[1].id);
  });

  it('accepts caller-supplied option ids and resolves recommendationId/defaultOptionId against them', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Approve hire?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      recommendationId: 'approve',
      defaultOptionId: 'approve',
      requestedBy: 'paperclip',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.recommendationId).toBe('approve');
    expect(result.poll.defaultOptionId).toBe('approve');
  });

  it('rejects fewer than 2 options', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'Only one' }],
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects more than 6 options', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: Array.from({ length: 7 }, (_, i) => ({ label: `opt${i}` })),
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty/missing question', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: '   ',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing requestedBy', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: '   ',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a recommendationId that does not match any option', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      recommendationId: 'does-not-exist',
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a defaultOptionId that does not match any option', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      defaultOptionId: 'nope',
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  // Wave 6, docs/DESIGN-workshop-flow.md: "Workshop polls: defaultOptionId
  // FORBIDDEN (never auto-approve)". workshopRoutes.ts's propose route never
  // passes one itself, so this choke point in createPoll is the only thing
  // standing between "a future/alternate caller" and an auto-applying
  // workshop poll — tested directly here rather than only indirectly via a
  // route that happens not to exercise it.
  it('rejects a source:"workshop" poll that sets defaultOptionId, even when the id is valid (never auto-approve)', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Apply this?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      defaultOptionId: 'approve',
      requestedBy: 'hermes',
      source: 'workshop',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/defaultOptionId/);
  });

  it('accepts a source:"workshop" poll with no defaultOptionId, threading diffAttachments/workshopSnapshot onto the created Poll', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Apply this?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: 'hermes',
      source: 'workshop',
      diffAttachments: [{ repoPath: 'docs/a.md', diff: '+hi', truncated: false }],
      workshopSnapshot: { seatId: 'hermes', taskSlug: 'x', targets: [{ repoPath: 'docs/a.md', content: 'hi' }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.source).toBe('workshop');
    expect(result.poll.defaultOptionId).toBeUndefined();
    expect(result.poll.diffAttachments).toHaveLength(1);
    expect(result.poll.workshopSnapshot?.taskSlug).toBe('x');
  });

  it('rejects duplicate caller-supplied option ids', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }],
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an option with an empty label', () => {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: '' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    expect(result.ok).toBe(false);
  });

  describe('attachments/disputeSides validation (SECURITY: design doc correction #1, reopened)', () => {
    it('accepts a well-formed attachment', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [{ kind: 'image', url: 'data:image/png;base64,abc=', caption: 'a screenshot' }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.poll.attachments).toHaveLength(1);
    });

    it('rejects an attachment with a kind outside the declared union', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [hostileAttachment({ kind: 'screenshot', url: 'data:image/svg+xml;base64,AAAA' })],
      });
      expect(result.ok).toBe(false);
    });

    it('rejects an attachment with a missing kind entirely — the exact PoC shape from the reopened finding', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [hostileAttachment({ url: 'data:image/svg+xml;base64,AAAA', caption: 'View screenshot' })],
      });
      expect(result.ok).toBe(false);
    });

    it('rejects an attachment whose url/caption/source is a non-string', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: [hostileAttachment({ kind: 'image', url: 12345 })],
      });
      expect(result.ok).toBe(false);
    });

    it('rejects when attachments is not even an array', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        attachments: hostileAttachment({ kind: 'image' }) as unknown as PollAttachment[],
      });
      expect(result.ok).toBe(false);
    });

    it('accepts a well-formed disputeSide', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        disputeSides: [{ agent: 'hermes', statement: 'my side of it' }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.poll.disputeSides).toHaveLength(1);
    });

    it('rejects a disputeSide whose evidence contains an invalid attachment', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        disputeSides: [
          { agent: 'hermes', statement: 'x', evidence: [hostileAttachment({ kind: 'screenshot', url: 'x' })] },
        ],
      });
      expect(result.ok).toBe(false);
    });

    it('rejects a disputeSide with an empty/missing agent name', () => {
      const result = createPoll(empty(), {
        roomId: 'room-1',
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
        requestedBy: 'hermes',
        disputeSides: [{ agent: '   ', statement: 'x' }],
      });
      expect(result.ok).toBe(false);
    });
  });
});

describe('decidePoll (settle-once)', () => {
  function seeded(): { state: PollsState; pollId: string; optionIds: [string, string] } {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      requestedBy: 'hermes',
    });
    if (!result.ok) throw new Error('setup failed');
    return { state: result.state, pollId: result.poll.id, optionIds: ['yes', 'no'] };
  }

  it('decides an open poll', () => {
    const { state, pollId } = seeded();
    const result = decidePoll(state, pollId, 'yes', 'human', 'looks good');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.status).toBe('decided');
    expect(result.poll.decision).toEqual({ optionId: 'yes', decidedBy: 'human', decidedAt: expect.any(Number), note: 'looks good' });
  });

  it('rejects an unknown pollId', () => {
    const { state } = seeded();
    const result = decidePoll(state, 'does-not-exist', 'yes', 'human');
    expect(result.ok).toBe(false);
  });

  it('rejects an optionId that does not belong to the poll', () => {
    const { state, pollId } = seeded();
    const result = decidePoll(state, pollId, 'not-an-option', 'human');
    expect(result.ok).toBe(false);
  });

  it('double-decide race: first write wins, second gets a clean rejection', () => {
    const { state, pollId } = seeded();
    const first = decidePoll(state, pollId, 'yes', 'human');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Second decide against the SAME pre-decide state snapshot (simulates two
    // concurrent WS frames racing against the same in-memory state read).
    const second = decidePoll(first.state, pollId, 'no', 'human');
    expect(second.ok).toBe(false);
    // The poll's decision is still the FIRST one — never overwritten.
    expect(findPoll(first.state, pollId)?.decision?.optionId).toBe('yes');
  });

  it('manual-vs-expiry race: a poll already auto-decided by the sweep cannot be manually decided afterward', () => {
    const { state, pollId } = seeded();
    // Force expiry via the sweep first (see sweepExpiredPolls tests below for
    // full coverage) by directly building an already-decided state, since
    // this test's focus is decidePoll's own settle-once guard against a
    // poll that is no longer 'open' for ANY reason, expiry included.
    const expired = sweepExpiredPolls(
      { polls: [{ ...findPoll(state, pollId)!, expiresAt: Date.now() - 1000, defaultOptionId: 'no' }] },
      Date.now()
    );
    expect(expired.changed).toHaveLength(1);
    const manual = decidePoll(expired.state, pollId, 'yes', 'human');
    expect(manual.ok).toBe(false);
    expect(findPoll(expired.state, pollId)?.decision?.decidedBy).toBe('auto-default');
  });
});

describe('withdrawPoll', () => {
  function seeded(): { state: PollsState; pollId: string } {
    const result = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Pick a base model?',
      options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
      requestedBy: 'hermes',
    });
    if (!result.ok) throw new Error('setup failed');
    return { state: result.state, pollId: result.poll.id };
  }

  it('withdraws an open poll: status flips, no decision recorded, a note message is logged', () => {
    const { state, pollId } = seeded();
    const result = withdrawPoll(state, pollId, 'Superseded');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.status).toBe('withdrawn');
    expect(result.poll.decision).toBeUndefined();
    expect(result.poll.messages).toEqual([
      { at: expect.any(Number), sender: 'human', severity: 'note', content: 'Withdrawn by human: Superseded' },
    ]);
  });

  it('omits the note suffix when no note is given', () => {
    const { state, pollId } = seeded();
    const result = withdrawPoll(state, pollId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.messages?.[0].content).toBe('Withdrawn by human');
  });

  it('rejects an unknown pollId', () => {
    const { state } = seeded();
    const result = withdrawPoll(state, 'does-not-exist');
    expect(result.ok).toBe(false);
  });

  it('settle-once: a poll already decided cannot then be withdrawn', () => {
    const { state, pollId } = seeded();
    const decided = decidePoll(state, pollId, 'a', 'human');
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    const result = withdrawPoll(decided.state, pollId, 'too late');
    expect(result.ok).toBe(false);
  });

  it('settle-once: a poll already withdrawn cannot be withdrawn again', () => {
    const { state, pollId } = seeded();
    const first = withdrawPoll(state, pollId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = withdrawPoll(first.state, pollId, 'second try');
    expect(second.ok).toBe(false);
  });
});

describe('deferPoll', () => {
  // Fake timers: this block asserts EXACT millisecond arithmetic (the whole
  // point of the regression test below), so the system clock is frozen and
  // moved only by explicit vi.setSystemTime() calls. Without this, createPoll
  // and the test each take their own Date.now() reading a fraction of a
  // millisecond apart — usually identical, but occasionally one tick apart,
  // which made an earlier version of this suite flaky by exactly 1ms.
  const FROZEN_AT = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function seededWithExpiry(durationMs: number): { state: PollsState; pollId: string; createdAt: number } {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      requestedBy: 'hermes',
      expiresAt: FROZEN_AT + durationMs,
    });
    if (!created.ok) throw new Error('setup failed');
    return { state: created.state, pollId: created.poll.id, createdAt: created.poll.createdAt };
  }

  it('logs the deferral and a note message, leaves the poll open', () => {
    const { state, pollId } = seededWithExpiry(60_000);
    const result = deferPoll(state, pollId, 'human', 'need another day');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.status).toBe('open');
    expect(result.poll.decision).toBeUndefined();
    expect(result.poll.deferrals).toHaveLength(1);
    expect(result.poll.deferrals?.[0].note).toBe('need another day');
    expect(result.poll.messages).toHaveLength(1);
    expect(result.poll.messages?.[0].severity).toBe('note');
    expect(result.poll.messages?.[0].content).toContain('need another day');
  });

  it('extends expiresAt by the ORIGINAL duration, not a no-op (regression test for the race branch bug)', () => {
    const durationMs = 100_000;
    const { state, pollId, createdAt } = seededWithExpiry(durationMs);
    expect(createdAt).toBe(FROZEN_AT); // sanity check the frozen clock actually took
    const originalExpiresAt = createdAt + durationMs;

    const first = deferPoll(state, pollId, 'human');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Exact arithmetic: originalExpiresAt + 1x duration. A no-op formula
    // (e.g. `Date.now() + (expiresAt - Date.now())`) would leave this at
    // ~originalExpiresAt instead of advancing it at all.
    expect(first.poll.expiresAt).toBe(originalExpiresAt + durationMs);

    const second = deferPoll(first.state, pollId, 'human');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Each deferral adds the SAME fixed increment (the original duration),
    // compounding off the previous extension rather than off a fresh "now".
    expect(second.poll.expiresAt).toBe(originalExpiresAt + durationMs * 2);
    expect(second.poll.originalExpiresAt).toBe(originalExpiresAt);
  });

  it('caps at MAX_POLL_DEFERRALS: the 4th attempt is rejected and leaves the poll unchanged', () => {
    let { state, pollId } = seededWithExpiry(10_000);
    expect(MAX_POLL_DEFERRALS).toBe(3);
    for (let i = 0; i < MAX_POLL_DEFERRALS; i++) {
      const result = deferPoll(state, pollId, 'human');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      state = result.state;
    }
    expect(findPoll(state, pollId)?.deferrals).toHaveLength(MAX_POLL_DEFERRALS);
    const fourth = deferPoll(state, pollId, 'human');
    expect(fourth.ok).toBe(false);
    expect(findPoll(state, pollId)?.deferrals).toHaveLength(MAX_POLL_DEFERRALS);
  });

  it('a poll with no expiresAt can still be deferred (message-only, nothing to extend)', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const result = deferPoll(created.state, created.poll.id, 'human');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.expiresAt).toBeUndefined();
    expect(result.poll.deferrals).toHaveLength(1);
  });

  it('rejects an unknown pollId', () => {
    const { state } = seededWithExpiry(1000);
    const result = deferPoll(state, 'does-not-exist', 'human');
    expect(result.ok).toBe(false);
  });

  it('rejects deferring a poll that is no longer open', () => {
    const { state, pollId } = seededWithExpiry(1000);
    const decided = decidePoll(state, pollId, 'yes', 'human');
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    const result = deferPoll(decided.state, pollId, 'human');
    expect(result.ok).toBe(false);
  });
});

describe('requestPollInfo', () => {
  it('posts a needs-info message without changing status or decision', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Ship it?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const result = requestPollInfo(created.state, created.poll.id, 'human', 'what are the risks?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.status).toBe('open');
    expect(result.poll.decision).toBeUndefined();
    expect(result.poll.messages).toHaveLength(1);
    expect(result.poll.messages?.[0].severity).toBe('needs-info');
    expect(result.poll.messages?.[0].content).toContain('what are the risks?');
  });

  it('works without a note', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const result = requestPollInfo(created.state, created.poll.id, 'human');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.messages?.[0].content).toBe('More info requested by human.');
  });

  it('rejects an unknown pollId', () => {
    const result = requestPollInfo(empty(), 'does-not-exist', 'human');
    expect(result.ok).toBe(false);
  });

  it('rejects a poll that is no longer open', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const decided = decidePoll(created.state, created.poll.id, 'a', 'human');
    if (!decided.ok) throw new Error('setup failed');
    const result = requestPollInfo(decided.state, created.poll.id, 'human');
    expect(result.ok).toBe(false);
  });
});

describe('sweepExpiredPolls', () => {
  it('auto-defaults an expired poll with a defaultOptionId, labeled auto-default', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      defaultOptionId: 'a',
      expiresAt: Date.now() - 1,
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const { state, changed } = sweepExpiredPolls(created.state, Date.now());
    expect(changed).toHaveLength(1);
    expect(changed[0].status).toBe('decided');
    expect(changed[0].decision?.optionId).toBe('a');
    expect(changed[0].decision?.decidedBy).toBe('auto-default');
    expect(state.polls[0].status).toBe('decided');
  });

  it('never auto-defaults a source:"workshop" poll on expiry, even with a defaultOptionId (corrupted-state defense-in-depth)', () => {
    // createPoll makes a workshop+defaultOptionId poll structurally impossible,
    // so simulate a hand-edited/corrupted data/polls.json by building state directly.
    const poll: Poll = {
      id: 'wshop-corrupt',
      roomId: 'room-1',
      question: 'Auto-apply me?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      requestedBy: 'hermes',
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1,
      defaultOptionId: 'approve',
      status: 'open',
      source: 'workshop',
    };
    const { state, changed } = sweepExpiredPolls({ polls: [poll] }, Date.now());
    expect(changed).toHaveLength(1);
    expect(changed[0].status).toBe('expired');
    expect(changed[0].decision).toBeUndefined();
    expect(state.polls[0].status).toBe('expired');
  });

  it('marks an expired poll WITHOUT a defaultOptionId as expired, no decision', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      expiresAt: Date.now() - 1,
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const { changed } = sweepExpiredPolls(created.state, Date.now());
    expect(changed).toHaveLength(1);
    expect(changed[0].status).toBe('expired');
    expect(changed[0].decision).toBeUndefined();
  });

  it('leaves a not-yet-expired poll untouched', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      expiresAt: Date.now() + 60_000,
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const { changed } = sweepExpiredPolls(created.state, Date.now());
    expect(changed).toHaveLength(0);
  });

  it('leaves a poll with no expiresAt untouched', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const { changed } = sweepExpiredPolls(created.state, Date.now());
    expect(changed).toHaveLength(0);
  });

  it('never re-decides an already-decided/expired poll (idempotent across repeated sweeps)', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      defaultOptionId: 'a',
      expiresAt: Date.now() - 1,
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const first = sweepExpiredPolls(created.state, Date.now());
    expect(first.changed).toHaveLength(1);
    const second = sweepExpiredPolls(first.state, Date.now());
    expect(second.changed).toHaveLength(0);
  });

  it('boot-rehydrate scenario: a poll that expired while the gateway was down settles on the first sweep after restart', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      defaultOptionId: 'b',
      expiresAt: Date.now() - 10 * 60_000, // expired 10 minutes "ago", simulating downtime
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    // Freshly loaded state (as if just read off disk at boot) swept immediately.
    const { changed } = sweepExpiredPolls(created.state);
    expect(changed).toHaveLength(1);
    expect(changed[0].decision?.optionId).toBe('b');
  });
});

describe('pollsForStateSync', () => {
  it('returns open polls newest-first, plus the most recent 20 decided/expired', () => {
    let state = empty();
    for (let i = 0; i < 25; i++) {
      const created = createPoll(state, {
        roomId: 'room-1',
        question: `decided-${i}`,
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        requestedBy: 'hermes',
      });
      if (!created.ok) throw new Error('setup failed');
      const decided = decidePoll(created.state, created.poll.id, 'a', 'human');
      if (!decided.ok) throw new Error('setup failed');
      state = decided.state;
    }
    const openResult = createPoll(state, {
      roomId: 'room-1',
      question: 'still open',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!openResult.ok) throw new Error('setup failed');
    state = openResult.state;

    const synced = pollsForStateSync(state);
    expect(synced.filter((p) => p.status === 'open')).toHaveLength(1);
    expect(synced.filter((p) => p.status !== 'open')).toHaveLength(20);
    expect(synced[0].question).toBe('still open');
  });

  it('treats a withdrawn poll as settled — it leaves the open bucket and lands in the settled window', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'to withdraw',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const withdrawn = withdrawPoll(created.state, created.poll.id, 'no longer needed');
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    const synced = pollsForStateSync(withdrawn.state);
    expect(synced.filter((p) => p.status === 'open')).toHaveLength(0);
    expect(synced.find((p) => p.id === created.poll.id)?.status).toBe('withdrawn');
  });

  it('a long-open poll that is withdrawn still ranks by WHEN it settled, not its stale createdAt (live bug caught 2026-07-18)', () => {
    // Simulate a poll that sat open a long time (createdAt far in the past
    // relative to 20 freshly-decided polls below) before being withdrawn.
    // Real live symptom this regression-guards: the withdrawn poll vanished
    // from /api/state entirely instead of showing status:'withdrawn',
    // because the settled-window sort used to key on
    // `decision?.decidedAt ?? createdAt` — a withdrawn poll has neither a
    // decision nor a recent createdAt, so its stale createdAt lost to every
    // freshly-decided poll's recent decidedAt and it fell out of the top 20
    // on the very sync that should have shown it.
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'ancient poll',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'hermes',
    });
    if (!created.ok) throw new Error('setup failed');
    const oldCreatedAt = created.poll.createdAt - 1_000_000_000;
    let state: PollsState = { polls: [{ ...created.poll, createdAt: oldCreatedAt }] };

    for (let i = 0; i < 20; i++) {
      const fresh = createPoll(state, {
        roomId: 'room-1',
        question: `fresh-${i}`,
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        requestedBy: 'hermes',
      });
      if (!fresh.ok) throw new Error('setup failed');
      const decided = decidePoll(fresh.state, fresh.poll.id, 'a', 'human');
      if (!decided.ok) throw new Error('setup failed');
      state = decided.state;
    }

    const withdrawn = withdrawPoll(state, created.poll.id, 'ancient, retiring it');
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;

    const synced = pollsForStateSync(withdrawn.state);
    expect(synced.find((p) => p.id === created.poll.id)?.status).toBe('withdrawn');
  });
});

describe('hasApprovalRef', () => {
  it('de-dupes by externalRef.approvalId', () => {
    const created = createPoll(empty(), {
      roomId: 'room-1',
      question: 'Q',
      options: [{ label: 'A' }, { label: 'B' }],
      requestedBy: 'paperclip',
      source: 'paperclip',
      externalRef: { approvalId: 'appr-1', companyId: 'co-1' },
    });
    if (!created.ok) throw new Error('setup failed');
    expect(hasApprovalRef(created.state, 'appr-1')).toBe(true);
    expect(hasApprovalRef(created.state, 'appr-2')).toBe(false);
  });
});
