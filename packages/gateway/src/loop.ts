/**
 * Loop-lite: builder+judge auto-relay on free/local seats (Wave 2, planned in
 * docs/HANDOFF-2026-07-07-wave1.md). One room may run at most one loop: a
 * builder seat and a judge seat take turns, each turn addressed to the OTHER
 * seat via relay.ts's OWN exported relayMessageToAgents (mentions-patched
 * message clone) — same composition shape as the Router (router.ts), no
 * relay.ts edits.
 *
 * Config lives at `data/loops.json` (gateway-local, created with `{}` on boot
 * if absent — see ensureLoopsConfig). This module is pure gateway-local state
 * plus a handful of exported functions; the wiring (observe message.new,
 * drive the next turn, enforce free/local-only seats) lives in index.ts, same
 * split as router.ts/routeAndRelay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Whose turn is next. A fresh loop always starts awaiting the builder. */
export type LoopPhase = 'awaiting-builder' | 'awaiting-judge';

export interface LoopState {
  builderSeat: string;
  judgeSeat: string;
  /** 1..6 (mission cap). */
  maxRounds: number;
  active: boolean;
  /** Rounds completed so far (a "round" = one builder reply, matched by one judge reply). */
  round: number;
  phase: LoopPhase;
  startedAt: number;
  lastActivityAt: number;
}

/** `data/loops.json` shape: keyed by roomId. One loop per room (enforced by startLoop). */
export type LoopsConfig = Record<string, LoopState>;

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 6;

function loopsConfigPath(dataDir: string): string {
  return join(dataDir, 'loops.json');
}

/**
 * Load `data/loops.json`, writing `{}` to disk first if the file is absent —
 * same idiom as router.ts's ensureRouterConfig. A corrupt/unparsable file
 * falls back to an empty config rather than throwing: a malformed hand-edit
 * must not take the whole gateway down.
 */
export function ensureLoopsConfig(dataDir: string): LoopsConfig {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = loopsConfigPath(dataDir);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({}, null, 2), 'utf8');
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('loops.json must be an object keyed by roomId');
    }
    return parsed as LoopsConfig;
  } catch {
    return {};
  }
}

/** Persist the full config to `data/loops.json`. Never throws — a log/save failure must not break the driver. */
export function saveLoopsConfig(dataDir: string, cfg: LoopsConfig): void {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(loopsConfigPath(dataDir), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('[loop] failed to write loops.json', e);
  }
}

export interface StartLoopError {
  code: 'already-active' | 'same-seat' | 'invalid-rounds';
  message: string;
}

export interface StartLoopResult {
  ok: boolean;
  state?: LoopState;
  error?: StartLoopError;
}

/**
 * Start (or restart, if inactive) a loop for `roomId`. Mutates `cfg` in place
 * and returns the new state — the caller (index.ts) still owns persistence
 * (saveLoopsConfig) and eligibility checks (room membership, VERIFIED,
 * free/local billing) since those need live AgentState, which this pure
 * module never touches.
 *
 * "One loop per room": a room with an already-ACTIVE loop is rejected outright
 * — stop it first. An inactive (previously stopped) entry for the same room
 * is simply overwritten, so re-starting a room's loop after it finished is
 * not blocked by stale history.
 */
export function startLoop(
  cfg: LoopsConfig,
  roomId: string,
  builderSeat: string,
  judgeSeat: string,
  maxRounds: number
): StartLoopResult {
  const existing = cfg[roomId];
  if (existing?.active) {
    return { ok: false, error: { code: 'already-active', message: `Room ${roomId} already has an active loop.` } };
  }
  if (builderSeat === judgeSeat) {
    return { ok: false, error: { code: 'same-seat', message: 'Builder and judge must be different seats.' } };
  }
  if (!Number.isInteger(maxRounds) || maxRounds < MIN_ROUNDS || maxRounds > MAX_ROUNDS) {
    return {
      ok: false,
      error: { code: 'invalid-rounds', message: `maxRounds must be an integer between ${MIN_ROUNDS} and ${MAX_ROUNDS}.` },
    };
  }

  const now = Date.now();
  const state: LoopState = {
    builderSeat,
    judgeSeat,
    maxRounds,
    active: true,
    round: 0,
    phase: 'awaiting-builder',
    startedAt: now,
    lastActivityAt: now,
  };
  cfg[roomId] = state;
  return { ok: true, state };
}

/** Stop a room's loop (active=false). Config entry is KEPT for audit trail (round count, seats used) rather than deleted. No-op if no loop exists or it's already inactive. */
export function stopLoop(cfg: LoopsConfig, roomId: string): boolean {
  const existing = cfg[roomId];
  if (!existing || !existing.active) return false;
  existing.active = false;
  existing.lastActivityAt = Date.now();
  return true;
}

/**
 * Judge-approval detection: a STRICT prefix-anchored, case-sensitive match on
 * the literal token `APPROVED` at the start of a line (mission spec: "reply
 * APPROVED or concrete revision notes... stop on APPROVED (case-sensitive
 * token at line start)"). Deliberately narrow so a judge writing "not
 * APPROVED yet, needs X" or quoting the word inside revision notes does NOT
 * false-trigger — only a message that LEADS with the token counts.
 */
export function isJudgeApproval(judgeMessageContent: string): boolean {
  return /^APPROVED\b/m.test(judgeMessageContent.trimStart());
}

export type LoopAction =
  | { kind: 'advance-to-judge' }
  | { kind: 'advance-to-builder' }
  | { kind: 'stop-approved' }
  | { kind: 'stop-max-rounds' }
  | { kind: 'noop' };

/**
 * Pure decision: given the current loop state, who just spoke, and their
 * message content, return what should happen next. Does not mutate `loop` —
 * the caller applies the returned action (advancing phase/round, flipping
 * active, persisting, and driving relayMessageToAgents) so this function stays
 * trivially testable against plain data.
 *
 * Round counting: a "round" completes when the JUDGE replies (builder reply
 * -> judge reviews it -> that's round N). maxRounds is checked AFTER
 * incrementing on a judge reply that is not an approval, so maxRounds=1 means
 * "the judge gets exactly one look before the loop stops even without
 * approval" — never an infinite loop when the judge just won't approve.
 */
export function decideNext(loop: LoopState, speakerId: string, content: string): LoopAction {
  if (!loop.active) return { kind: 'noop' };

  if (loop.phase === 'awaiting-builder') {
    if (speakerId !== loop.builderSeat) return { kind: 'noop' };
    return { kind: 'advance-to-judge' };
  }

  // phase === 'awaiting-judge'
  if (speakerId !== loop.judgeSeat) return { kind: 'noop' };
  if (isJudgeApproval(content)) return { kind: 'stop-approved' };
  if (loop.round + 1 >= loop.maxRounds) return { kind: 'stop-max-rounds' };
  return { kind: 'advance-to-builder' };
}

/**
 * Apply a decided action to `loop` in place (phase/round/active/timestamp),
 * mirroring what index.ts's driver does after calling decideNext + the
 * corresponding relayMessageToAgents/postSystemLine side effects. Kept
 * separate from decideNext so tests can assert the decision and the state
 * transition independently.
 */
export function applyLoopAction(loop: LoopState, action: LoopAction): void {
  loop.lastActivityAt = Date.now();
  switch (action.kind) {
    case 'advance-to-judge':
      loop.phase = 'awaiting-judge';
      return;
    case 'advance-to-builder':
      loop.round += 1;
      loop.phase = 'awaiting-builder';
      return;
    case 'stop-approved':
    case 'stop-max-rounds':
      loop.round += 1;
      loop.active = false;
      return;
    case 'noop':
      return;
  }
}
