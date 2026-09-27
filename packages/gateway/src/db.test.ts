import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  insertCostEvent,
  loadRooms,
  openDatabase,
  persistDatabase,
  recomputeCostTotals,
  saveRoom,
  type SqlDatabase,
} from './db.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'db-cost-test-'));
}

describe('recomputeCostTotals (boot rehydration)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('sums tokens/cost per room and per agent across multiple events', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);

    insertCostEvent(db, {
      agentId: 'agent-a',
      roomId: 'room-1',
      modelTier: 'high',
      tokensIn: 100,
      tokensOut: 50,
      estimatedCostUsd: 1.5,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });
    insertCostEvent(db, {
      agentId: 'agent-a',
      roomId: 'room-1',
      modelTier: 'high',
      tokensIn: 200,
      tokensOut: 25,
      estimatedCostUsd: 2.0,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });
    insertCostEvent(db, {
      agentId: 'agent-b',
      roomId: 'room-1',
      modelTier: 'local',
      tokensIn: 10,
      tokensOut: 10,
      estimatedCostUsd: 0,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });
    insertCostEvent(db, {
      agentId: 'agent-a',
      roomId: 'room-2',
      modelTier: 'high',
      tokensIn: 5,
      tokensOut: 5,
      estimatedCostUsd: 0.1,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });

    const totals = recomputeCostTotals(db);

    const room1 = totals.byRoom.get('room-1')!;
    expect(room1.tokensIn).toBe(310);
    expect(room1.tokensOut).toBe(85);
    expect(room1.estimatedCostUsd).toBeCloseTo(3.5);
    expect(room1.byAgent['agent-a']).toEqual({ tokensIn: 300, tokensOut: 75, costUsd: 3.5 });
    expect(room1.byAgent['agent-b']).toEqual({ tokensIn: 10, tokensOut: 10, costUsd: 0 });

    const room2 = totals.byRoom.get('room-2')!;
    expect(room2.tokensIn).toBe(5);
    expect(room2.tokensOut).toBe(5);

    const agentATotal = totals.byAgent.get('agent-a')!;
    expect(agentATotal).toEqual({ tokensIn: 305, tokensOut: 80, costUsd: 3.6 });

    expect(totals.global.tokensIn).toBe(315);
    expect(totals.global.tokensOut).toBe(90);
    expect(totals.global.estimatedCostUsd).toBeCloseTo(3.6);
  });

  it('returns empty maps/zeroed totals for a fresh database with no cost_events', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);

    const totals = recomputeCostTotals(db);

    expect(totals.byRoom.size).toBe(0);
    expect(totals.byAgent.size).toBe(0);
    expect(totals.global).toEqual({ tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  });

  it('skips null-room_id events for byRoom but still counts them in byAgent/global', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);

    insertCostEvent(db, {
      agentId: 'agent-a',
      modelTier: 'high',
      tokensIn: 42,
      tokensOut: 7,
      estimatedCostUsd: 0.5,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });

    const totals = recomputeCostTotals(db);

    expect(totals.byRoom.size).toBe(0);
    expect(totals.byAgent.get('agent-a')).toEqual({ tokensIn: 42, tokensOut: 7, costUsd: 0.5 });
    expect(totals.global.tokensIn).toBe(42);
  });

  it('survives a SIMULATED PROCESS RESTART: totals rebuilt from a reopened on-disk database still show non-zero per-room/per-agent/global numbers, matching what was there before the restart', async () => {
    dataDir = freshDataDir();

    // "Before restart": write cost events, then persist to disk exactly as the
    // gateway's setInterval(() => persistDatabase(...), 5000) does in index.ts.
    let db: SqlDatabase = await openDatabase(dataDir);
    insertCostEvent(db, {
      agentId: 'hermes',
      roomId: 'room-quad',
      modelTier: 'local',
      tokensIn: 220_000,
      tokensOut: 4_000,
      estimatedCostUsd: 0,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });
    insertCostEvent(db, {
      agentId: 'claude-code',
      roomId: 'room-quad',
      modelTier: 'high',
      tokensIn: 8_000,
      tokensOut: 1_200,
      estimatedCostUsd: 0,
      timestamp: Date.now(),
      outcome: 'message-complete',
    });
    persistDatabase(db, dataDir);

    // Sanity: totals are non-zero BEFORE the simulated restart (otherwise the
    // "survives a restart" assertion below would be vacuously true).
    const before = recomputeCostTotals(db);
    expect(before.global.tokensIn).toBe(228_000);
    expect(before.byAgent.get('hermes')!.tokensIn).toBe(220_000);

    // "Restart": drop the in-memory handle entirely and reopen from the file
    // persistDatabase just wrote — this is the actual boot path (openDatabase
    // reads gateway.db off disk when it exists), not just re-querying the same
    // live handle the previous tests exercised.
    db = await openDatabase(dataDir);

    const after = recomputeCostTotals(db);

    // Global — this is GatewayState.globalCost's top-level fields.
    expect(after.global.tokensIn).toBe(228_000);
    expect(after.global.tokensOut).toBe(5_200);
    expect(after.global.estimatedCostUsd).toBe(0);

    // Per-agent — this is globalCost.byAgent, what the gateway now also sends
    // over the wire on connect (agent.cost.snapshot) so the UI's
    // agentTokenTotals reads real numbers on a fresh tab instead of 0s.
    expect(after.byAgent.get('hermes')).toEqual({ tokensIn: 220_000, tokensOut: 4_000, costUsd: 0 });
    expect(after.byAgent.get('claude-code')).toEqual({ tokensIn: 8_000, tokensOut: 1_200, costUsd: 0 });

    // Per-room — this is Room.costTracker, rehydrated the same way.
    const roomQuad = after.byRoom.get('room-quad')!;
    expect(roomQuad.tokensIn).toBe(228_000);
    expect(roomQuad.tokensOut).toBe(5_200);
  });
});

// INC 2026-07-21 — the Approvals-room vanish. persistDatabase used to rewrite
// gateway.db in place (writeFileSync truncates to 0 before writing ~3 MB); a
// kill inside that window left a 0-byte file, and openDatabase happily built
// an EMPTY sql.js database from it, so the gateway booted into a blank world
// and silently discarded every room and message. Both halves are covered here.
describe('persistDatabase durability (INC 2026-07-21)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves no temp file behind and round-trips through a real reopen', async () => {
    dataDir = freshDataDir();
    const db = await openDatabase(dataDir);
    saveRoom(db, {
      id: 'approvals',
      name: 'Approvals',
      type: 'group',
      memberIds: [],
      createdAt: 1,
      updatedAt: 1,
      turnCap: 12,
    });
    persistDatabase(db, dataDir);

    expect(existsSync(join(dataDir, 'gateway.db.tmp'))).toBe(false);
    expect(statSync(join(dataDir, 'gateway.db')).size).toBeGreaterThan(0);

    const reopened = await openDatabase(dataDir);
    expect(loadRooms(reopened).map((r) => r.name)).toEqual(['Approvals']);
  });

  it('refuses to boot from a 0-byte gateway.db instead of starting an empty world', async () => {
    dataDir = freshDataDir();
    const db = await openDatabase(dataDir);
    saveRoom(db, {
      id: 'approvals',
      name: 'Approvals',
      type: 'group',
      memberIds: [],
      createdAt: 1,
      updatedAt: 1,
      turnCap: 12,
    });
    persistDatabase(db, dataDir);

    // Simulate the interrupted write: the file exists, but has no bytes.
    writeFileSync(join(dataDir, 'gateway.db'), Buffer.alloc(0));

    await expect(openDatabase(dataDir)).rejects.toThrow(/0 bytes/);
  });
});
