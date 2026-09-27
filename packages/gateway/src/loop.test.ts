import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyLoopAction,
  decideNext,
  ensureLoopsConfig,
  isJudgeApproval,
  saveLoopsConfig,
  startLoop,
  stopLoop,
  type LoopState,
  type LoopsConfig,
} from './loop.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'loop-test-'));
}

function makeLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    builderSeat: 'hermes',
    judgeSeat: 'grok-build',
    maxRounds: 6,
    active: true,
    round: 0,
    phase: 'awaiting-builder',
    startedAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

describe('isJudgeApproval', () => {
  it('is true for a message starting with APPROVED', () => {
    expect(isJudgeApproval('APPROVED')).toBe(true);
    expect(isJudgeApproval('APPROVED — looks good, ship it.')).toBe(true);
  });

  it('is true when APPROVED is the first line of a multi-line message', () => {
    expect(isJudgeApproval('APPROVED\n\nNice work on the edge cases.')).toBe(true);
  });

  it('tolerates leading whitespace before the token', () => {
    expect(isJudgeApproval('   APPROVED')).toBe(true);
  });

  it('is case-sensitive: lowercase/mixed-case does NOT match', () => {
    expect(isJudgeApproval('approved')).toBe(false);
    expect(isJudgeApproval('Approved')).toBe(false);
  });

  it('does NOT match when APPROVED appears mid-sentence or is negated', () => {
    // Regression case from the mission spec: a judge saying revision notes
    // that happen to CONTAIN the word must not false-trigger.
    expect(isJudgeApproval('This is not yet APPROVED, please fix the null check.')).toBe(false);
    expect(isJudgeApproval('Almost APPROVED but one more pass needed.')).toBe(false);
  });

  it('does NOT match a word that merely starts with APPROVED as a substring', () => {
    expect(isJudgeApproval('APPROVEDish, needs one more look')).toBe(false);
  });

  it('is false for empty or whitespace-only content', () => {
    expect(isJudgeApproval('')).toBe(false);
    expect(isJudgeApproval('   ')).toBe(false);
  });
});

describe('decideNext', () => {
  it('returns noop when the loop is inactive', () => {
    const loop = makeLoop({ active: false });
    expect(decideNext(loop, 'hermes', 'some reply')).toEqual({ kind: 'noop' });
  });

  it('returns noop when the speaker is not the seat whose turn it is (awaiting-builder)', () => {
    const loop = makeLoop({ phase: 'awaiting-builder' });
    expect(decideNext(loop, 'grok-build', 'not my turn')).toEqual({ kind: 'noop' });
  });

  it('returns noop when the speaker is not the seat whose turn it is (awaiting-judge)', () => {
    const loop = makeLoop({ phase: 'awaiting-judge' });
    expect(decideNext(loop, 'hermes', 'not my turn')).toEqual({ kind: 'noop' });
  });

  it('returns noop for a bystander message from neither loop seat', () => {
    const loop = makeLoop({ phase: 'awaiting-builder' });
    expect(decideNext(loop, 'claude-code', 'butting in')).toEqual({ kind: 'noop' });
  });

  it('advances to judge when the builder replies', () => {
    const loop = makeLoop({ phase: 'awaiting-builder' });
    expect(decideNext(loop, 'hermes', 'here is my patch')).toEqual({ kind: 'advance-to-judge' });
  });

  it('stops approved when the judge approves', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 2, maxRounds: 6 });
    expect(decideNext(loop, 'grok-build', 'APPROVED, ship it')).toEqual({ kind: 'stop-approved' });
  });

  it('advances to builder when the judge gives revision notes (below maxRounds)', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 0, maxRounds: 6 });
    expect(decideNext(loop, 'grok-build', 'needs a null check on line 12')).toEqual({ kind: 'advance-to-builder' });
  });

  it('stops at maxRounds even without approval', () => {
    // round=1, maxRounds=2: round+1 (2) >= maxRounds (2) -> stop, no infinite loop.
    const loop = makeLoop({ phase: 'awaiting-judge', round: 1, maxRounds: 2 });
    expect(decideNext(loop, 'grok-build', 'still not quite right')).toEqual({ kind: 'stop-max-rounds' });
  });

  it('stops at maxRounds=1 on the judge\'s very first look, even without approval', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 0, maxRounds: 1 });
    expect(decideNext(loop, 'grok-build', 'not approved')).toEqual({ kind: 'stop-max-rounds' });
  });

  it('approval wins over maxRounds when both conditions would apply on the same message', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 0, maxRounds: 1 });
    expect(decideNext(loop, 'grok-build', 'APPROVED')).toEqual({ kind: 'stop-approved' });
  });
});

describe('applyLoopAction', () => {
  it('advance-to-judge sets phase to awaiting-judge without touching round', () => {
    const loop = makeLoop({ phase: 'awaiting-builder', round: 0 });
    applyLoopAction(loop, { kind: 'advance-to-judge' });
    expect(loop.phase).toBe('awaiting-judge');
    expect(loop.round).toBe(0);
    expect(loop.active).toBe(true);
  });

  it('advance-to-builder increments round and sets phase to awaiting-builder', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 0 });
    applyLoopAction(loop, { kind: 'advance-to-builder' });
    expect(loop.phase).toBe('awaiting-builder');
    expect(loop.round).toBe(1);
    expect(loop.active).toBe(true);
  });

  it('stop-approved increments round and deactivates the loop', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 2 });
    applyLoopAction(loop, { kind: 'stop-approved' });
    expect(loop.round).toBe(3);
    expect(loop.active).toBe(false);
  });

  it('stop-max-rounds increments round and deactivates the loop', () => {
    const loop = makeLoop({ phase: 'awaiting-judge', round: 1 });
    applyLoopAction(loop, { kind: 'stop-max-rounds' });
    expect(loop.round).toBe(2);
    expect(loop.active).toBe(false);
  });

  it('noop leaves phase/round/active untouched', () => {
    const loop = makeLoop({ phase: 'awaiting-builder', round: 3, active: true });
    applyLoopAction(loop, { kind: 'noop' });
    expect(loop.phase).toBe('awaiting-builder');
    expect(loop.round).toBe(3);
    expect(loop.active).toBe(true);
  });

  it('bumps lastActivityAt on every action, including noop', () => {
    const loop = makeLoop({ lastActivityAt: 1 });
    applyLoopAction(loop, { kind: 'noop' });
    expect(loop.lastActivityAt).toBeGreaterThan(1);
  });
});

describe('startLoop', () => {
  let cfg: LoopsConfig;

  beforeEach(() => {
    cfg = {};
  });

  it('starts a fresh loop with phase awaiting-builder and round 0', () => {
    const result = startLoop(cfg, 'room-1', 'hermes', 'grok-build', 4);
    expect(result.ok).toBe(true);
    expect(result.state).toMatchObject({
      builderSeat: 'hermes',
      judgeSeat: 'grok-build',
      maxRounds: 4,
      active: true,
      round: 0,
      phase: 'awaiting-builder',
    });
    expect(cfg['room-1']).toBe(result.state);
  });

  it('rejects starting a loop when one is already active for the room', () => {
    startLoop(cfg, 'room-1', 'hermes', 'grok-build', 4);
    const second = startLoop(cfg, 'room-1', 'grok-build', 'hermes', 3);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('already-active');
    // Original loop is untouched.
    expect(cfg['room-1'].builderSeat).toBe('hermes');
  });

  it('allows re-starting a room whose previous loop is inactive (stopped)', () => {
    startLoop(cfg, 'room-1', 'hermes', 'grok-build', 4);
    stopLoop(cfg, 'room-1');
    const restarted = startLoop(cfg, 'room-1', 'grok-build', 'hermes', 2);
    expect(restarted.ok).toBe(true);
    expect(cfg['room-1'].builderSeat).toBe('grok-build');
    expect(cfg['room-1'].round).toBe(0);
  });

  it('rejects builder and judge being the same seat', () => {
    const result = startLoop(cfg, 'room-1', 'hermes', 'hermes', 4);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('same-seat');
  });

  it('rejects maxRounds below 1', () => {
    const result = startLoop(cfg, 'room-1', 'hermes', 'grok-build', 0);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid-rounds');
  });

  it('rejects maxRounds above 6', () => {
    const result = startLoop(cfg, 'room-1', 'hermes', 'grok-build', 7);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid-rounds');
  });

  it('rejects a non-integer maxRounds', () => {
    const result = startLoop(cfg, 'room-1', 'hermes', 'grok-build', 3.5);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid-rounds');
  });

  it('accepts the boundary values 1 and 6', () => {
    expect(startLoop(cfg, 'room-1', 'hermes', 'grok-build', 1).ok).toBe(true);
    expect(startLoop(cfg, 'room-2', 'hermes', 'grok-build', 6).ok).toBe(true);
  });
});

describe('stopLoop', () => {
  it('deactivates an active loop and returns true', () => {
    const cfg: LoopsConfig = { 'room-1': makeLoop({ active: true }) };
    const result = stopLoop(cfg, 'room-1');
    expect(result).toBe(true);
    expect(cfg['room-1'].active).toBe(false);
  });

  it('keeps the config entry (audit trail) rather than deleting it', () => {
    const cfg: LoopsConfig = { 'room-1': makeLoop({ active: true, round: 3 }) };
    stopLoop(cfg, 'room-1');
    expect(cfg['room-1']).toBeDefined();
    expect(cfg['room-1'].round).toBe(3);
  });

  it('returns false and no-ops when no loop exists for the room', () => {
    const cfg: LoopsConfig = {};
    expect(stopLoop(cfg, 'room-1')).toBe(false);
  });

  it('returns false when the loop is already inactive', () => {
    const cfg: LoopsConfig = { 'room-1': makeLoop({ active: false }) };
    expect(stopLoop(cfg, 'room-1')).toBe(false);
  });
});

describe('ensureLoopsConfig / saveLoopsConfig', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = freshDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes an empty object to disk when loops.json is absent', () => {
    const cfg = ensureLoopsConfig(dataDir);
    expect(cfg).toEqual({});
    const path = join(dataDir, 'loops.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });

  it('loads an existing loops.json unchanged', () => {
    ensureLoopsConfig(dataDir); // creates the default file
    const loop = makeLoop();
    const path = join(dataDir, 'loops.json');
    writeFileSync(path, JSON.stringify({ 'room-1': loop }), 'utf8');
    const loaded = ensureLoopsConfig(dataDir);
    expect(loaded).toEqual({ 'room-1': loop });
  });

  it('falls back to an empty config when loops.json is corrupt, without throwing', () => {
    const path = join(dataDir, 'loops.json');
    writeFileSync(path, '{ not valid json', 'utf8');
    expect(() => ensureLoopsConfig(dataDir)).not.toThrow();
    expect(ensureLoopsConfig(dataDir)).toEqual({});
  });

  it('falls back to an empty config when loops.json is a JSON array, not an object', () => {
    const path = join(dataDir, 'loops.json');
    writeFileSync(path, '[]', 'utf8');
    expect(ensureLoopsConfig(dataDir)).toEqual({});
  });

  it('round-trips saveLoopsConfig through ensureLoopsConfig', () => {
    const cfg: LoopsConfig = { 'room-1': makeLoop({ round: 2 }) };
    saveLoopsConfig(dataDir, cfg);
    expect(ensureLoopsConfig(dataDir)).toEqual(cfg);
  });
});
