/**
 * Room token budgets. Semantics mirror the
 * existing turn cap (relay.ts commitAgentReply) but track a SEPARATE
 * gateway-local pause flag (RoomRelayState.tokenPaused) — a token pause and a
 * turn-cap pause are independent conditions, both gate relayMessageToAgents.
 *
 * Kept out of runOne/handleEvent settle paths entirely: everything here is
 * called from commitAgentReply/recordUsage (after a turn has already
 * settled) or from onRoomChatMessage (human message handling), never from
 * the settle-exactly-once machinery in AgentRelayWorker.
 */

import type { CostReport, Room, ServerEvent } from '@agent-os/shared';
import { saveRoom } from './db.js';
import type { RelayDeps, RoomRelayState } from './relay.js';
import { getRoomRelayState } from './relay.js';
import { maxTokensPerTurnForSeat } from './gatewayLocalConfig.js';

/** Effective cap for a room: budgetCap.tokens, times 1.25 if the one-time resume extension has been granted. */
function effectiveTokenCap(room: Room, rs: RoomRelayState): number | undefined {
  const base = room.budgetCap?.tokens;
  if (base == null) return undefined;
  return rs.tokenExtensionUsed ? base * 1.25 : base;
}

function emptyCostTracker(): CostReport {
  return { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
}

/**
 * Add this turn's usage to the room's token tally and cost tracker, then
 * evaluate the 80%/100% thresholds. Call once per recorded usage event,
 * AFTER the per-agent cost accounting in relay.ts's recordUsage.
 */
export function applyRoomTokenUsage(
  deps: RelayDeps,
  roomId: string,
  agentId: string,
  tokensIn: number,
  tokensOut: number,
  estimatedCostUsd: number
): void {
  const room = deps.rooms.get(roomId);
  if (!room) return;

  const rs = getRoomRelayState(deps.roomRelay, roomId);
  rs.tokensUsed += tokensIn + tokensOut;

  const tracker = room.costTracker ?? emptyCostTracker();
  tracker.tokensIn += tokensIn;
  tracker.tokensOut += tokensOut;
  tracker.estimatedCostUsd += estimatedCostUsd;
  const by = tracker.byAgent[agentId] ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  by.tokensIn += tokensIn;
  by.tokensOut += tokensOut;
  by.costUsd += estimatedCostUsd;
  tracker.byAgent[agentId] = by;
  room.costTracker = tracker;
  saveRoom(deps.db, room);

  const cap = effectiveTokenCap(room, rs);
  if (cap == null || cap <= 0) return;

  const percent = (rs.tokensUsed / cap) * 100;

  if (percent >= 100) {
    if (!rs.tokenPaused) {
      rs.tokenPaused = true;
      deps.broadcast({ type: 'budget.exceeded', payload: { roomId } });
    }
    return;
  }

  if (percent >= 80 && rs.lastWarnedPercent < 80) {
    rs.lastWarnedPercent = 80;
    deps.broadcast({ type: 'budget.warning', payload: { roomId, percent: 80 } });
  }
}

/**
 * Human-message resume mirror of the turn cap's reset — but ASYMMETRIC by
 * design (spec: "resume grants +25% headroom once, then pauses again — no
 * infinite nagging"). Unlike the turn cap (which any human message resets
 * unconditionally), a token pause only clears the FIRST time a human speaks
 * after pausing; the second time, it stays paused until room.set-budget
 * raises the cap.
 */
export function maybeResumeFromTokenPause(deps: RelayDeps, roomId: string): void {
  const rs = getRoomRelayState(deps.roomRelay, roomId);
  if (!rs.tokenPaused) return;

  if (!rs.tokenExtensionUsed) {
    rs.tokenExtensionUsed = true;
    rs.tokenPaused = false;
    // Effective cap just grew (base * 1.25) — the old 80% warning no longer
    // applies at the new cap; let it re-fire once actual usage crosses 80%
    // of the extended cap.
    rs.lastWarnedPercent = 0;
    return;
  }
  // Extension already spent this budget cycle — stay paused; only
  // room.set-budget (raising the cap) clears tokenExtensionUsed. Re-broadcast
  // the pause so the UI banner (optimistically cleared on every human
  // message, mirroring the turn-cap banner) comes back — without this, a
  // human message into a still-paused room clears the banner client-side and
  // no agent turn ever runs to re-fire budget.exceeded, leaving the room
  // silently dead with no visible reason.
  deps.broadcast({ type: 'budget.exceeded', payload: { roomId } });
}

/**
 * room.set-budget handler support: applying a new cap. If the new effective
 * cap (raw tokens, extension always reset here) now exceeds current usage,
 * clear the pause and reset the extension flag — a fresh budget is a fresh
 * start, not an implicit extension-consumption.
 */
export function applyNewRoomBudget(deps: RelayDeps, roomId: string, tokens: number): void {
  const rs = getRoomRelayState(deps.roomRelay, roomId);
  rs.tokenExtensionUsed = false;
  rs.lastWarnedPercent = rs.tokensUsed >= tokens ? rs.lastWarnedPercent : 0;
  if (tokens <= 0 || rs.tokensUsed < tokens) {
    rs.tokenPaused = false;
  }
}

export interface TurnTokenBudgetBreach {
  agentDisplayName: string;
  tokens: number;
  cap: number;
}

/**
 * Single-turn guard (docs spec: "catches the hermes blowup"). Does NOT pause
 * the room and does NOT touch RoomRelayState — it only tells the caller
 * (relay.ts commitAgentReply) whether this one reply's onward fan-out should
 * be suppressed. 0 (or unset) disables the check.
 *
 * `agentId` is the seat id (relay.ts's `this.agentId`) — cap resolution goes
 * through maxTokensPerTurnForSeat, which checks a per-seat override before
 * falling back to the process-global default, so one seat (e.g. the
 * Fable-5 advisor seat, capped at 6,000) can be tighter than the rest of
 * the fleet without lowering everyone else's cap.
 *
 * NOTE this is a post-hoc detector, not a preemptive truncation: the CLI
 * turn has already run to completion and its usage is already known by the
 * time this is called (see relay.ts commitAgentReply) — the claude-code CLI
 * has no flag that caps output tokens mid-generation. A breach here means
 * "this turn already exceeded the cap"; the reply still gets recorded, only
 * the onward agent-to-agent fan-out is suppressed.
 */
export function turnTokenBudgetBreach(
  agentId: string,
  tokensIn: number,
  tokensOut: number
): { tokens: number; cap: number } | null {
  const cap = maxTokensPerTurnForSeat(agentId);
  if (cap <= 0) return null;
  const tokens = tokensIn + tokensOut;
  if (tokens <= cap) return null;
  return { tokens, cap };
}

export function turnTokenBudgetErrorEvent(
  agentDisplayName: string,
  tokens: number,
  cap: number
): ServerEvent {
  return {
    type: 'error',
    payload: {
      code: 'budget.turn-tokens',
      message: `${agentDisplayName} consumed ${tokens} tokens in one turn (cap ${cap})`,
      recoverable: true,
    },
  };
}
