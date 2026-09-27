import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentState, Room, ServerEvent } from '@agent-os/shared';
import { openDatabase, type SqlDatabase } from './db.js';
import type { RelayDeps } from './relay.js';
import { getRoomRelayState } from './relay.js';
import {
  applyNewRoomBudget,
  applyRoomTokenUsage,
  maybeResumeFromTokenPause,
  turnTokenBudgetBreach,
} from './budgets.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'budgets-test-'));
}

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    name: 'Test Room',
    type: 'group',
    memberIds: ['human', 'agent-a'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: 12,
    ...overrides,
  };
}

describe('budgets', () => {
  let dataDir: string;
  let db: SqlDatabase;
  let deps: RelayDeps;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataDir = freshDataDir();
    db = await openDatabase(dataDir);
    broadcast = vi.fn();
    deps = {
      db,
      dataDir,
      agents: new Map<string, AgentState>(),
      rooms: new Map<string, Room>(),
      messages: new Map(),
      roomRelay: new Map(),
      globalCost: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} },
      broadcast: (event: ServerEvent) => broadcast(event),
      agentDisplayName: (agentId: string) => agentId,
    };
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('applyRoomTokenUsage', () => {
    it('tallies tokens and cost onto room.costTracker without touching pause state below 80%', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);

      applyRoomTokenUsage(deps, room.id, 'agent-a', 100, 50, 0.01);

      expect(room.costTracker).toEqual({
        tokensIn: 100,
        tokensOut: 50,
        estimatedCostUsd: 0.01,
        byAgent: { 'agent-a': { tokensIn: 100, tokensOut: 50, costUsd: 0.01 } },
      });
      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokensUsed).toBe(150);
      expect(rs.tokenPaused).toBe(false);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts budget.warning exactly once when crossing 80%', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);

      applyRoomTokenUsage(deps, room.id, 'agent-a', 400, 0, 0); // 40%
      applyRoomTokenUsage(deps, room.id, 'agent-a', 400, 0, 0); // 80% — crosses
      applyRoomTokenUsage(deps, room.id, 'agent-a', 10, 0, 0); // still >=80%, must not re-warn

      const warnings = broadcast.mock.calls.filter((c) => c[0].type === 'budget.warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toEqual({ type: 'budget.warning', payload: { roomId: room.id, percent: 80 } });
    });

    it('pauses and broadcasts budget.exceeded exactly once at 100%', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);

      applyRoomTokenUsage(deps, room.id, 'agent-a', 1000, 0, 0); // 100%
      applyRoomTokenUsage(deps, room.id, 'agent-a', 50, 0, 0); // still over, must not re-broadcast

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenPaused).toBe(true);
      const exceeded = broadcast.mock.calls.filter((c) => c[0].type === 'budget.exceeded');
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0][0]).toEqual({ type: 'budget.exceeded', payload: { roomId: room.id } });
    });

    it('does nothing budget-wise when the room has no budgetCap', () => {
      const room = makeRoom();
      deps.rooms.set(room.id, room);

      applyRoomTokenUsage(deps, room.id, 'agent-a', 10_000_000, 0, 0);

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenPaused).toBe(false);
      expect(broadcast).not.toHaveBeenCalled();
      // Tally still accrues even with no cap to check against.
      expect(rs.tokensUsed).toBe(10_000_000);
    });
  });

  describe('maybeResumeFromTokenPause (asymmetric resume)', () => {
    it('grants the +25% extension once on the first human message after a pause', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);
      applyRoomTokenUsage(deps, room.id, 'agent-a', 1000, 0, 0); // pause at 100%
      expect(getRoomRelayState(deps.roomRelay, room.id).tokenPaused).toBe(true);

      maybeResumeFromTokenPause(deps, room.id);

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenPaused).toBe(false);
      expect(rs.tokenExtensionUsed).toBe(true);
    });

    it('stays paused on a SECOND pause after the extension was already spent (no infinite nagging)', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);
      applyRoomTokenUsage(deps, room.id, 'agent-a', 1000, 0, 0); // pause #1 at 100% of 1000
      maybeResumeFromTokenPause(deps, room.id); // grants +25% -> effective cap 1250, extension spent

      applyRoomTokenUsage(deps, room.id, 'agent-a', 250, 0, 0); // now at 1250/1250 = 100% of extended cap
      const rsAfterSecondBreach = getRoomRelayState(deps.roomRelay, room.id);
      expect(rsAfterSecondBreach.tokenPaused).toBe(true);

      maybeResumeFromTokenPause(deps, room.id); // extension already used — must stay paused

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenPaused).toBe(true);
    });

    it('is a no-op when the room is not currently token-paused', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);

      maybeResumeFromTokenPause(deps, room.id);

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenExtensionUsed).toBe(false);
      expect(rs.tokenPaused).toBe(false);
    });
  });

  describe('applyNewRoomBudget', () => {
    it('clears an existing pause and resets the extension flag when the new cap exceeds current usage', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);
      applyRoomTokenUsage(deps, room.id, 'agent-a', 1000, 0, 0);
      maybeResumeFromTokenPause(deps, room.id); // extension spent
      applyRoomTokenUsage(deps, room.id, 'agent-a', 250, 0, 0); // paused again, extension already used

      applyNewRoomBudget(deps, room.id, 5000); // raises the cap well above current usage (1250)

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenPaused).toBe(false);
      expect(rs.tokenExtensionUsed).toBe(false);
    });

    it('does not un-pause when the new cap still does not cover current usage', () => {
      const room = makeRoom({ budgetCap: { tokens: 1000, costUsd: 5 } });
      deps.rooms.set(room.id, room);
      applyRoomTokenUsage(deps, room.id, 'agent-a', 1000, 0, 0);

      applyNewRoomBudget(deps, room.id, 500); // still under current usage

      const rs = getRoomRelayState(deps.roomRelay, room.id);
      expect(rs.tokenPaused).toBe(true);
    });
  });

  describe('turnTokenBudgetBreach', () => {
    const originalEnv = process.env.AGENT_OS_MAX_TOKENS_PER_TURN;
    const originalPerSeatEnv = process.env.AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN;

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.AGENT_OS_MAX_TOKENS_PER_TURN;
      else process.env.AGENT_OS_MAX_TOKENS_PER_TURN = originalEnv;
      if (originalPerSeatEnv === undefined) delete process.env.AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN;
      else process.env.AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN = originalPerSeatEnv;
    });

    it('returns null under the default 150k cap', () => {
      delete process.env.AGENT_OS_MAX_TOKENS_PER_TURN;
      expect(turnTokenBudgetBreach('agent-a', 50_000, 50_000)).toBeNull();
    });

    it('flags a breach over the default 150k cap', () => {
      delete process.env.AGENT_OS_MAX_TOKENS_PER_TURN;
      const breach = turnTokenBudgetBreach('agent-a', 100_000, 100_000);
      expect(breach).toEqual({ tokens: 200_000, cap: 150_000 });
    });

    it('honors an env override, and 0 disables the check', () => {
      process.env.AGENT_OS_MAX_TOKENS_PER_TURN = '1000';
      expect(turnTokenBudgetBreach('agent-a', 600, 600)).toEqual({ tokens: 1200, cap: 1000 });

      process.env.AGENT_OS_MAX_TOKENS_PER_TURN = '0';
      expect(turnTokenBudgetBreach('agent-a', 1_000_000, 1_000_000)).toBeNull();
    });

    it('AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN overrides the built-in per-seat cap', () => {
      process.env.AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN = JSON.stringify({ 'claude-code#advisor': 500 });
      expect(turnTokenBudgetBreach('claude-code#advisor', 300, 300)).toEqual({ tokens: 600, cap: 500 });
    });
  });
});
