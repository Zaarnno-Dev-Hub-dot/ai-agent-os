/**
 * Gateway-local index DDL (review 2026-08-04 §4.5 / §3.4). `messages` shipped
 * with only its implicit PK index, so every read filtering on room_id was a
 * full table scan (measured 2,331 ms at 150k rows).
 *
 * These pin the three things that make the DDL pass safe to call on every
 * boot: it creates the index, it is idempotent, and it never throws — a
 * missing performance index must not stop the gateway from starting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyMessageIndexes, insertMessage, openDatabase, saveRoom, type SqlDatabase } from './db.js';
import type { Message, Room } from '@agent-os/shared';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'db-index-test-'));
}

function indexNames(db: SqlDatabase): string[] {
  const res = db.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'`);
  return (res[0]?.values ?? []).map((row) => String(row[0]));
}

describe('applyMessageIndexes (review 2026-08-04 §4.5)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates idx_messages_room_created on messages', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);

    expect(indexNames(db)).not.toContain('idx_messages_room_created');
    applyMessageIndexes(db);
    expect(indexNames(db)).toContain('idx_messages_room_created');

    db.close();
  });

  it('indexes (room_id, created_at) — the composite the room read actually needs', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    applyMessageIndexes(db);

    const sql = String(
      db.exec(`SELECT sql FROM sqlite_master WHERE name = 'idx_messages_room_created'`)[0].values[0][0]
    );
    expect(sql).toMatch(/room_id/);
    expect(sql).toMatch(/created_at/);
    // room_id must lead: it is the filtered column, created_at only the sort.
    expect(sql.indexOf('room_id')).toBeLessThan(sql.indexOf('created_at'));

    db.close();
  });

  it('is idempotent — safe to run on every boot', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);

    applyMessageIndexes(db);
    expect(() => applyMessageIndexes(db)).not.toThrow();
    applyMessageIndexes(db);

    expect(indexNames(db).filter((n) => n === 'idx_messages_room_created')).toHaveLength(1);

    db.close();
  });

  it('never throws, even against a database with no messages table', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    db.run('DROP TABLE messages');

    // A missing index degrades reads; it must never stop the gateway booting.
    expect(() => applyMessageIndexes(db)).not.toThrow();

    db.close();
  });

  it('the indexed read still returns the same rows, in the same order', async () => {
    dataDir = freshDataDir();
    const db: SqlDatabase = await openDatabase(dataDir);
    applyMessageIndexes(db);

    const room: Room = {
      id: 'room-1',
      name: 'room 1',
      type: 'group',
      memberIds: [],
      createdAt: 1,
      updatedAt: 1,
      turnCap: 12,
    };
    saveRoom(db, room);

    const mk = (id: string, roomId: string, createdAt: number): Message => ({
      id,
      roomId,
      senderId: 'human',
      content: id,
      createdAt,
    });
    // Inserted out of order, and with a second room to prove the filter works.
    insertMessage(db, mk('c', 'room-1', 30));
    insertMessage(db, mk('a', 'room-1', 10));
    insertMessage(db, mk('other', 'room-2', 20));
    insertMessage(db, mk('b', 'room-1', 20));

    const res = db.exec(
      `SELECT id FROM messages WHERE room_id = 'room-1' AND deleted_at IS NULL ORDER BY created_at ASC`
    );
    expect((res[0]?.values ?? []).map((r) => String(r[0]))).toEqual(['a', 'b', 'c']);

    db.close();
  });
});
