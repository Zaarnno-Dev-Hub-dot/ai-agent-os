/**
 * SQLite persistence via sql.js — local WASM only, full schema, boot hydration.
 */

import initSqlJs from 'sql.js';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { CostReport, DB_SCHEMA, Message, Room } from '@agent-os/shared';

export type SqlDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

const require = createRequire(import.meta.url);
const sqlJsEntry = require.resolve('sql.js');
/** WASM lives beside sql-wasm.js (package main is ./dist/sql-wasm.js). */
const wasmDir = dirname(sqlJsEntry);

export async function openDatabase(dataDir: string): Promise<SqlDatabase> {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const SQL = await initSqlJs({
    locateFile: (file) => join(wasmDir, file),
  });

  const dbPath = join(dataDir, 'gateway.db');
  if (existsSync(dbPath)) {
    // A zero-byte gateway.db is never a legitimate state: a real database is
    // at least one 4 KiB page, and a first-ever boot has no file at all. It
    // means a previous persist was interrupted mid-write (INC 2026-07-21: the
    // gateway was killed at 14:17:25 while writeFileSync had already truncated
    // the file to 0; `new SQL.Database(<0 bytes>)` then succeeds SILENTLY as an
    // empty database, applySchema recreates every table, and the gateway boots
    // into a blank world — 906 rooms, every message and the entire Approvals
    // room were lost without one error line, unnoticed for 12 days). Refuse to
    // start instead: a dead gateway is loud, a silently empty one is not.
    if (statSync(dbPath).size === 0) {
      throw new Error(
        `[db] refusing to boot: ${dbPath} is 0 bytes — a persist was interrupted mid-write and the ` +
          `database is gone, not empty. Restore data/gateway.db from backup, or delete the 0-byte ` +
          `file to deliberately start a fresh world (this destroys all room + message history).`
      );
    }
    const buf = readFileSync(dbPath);
    const db = new SQL.Database(buf);
    applySchema(db);
    return db;
  }

  const db = new SQL.Database();
  applySchema(db);
  return db;
}

/**
 * Split DDL on ';' while keeping CREATE TRIGGER ... BEGIN ... END; bodies
 * intact — a naive split severs trigger bodies at their internal semicolons,
 * producing invalid fragments. Matches the uppercase BEGIN/END keywords the
 * schema uses, so lowercase prose in -- comments cannot unbalance the count.
 */
function splitSchemaStatements(schema: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  for (const fragment of schema.split(';')) {
    buffer += (buffer ? ';' : '') + fragment;
    const opens = (buffer.match(/\bBEGIN\b/g) ?? []).length;
    const closes = (buffer.match(/\bEND\b/g) ?? []).length;
    if (opens > closes) continue;
    if (buffer.trim()) statements.push(buffer);
    buffer = '';
  }
  if (buffer.trim()) statements.push(buffer);
  return statements;
}

// DDL errors used to be swallowed completely (bare `catch {}`), which masked
// a real fts5-availability failure for days. The swallow
// stays — most "failures" here are expected, idempotent re-application of
// already-applied DDL on every boot (CREATE TABLE IF NOT EXISTS races,
// column-already-exists, etc.) and must not become log spam — but the first
// time (this boot) a given statement INDEX fails, it's logged once (index +
// message) so a genuine schema problem (e.g. a missing fts5 build) is visible
// instead of silent. `loggedIndices` is module-level and reset by process
// restart, matching "log once at first boot" rather than once ever.
const ddlFailuresLoggedThisBoot = new Set<number>();

function applySchema(db: SqlDatabase) {
  splitSchemaStatements(DB_SCHEMA).forEach((stmt, index) => {
    try {
      db.run(stmt);
    } catch (e) {
      // A migration like `ALTER TABLE ... ADD COLUMN x` always reports "duplicate column name" on a database that
      // already has the column (every fresh database, since CREATE TABLE includes it). That is the expected outcome,
      // not a problem worth logging.
      const message = e instanceof Error ? e.message : String(e);
      const sql = stmt.replace(/^(?:\s*--[^\n]*\n)+/, '');
      if (/^\s*ALTER\s+TABLE\b[^;]*\bADD\s+COLUMN\b/i.test(sql) && /duplicate column name/i.test(message)) return;
      if (!ddlFailuresLoggedThisBoot.has(index)) {
        ddlFailuresLoggedThisBoot.add(index);
        console.error(
          `[db] schema statement ${index} failed (idempotent swallow — may be expected on a warm boot):`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  });
  ensureFtsIndex(db);
}

/**
 * Gateway-local index DDL (review 2026-08-04 §4.5 / §3.4).
 *
 * ROOT CAUSE: `messages` carries only its implicit PK index — the schema's
 * only explicit CREATE INDEX statements are for cost_events (shared
 * types.ts). Every read that filters on room_id (loadMessagesForRoom) is
 * therefore a full table scan: measured 2,331 ms at 150k rows. Today that is
 * masked because loadAllMessages preloads the entire history into a Map at
 * boot and pagination is served from RAM — which is itself the problem, since
 * the in-memory Map *is* the index and so memory grows with total history
 * forever.
 *
 * (room_id, created_at) rather than (room_id) alone because every query that
 * filters on room_id also orders by created_at (loadMessagesForRoom's ORDER
 * BY), so the composite serves the sort from the index too.
 *
 * Applied as a SEPARATE gateway-local pass rather than added to DB_SCHEMA
 * because packages/shared is frozen — exactly the mechanism
 * applyPollReviewsSchema (pollReviewsDb.ts, called from index.ts) already
 * established for the poll_reviews tables. IF NOT EXISTS makes it idempotent
 * on every boot; failures are logged, not thrown, because a missing
 * performance index must never stop the gateway from starting.
 */
export function applyMessageIndexes(db: SqlDatabase): void {
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at)');
  } catch (e) {
    console.error(
      '[db] could not create idx_messages_room_created (gateway still starts; reads stay full-scan):',
      e instanceof Error ? e.message : String(e)
    );
  }
}

function countRows(db: SqlDatabase, table: string): number {
  const res = db.exec(`SELECT COUNT(*) FROM ${table}`);
  return Number(res[0]?.values[0]?.[0] ?? 0);
}

/**
 * Rebuild the external-content FTS index when it disagrees with messages —
 * covers rows written while the triggers were missing (pre-fix databases).
 * Counting messages_fts itself is useless here: external-content FTS4 proxies
 * bare scans to the content table, so it always matches. The _docsize shadow
 * table reflects what is actually indexed.
 */
function ensureFtsIndex(db: SqlDatabase) {
  try {
    if (countRows(db, 'messages') !== countRows(db, 'messages_fts_docsize')) {
      db.run(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
    }
  } catch {
    // FTS module unavailable in this build — search degrades to empty results
  }
}

// A missing dataDir at persist time means the store was torn out from under a
// still-in-flight async commit — a test's temp-dir teardown racing a relay
// worker's fire-and-forget commit, or an operator deleting the data dir at
// runtime. Recreating the directory here would resurrect what its owner just
// deliberately removed (and leak temp dirs in tests), so the write is skipped
// instead — loudly, once per dir, because outside tests every skipped persist
// is state that will not survive the next restart.
const missingDataDirsWarned = new Set<string>();

/**
 * Write batching (review 2026-08-04 §4.1 / RISK 1) — the dirty flag half of
 * the same treatment `createBatchedRunner` (roomPersistBatch.ts) already gives
 * room mutations, applied to the DB write itself.
 *
 * ROOT CAUSE (measured, not guessed): storage is sql.js, so `persistDatabase`
 * has no incremental path — it serializes the ENTIRE database (`db.export()`)
 * and writes the WHOLE file, synchronously, on the event loop, on every call.
 * A single agent turn called it THREE times (relay.ts:289 after insertMessage,
 * :354 after insertCostEvent, :381 after applyRoomTokenUsage) and a bare 5 s
 * interval called it a fourth time whether or not anything had changed. At
 * today's 3 MB that is ~6 ms a call and invisible; the measured curve is
 * 80 ms at 39.5 MB and 262 ms at 101 MB, i.e. ~786 ms of blocked event loop
 * per agent reply and a 5% standing duty cycle rewriting an unchanged file.
 *
 * FIX: every mutating helper in this module marks the in-memory database
 * dirty; the 5 s interval calls `flushDatabaseIfDirty` and writes only when
 * something actually changed. Durability-critical paths (anything a human
 * typed) keep calling `persistDatabase` directly for an immediate synchronous
 * write, so batching never costs a human's own message.
 *
 * The flag is deliberately module-level rather than per-database: this process
 * owns exactly one gateway.db (index.ts:159-167 — two processes on one data
 * dir corrupt it), and tests that open several throwaway databases only ever
 * over-write (a spurious flush of a clean DB), never under-write.
 */
let databaseDirty = false;

/**
 * Mark the in-memory database as having unpersisted changes. Called by every
 * mutating helper below, so callers that only need "this will be on disk
 * within one tick" durability can simply drop their `persistDatabase` call
 * rather than replacing it with anything.
 */
export function markDatabaseDirty(): void {
  databaseDirty = true;
}

/** Test/diagnostic accessor — true when a write is owed. */
export function isDatabaseDirty(): boolean {
  return databaseDirty;
}

/**
 * Persist only if a mutating helper marked the DB dirty since the last
 * successful write. Returns true when a write was actually attempted, so the
 * caller (and tests) can distinguish "flushed" from "nothing to do".
 */
export function flushDatabaseIfDirty(db: SqlDatabase, dataDir: string): boolean {
  if (!databaseDirty) return false;
  persistDatabase(db, dataDir);
  return true;
}

export function persistDatabase(db: SqlDatabase, dataDir: string) {
  if (!existsSync(dataDir)) {
    if (!missingDataDirsWarned.has(dataDir)) {
      missingDataDirsWarned.add(dataDir);
      console.error(`[db] persist skipped — data dir no longer exists: ${dataDir}`);
    }
    return;
  }
  const dbPath = join(dataDir, 'gateway.db');
  const data = db.export();
  // Atomic replace, not an in-place rewrite. writeFileSync opens with 'w',
  // which truncates gateway.db to 0 bytes BEFORE the ~3 MB export is written;
  // this fires on nearly every mutation plus a 5 s interval, so the truncated
  // window is always open. A kill inside it (Argus taskkill friendly-fire,
  // Modern Standby, Ctrl-C) leaves a 0-byte file and the entire world is gone
  // — that is exactly what happened on 2026-07-21 14:17:25. Writing a sibling
  // temp file first and rename()ing it over the target moves the failure mode
  // to "the temp file is junk and the real DB is untouched": on Windows,
  // rename() is MoveFileEx(MOVEFILE_REPLACE_EXISTING), a single metadata op.
  const tmpPath = `${dbPath}.tmp`;
  writeFileSync(tmpPath, Buffer.from(data));
  try {
    renameSync(tmpPath, dbPath);
    // Clear the dirty flag ONLY here — after the rename actually landed. The
    // skip-and-warn paths above and the catch below both leave it set on
    // purpose, so an owed write is retried on the next tick instead of being
    // silently forgotten because a persist was *attempted*.
    databaseDirty = false;
  } catch (e) {
    // Rename failed (AV/indexer holding a handle, cross-device). Do NOT fall
    // back to a truncating write — leave the last good DB in place and say so.
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    console.error(
      `[db] persist skipped — could not replace ${dbPath} (last good copy left intact):`,
      e instanceof Error ? e.message : String(e)
    );
  }
}

export function loadRooms(db: SqlDatabase): Room[] {
  const stmt = db.prepare('SELECT * FROM rooms ORDER BY created_at ASC');
  const rooms: Room[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    rooms.push({
      id: String(row.id),
      name: String(row.name),
      type: row.type as Room['type'],
      memberIds: JSON.parse(String(row.member_ids)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archivedAt: row.archived_at != null ? Number(row.archived_at) : undefined,
      turnCap: Number(row.turn_cap),
      budgetCap:
        row.budget_tokens != null && row.budget_cost_usd != null
          ? { tokens: Number(row.budget_tokens), costUsd: Number(row.budget_cost_usd) }
          : undefined,
    });
  }
  stmt.free();
  return rooms;
}

export function saveRoom(db: SqlDatabase, room: Room) {
  db.run(
    `INSERT OR REPLACE INTO rooms (id, name, type, member_ids, turn_cap, budget_tokens, budget_cost_usd, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      room.id,
      room.name,
      room.type,
      JSON.stringify(room.memberIds),
      room.turnCap,
      room.budgetCap?.tokens ?? null,
      room.budgetCap?.costUsd ?? null,
      room.archivedAt ?? null,
      room.createdAt,
      room.updatedAt,
    ]
  );
  markDatabaseDirty();
}

export function loadMessagesForRoom(db: SqlDatabase, roomId: string): Message[] {
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
  );
  (stmt as unknown as { bind: (params: unknown[]) => void }).bind([roomId]);
  const messages: Message[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    messages.push(rowToMessage(row));
  }
  stmt.free();
  return messages;
}

export function loadAllMessages(db: SqlDatabase): Map<string, Message[]> {
  const map = new Map<string, Message[]>();
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE deleted_at IS NULL ORDER BY created_at ASC'
  );
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    const msg = rowToMessage(row);
    const list = map.get(msg.roomId) ?? [];
    list.push(msg);
    map.set(msg.roomId, list);
  }
  stmt.free();
  return map;
}

export function insertMessage(db: SqlDatabase, message: Message) {
  db.run(
    `INSERT INTO messages (id, room_id, sender_id, content, attachments, mentions, reply_to, created_at, updated_at, deleted_at, edit_history, reactions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.roomId,
      message.senderId,
      message.content,
      message.attachments ? JSON.stringify(message.attachments) : null,
      message.mentions ? JSON.stringify(message.mentions) : null,
      message.replyTo ?? null,
      message.createdAt,
      message.updatedAt ?? null,
      message.deletedAt ?? null,
      message.editHistory ? JSON.stringify(message.editHistory) : null,
      message.reactions ? JSON.stringify(message.reactions) : null,
    ]
  );
  markDatabaseDirty();
}

export function updateMessageContent(db: SqlDatabase, message: Message) {
  db.run(
    `UPDATE messages SET content = ?, updated_at = ?, edit_history = ? WHERE id = ?`,
    [
      message.content,
      message.updatedAt ?? Date.now(),
      message.editHistory ? JSON.stringify(message.editHistory) : null,
      message.id,
    ]
  );
  markDatabaseDirty();
}

export function softDeleteMessage(db: SqlDatabase, messageId: string, deletedAt: number) {
  db.run(`UPDATE messages SET deleted_at = ? WHERE id = ?`, [deletedAt, messageId]);
  markDatabaseDirty();
}

export function updateMessageReactions(db: SqlDatabase, messageId: string, reactions: Message['reactions']) {
  db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [
    reactions ? JSON.stringify(reactions) : null,
    messageId,
  ]);
  markDatabaseDirty();
}

export function insertCostEvent(
  db: SqlDatabase,
  event: {
    agentId: string;
    roomId?: string;
    modelTier: string;
    tokensIn: number;
    tokensOut: number;
    estimatedCostUsd: number;
    timestamp: number;
    taskId?: string;
    outcome: string;
  }
) {
  db.run(
    `INSERT INTO cost_events (agent_id, room_id, model_tier, tokens_in, tokens_out, estimated_cost_usd, timestamp, task_id, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.agentId,
      event.roomId ?? null,
      event.modelTier,
      event.tokensIn,
      event.tokensOut,
      event.estimatedCostUsd,
      event.timestamp,
      event.taskId ?? null,
      event.outcome,
    ]
  );
  markDatabaseDirty();
}

/**
 * Boot rehydration: room token tallies,
 * room.costTracker, and per-agent global cost all live only in memory
 * (RoomRelayState, Room.costTracker, GatewayState.globalCost) — none of them
 * are columns on their own, they're derived from the append-only
 * cost_events log. Recompute both groupings with two SUM/GROUP BY passes so
 * budgets and cost meters survive a gateway restart instead of resetting to
 * zero. Call once at boot, before any live cost.event can race it.
 */
export interface RehydratedCostTotals {
  /** Keyed by room_id (rows with a null room_id are skipped — nothing to attribute them to). */
  byRoom: Map<string, CostReport>;
  /** Keyed by agent_id, for GatewayState.globalCost.byAgent. */
  byAgent: Map<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
  /** Global totals across every cost event, for GatewayState.globalCost's top-level fields. */
  global: { tokensIn: number; tokensOut: number; estimatedCostUsd: number };
}

export function recomputeCostTotals(db: SqlDatabase): RehydratedCostTotals {
  const byRoom = new Map<string, CostReport>();
  const byAgent = new Map<string, { tokensIn: number; tokensOut: number; costUsd: number }>();
  const global = { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 };

  // Per-room-per-agent grouping: enough to build both CostReport.byAgent
  // (per room) and the room-level tokensIn/tokensOut/estimatedCostUsd sums
  // in one pass, without a second query for the room totals.
  const stmt = db.prepare(
    `SELECT room_id, agent_id, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(estimated_cost_usd) AS cost_usd
     FROM cost_events
     WHERE room_id IS NOT NULL
     GROUP BY room_id, agent_id`
  );
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    const roomId = String(row.room_id);
    const agentId = String(row.agent_id);
    const tokensIn = Number(row.tokens_in ?? 0);
    const tokensOut = Number(row.tokens_out ?? 0);
    const costUsd = Number(row.cost_usd ?? 0);

    const report = byRoom.get(roomId) ?? { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0, byAgent: {} };
    report.tokensIn += tokensIn;
    report.tokensOut += tokensOut;
    report.estimatedCostUsd += costUsd;
    report.byAgent[agentId] = { tokensIn, tokensOut, costUsd };
    byRoom.set(roomId, report);
  }
  stmt.free();

  // Global per-agent totals (across all rooms, including room_id IS NULL
  // events) for GatewayState.globalCost.byAgent.
  const agentStmt = db.prepare(
    `SELECT agent_id, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(estimated_cost_usd) AS cost_usd
     FROM cost_events
     GROUP BY agent_id`
  );
  while (agentStmt.step()) {
    const row = agentStmt.getAsObject() as Record<string, unknown>;
    const agentId = String(row.agent_id);
    const tokensIn = Number(row.tokens_in ?? 0);
    const tokensOut = Number(row.tokens_out ?? 0);
    const costUsd = Number(row.cost_usd ?? 0);
    byAgent.set(agentId, { tokensIn, tokensOut, costUsd });
    global.tokensIn += tokensIn;
    global.tokensOut += tokensOut;
    global.estimatedCostUsd += costUsd;
  }
  agentStmt.free();

  return { byRoom, byAgent, global };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    senderId: String(row.sender_id),
    content: String(row.content),
    attachments: row.attachments ? JSON.parse(String(row.attachments)) : undefined,
    mentions: row.mentions ? JSON.parse(String(row.mentions)) : undefined,
    replyTo: row.reply_to ? String(row.reply_to) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
    deletedAt: row.deleted_at ? Number(row.deleted_at) : undefined,
    editHistory: row.edit_history ? JSON.parse(String(row.edit_history)) : undefined,
    reactions: row.reactions ? JSON.parse(String(row.reactions)) : undefined,
  };
}