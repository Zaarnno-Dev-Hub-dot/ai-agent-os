/**
 * Ephemeral presence registry — "who's on duty right now" lane for
 * short-lived TEMP workers (Agents\temp\run-queue.mjs, ~6 processes per
 * scheduled run, each living ~10-20 seconds).
 *
 * WHY THIS IS A SEPARATE FILE, NOT A REUSE OF agents.ts's `agents` Map:
 * 1. connectAgent()'s proof-of-life ladder (agents.ts's createVerifier)
 *    hard-codes challengeTimeoutMs: 120_000 — a 15s-lived temp would never
 *    reach VERIFIED, it would just show CONNECTING/CHALLENGED for its whole
 *    life and then vanish mid-challenge.
 * 2. disconnectAgent() never deletes a Map entry — it only flips status to
 *    OFFLINE (see agents.ts's doc comment on disconnectAgent, "Without an
 *    explicit disconnect an abandoned seat stays VERIFIED forever" /
 *    "OFFLINE seat simply receives no traffic"). That is the RIGHT
 *    contract for a seat (rooms may still reference it, a human wants to
 *    see its last-known status) and the WRONG one for a temp: a few daily
 *    runs would leave dozens of permanent dead rows, which is the exact
 *    opposite of "who is on duty at a given moment."
 *
 * So this is a parallel, TTL-based, self-expiring registry that never reads
 * or writes the `agents` Map, never touches AgentStatus, and is not part of
 * the adapter/seat lifecycle at all. It is intentionally dumb: no proof of
 * life, no challenge, no persistence across a gateway restart — a temp
 * either announces itself over HTTP while it's alive, or it doesn't show up.
 *
 * Clock is injectable (constructor param) so tests never need to sleep for
 * a TTL to elapse.
 */

export type EphemeralKind = 'temp';

export interface EphemeralMeta {
  role?: string;
  jobSlug?: string;
  tempId?: string;
  [key: string]: string | undefined;
}

export interface EphemeralPresence {
  id: string;
  label: string;
  kind: EphemeralKind;
  startedAt: number;
  expiresAt: number;
  meta?: EphemeralMeta;
}

/** Caller-supplied fields for announce() — startedAt/expiresAt are computed, not accepted from the wire. */
export interface EphemeralAnnounceInput {
  id: string;
  label: string;
  kind: EphemeralKind;
  meta?: EphemeralMeta;
}

/** Clamp so a bad/malicious caller can never pin a ghost entry forever. */
export const MAX_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Floor so a zero/negative ttlMs doesn't produce an already-expired-on-arrival entry that still causes a broadcast. */
export const MIN_TTL_MS = 1_000;

function clampTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return MIN_TTL_MS;
  return Math.min(Math.max(ttlMs, MIN_TTL_MS), MAX_TTL_MS);
}

export class EphemeralPresenceRegistry {
  private readonly entries = new Map<string, EphemeralPresence>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Upsert `entry` with `expiresAt = now + clamp(ttlMs)`. Always returns the stored record (with the clamped expiry). */
  announce(entry: EphemeralAnnounceInput, ttlMs: number): EphemeralPresence {
    const startedAt = this.entries.get(entry.id)?.startedAt ?? this.now();
    const stored: EphemeralPresence = {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      meta: entry.meta,
      startedAt,
      expiresAt: this.now() + clampTtlMs(ttlMs),
    };
    this.entries.set(entry.id, stored);
    return stored;
  }

  /** Remove immediately. Returns true iff something was actually removed. */
  clear(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Drop expired entries. Returns true iff the set actually changed (the broadcast-storm guard — callers must not broadcast on a no-op sweep). */
  sweep(): boolean {
    const nowMs = this.now();
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Current non-expired entries. Does NOT itself sweep — call sweep() first if you need a guaranteed-fresh snapshot; list() is cheap/read-only so state.sync callers can filter defensively without mutating registry state mid-broadcast-build. */
  list(): EphemeralPresence[] {
    const nowMs = this.now();
    return Array.from(this.entries.values()).filter((e) => e.expiresAt > nowMs);
  }

  /** Test/diagnostic helper — total entries including any not-yet-swept-expired ones. */
  size(): number {
    return this.entries.size;
  }
}
