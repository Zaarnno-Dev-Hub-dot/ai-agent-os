/**
 * Write-batching semantics for persistDatabase (review 2026-08-04 §4.1 /
 * RISK 1). Kept in its own file rather than folded into db.test.ts because
 * the dirty flag is module-level process state: these tests must control when
 * it is set and cleared, and interleaving them with the durability tests in
 * db.test.ts would make both sets order-dependent.
 *
 * What must hold, and why each one matters:
 *  - a clean database is NOT rewritten on the 5 s tick (this is the entire
 *    point — the old interval rewrote the whole file every 5 s regardless);
 *  - every mutating helper marks dirty, so the two persistDatabase calls
 *    deleted from relay.ts (:354 insertCostEvent, :381 applyRoomTokenUsage ->
 *    saveRoom) are still written within one tick rather than dropped;
 *  - an immediate persistDatabase (the human's own chat.send path) clears the
 *    flag, so batching never causes a redundant second write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  flushDatabaseIfDirty,
  insertCostEvent,
  insertMessage,
  isDatabaseDirty,
  openDatabase,
  persistDatabase,
  saveRoom,
  softDeleteMessage,
  updateMessageContent,
  updateMessageReactions,
  type SqlDatabase,
} from './db.js';
import type { Message, Room } from '@agent-os/shared';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'db-batching-test-'));
}

function makeRoom(id: string): Room {
  return {
    id,
    name: `room ${id}`,
    type: 'group',
    memberIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCap: 12,
  };
}

function makeMessage(id: string, roomId: string): Message {
  return {
    id,
    roomId,
    senderId: 'human',
    content: `content ${id}`,
    createdAt: Date.now(),
  };
}

function costEvent(agentId: string, roomId: string) {
  return {
    agentId,
    roomId,
    modelTier: 'high',
    tokensIn: 10,
    tokensOut: 5,
    estimatedCostUsd: 0.01,
    timestamp: Date.now(),
    outcome: 'message-complete',
  };
}

describe('persistDatabase write batching (review 2026-08-04 §4.1)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not rewrite gateway.db when nothing changed — the 5s tick is a no-op on a clean DB', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);

    // Force a known-clean starting point (the flag is module state).
    persistDatabase(db, dataDir);
    expect(isDatabaseDirty()).toBe(false);

    const dbPath = join(dataDir, 'gateway.db');
    const before = statSync(dbPath).mtimeMs;

    // This is exactly what index.ts's interval now calls.
    expect(flushDatabaseIfDirty(db, dataDir)).toBe(false);
    expect(flushDatabaseIfDirty(db, dataDir)).toBe(false);

    // Not merely "returned false" — the file itself was never touched.
    expect(statSync(dbPath).mtimeMs).toBe(before);

    db.close();
  });

  it('insertMessage marks dirty and the next flush writes the row to disk', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    persistDatabase(db, dataDir);

    saveRoom(db, makeRoom('room-1'));
    insertMessage(db, makeMessage('msg-1', 'room-1'));
    expect(isDatabaseDirty()).toBe(true);

    expect(flushDatabaseIfDirty(db, dataDir)).toBe(true);
    expect(isDatabaseDirty()).toBe(false);

    // Reopen from disk — the batched write really landed, it wasn't just
    // sitting in the WASM heap.
    const reopened = await openDatabase(dataDir);
    const res = reopened.exec(`SELECT content FROM messages WHERE id = 'msg-1'`);
    expect(res[0]?.values[0]?.[0]).toBe('content msg-1');

    db.close();
    reopened.close();
  });

  it('insertCostEvent marks dirty — the write deleted from relay.ts:354 is still owed to the next tick', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    persistDatabase(db, dataDir);
    expect(isDatabaseDirty()).toBe(false);

    insertCostEvent(db, costEvent('agent-a', 'room-1'));
    expect(isDatabaseDirty()).toBe(true);

    expect(flushDatabaseIfDirty(db, dataDir)).toBe(true);
    const reopened = await openDatabase(dataDir);
    const res = reopened.exec(`SELECT COUNT(*) FROM cost_events`);
    expect(Number(res[0]?.values[0]?.[0])).toBe(1);

    db.close();
    reopened.close();
  });

  it('saveRoom marks dirty — the write deleted from relay.ts:381 (applyRoomTokenUsage) is still owed', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    persistDatabase(db, dataDir);
    expect(isDatabaseDirty()).toBe(false);

    saveRoom(db, makeRoom('room-budget'));
    expect(isDatabaseDirty()).toBe(true);

    expect(flushDatabaseIfDirty(db, dataDir)).toBe(true);
    const reopened = await openDatabase(dataDir);
    expect(reopened.exec(`SELECT id FROM rooms WHERE id = 'room-budget'`)[0]?.values[0]?.[0]).toBe(
      'room-budget'
    );

    db.close();
    reopened.close();
  });

  it('every remaining mutating helper marks dirty (edit / delete / react)', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    saveRoom(db, makeRoom('room-1'));
    const msg = makeMessage('msg-edit', 'room-1');
    insertMessage(db, msg);
    persistDatabase(db, dataDir);

    updateMessageContent(db, { ...msg, content: 'edited', updatedAt: Date.now() });
    expect(isDatabaseDirty()).toBe(true);
    persistDatabase(db, dataDir);

    updateMessageReactions(db, 'msg-edit', { '👍': ['human'] });
    expect(isDatabaseDirty()).toBe(true);
    persistDatabase(db, dataDir);

    softDeleteMessage(db, 'msg-edit', Date.now());
    expect(isDatabaseDirty()).toBe(true);

    db.close();
  });

  it('an immediate persistDatabase (the human chat.send path) clears the flag, so the tick does not write again', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    saveRoom(db, makeRoom('room-1'));

    // chat.send: insertMessage + an immediate synchronous persistDatabase.
    insertMessage(db, makeMessage('msg-human', 'room-1'));
    persistDatabase(db, dataDir);
    expect(isDatabaseDirty()).toBe(false);

    // The 5 s tick that follows must find nothing to do.
    expect(flushDatabaseIfDirty(db, dataDir)).toBe(false);

    db.close();
  });
});
