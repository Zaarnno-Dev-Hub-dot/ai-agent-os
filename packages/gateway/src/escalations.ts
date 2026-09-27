/**
 * Urgent SMS escalation (Wave 6, docs/DESIGN-urgent-sms-escalation.md).
 * Pure gateway-local state plus policy functions — rate limit, quiet hours,
 * secret guard — kept free of Fastify/relay so every branch is unit-testable
 * without a running gateway (same split as polls.ts: this module owns state
 * + decisions, escalateRoutes.ts owns the HTTP route + bridge-wake wiring).
 *
 * Persistence: `data/escalations.json` (gateway-local, load-at-boot/save-on-
 * mutation — same shape-of-problem, same load/save idiom, as polls.ts's
 * `data/polls.json`). A flat, ever-growing array — escalations are rare and
 * deliberate by design (rate-limited to 3/day), so no pruning is needed for
 * a very long time; add one if this ever becomes a real concern.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export type EscalationSeverity = 'high' | 'critical';

/** What actually happened on the SMS side for one escalation — never a claim stronger than what the gateway itself observed (BUILDER_PROTOCOL "no painted status"). */
export type SmsOutcome =
  | 'sent' // hermes replied within the wake timeout (its OWN reply, not a parsed confirmation that a phone actually received a text)
  | 'failed' // hermes wasn't VERIFIED, or didn't reply within the timeout
  | 'skipped-quiet-hours' // high severity during quiet hours — queued to the room only, no wake attempted
  | 'pending'; // reserveEscalation has consumed this record's rate-limit slot but finalizeEscalationOutcome hasn't run yet (the caller is still mid bridge-wake-await, or a quiet-hours/not-verified decision). Never the value an HTTP response reports — escalateRoutes.ts always finalizes before replying. Should only ever be visible on disk mid-flight, or (rare) if the gateway crashed between reserve and finalize — see escalations.ts's reserveEscalation/finalizeEscalationOutcome doc comments.

export interface EscalationRecord {
  id: string;
  ts: number;
  severity: EscalationSeverity;
  title: string;
  /** Truncated, not the full body forever — this file is a rate-limit ledger first, a convenience log second; the room IS the authoritative audit log (design doc). */
  bodyPreview: string;
  smsOutcome: SmsOutcome;
}

export interface EscalationsState {
  escalations: EscalationRecord[];
}

function escalationsFilePath(dataDir: string): string {
  return join(dataDir, 'escalations.json');
}

function isSmsOutcome(v: unknown): v is SmsOutcome {
  return v === 'sent' || v === 'failed' || v === 'skipped-quiet-hours' || v === 'pending';
}

/** Defensive shape validation so a hand-edited or truncated file degrades to empty state, never a crash — same idiom as polls.ts's isPoll. */
function isEscalationRecord(v: unknown): v is EscalationRecord {
  if (typeof v !== 'object' || v == null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.ts === 'number' &&
    (r.severity === 'high' || r.severity === 'critical') &&
    typeof r.title === 'string' &&
    typeof r.bodyPreview === 'string' &&
    isSmsOutcome(r.smsOutcome)
  );
}

/** Load `data/escalations.json`. Absent file (not yet created) or a corrupt one both fall back to the empty default — same try/catch-return-default idiom as loadPolls. */
export function loadEscalations(dataDir: string): EscalationsState {
  const path = escalationsFilePath(dataDir);
  if (!existsSync(path)) return { escalations: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { escalations?: unknown };
    const escalations = Array.isArray(parsed.escalations) ? parsed.escalations.filter(isEscalationRecord) : [];
    return { escalations };
  } catch {
    return { escalations: [] };
  }
}

/** Persist the full state. Create-on-first-write, same as polls.json — not boot-created. */
export function saveEscalations(dataDir: string, state: EscalationsState): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(escalationsFilePath(dataDir), JSON.stringify(state, null, 2), 'utf8');
}

// ============================================================================
// Rate limit: 3/day + 30-minute cooldown (design doc "Policy"). `critical`
// bypasses the cooldown, never the daily cap — both severities count toward
// and are limited by the same cap.
// ============================================================================

export const DAILY_CAP = 3;
export const COOLDOWN_MS = 30 * 60 * 1000;

export type RateLimitResult = { allowed: true } | { allowed: false; reason: string; retryAfterMs: number };

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** Milliseconds from `now` until the next local midnight — used as the daily cap's Retry-After. */
function msUntilNextLocalMidnight(now: number): number {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now;
}

function mostRecent(records: EscalationRecord[]): EscalationRecord | undefined {
  let latest: EscalationRecord | undefined;
  for (const r of records) {
    if (!latest || r.ts > latest.ts) latest = r;
  }
  return latest;
}

/**
 * `records` is the FULL persisted history (any severity, any outcome) —
 * both the daily cap and the cooldown are evaluated against every escalation
 * regardless of severity/outcome, including quiet-hours-suppressed ones:
 * the resource being protected is "how many times does someone escalate
 * today", not narrowly "how many SMS actually went out".
 */
export function checkRateLimit(records: EscalationRecord[], now: number, severity: EscalationSeverity): RateLimitResult {
  const todaysCount = records.filter((r) => isSameLocalDay(r.ts, now)).length;
  if (todaysCount >= DAILY_CAP) {
    return {
      allowed: false,
      reason: `daily cap of ${DAILY_CAP} escalations reached (resets at local midnight)`,
      retryAfterMs: msUntilNextLocalMidnight(now),
    };
  }
  if (severity !== 'critical') {
    const last = mostRecent(records);
    if (last) {
      const elapsed = now - last.ts;
      if (elapsed < COOLDOWN_MS) {
        return {
          allowed: false,
          reason: '30-minute cooldown active since the last escalation (severity critical bypasses this, not the daily cap)',
          retryAfterMs: COOLDOWN_MS - elapsed,
        };
      }
    }
  }
  return { allowed: true };
}

// ============================================================================
// Concurrency (fix-round finding, docs/DESIGN-urgent-sms-escalation.md): this
// is a single-instance gateway (no multi-process/multi-machine deployment),
// so an in-memory, promise-chained mutex is enough to make the daily
// cap/cooldown actually hold, and the persisted file lossless, under
// concurrent POST /api/escalate calls.
//
// The bug this closes: escalateRoutes.ts used to loadEscalations() +
// checkRateLimit() BEFORE `await`-ing the (up to ESCALATE_WAKE_TIMEOUT_MS =
// 120s) bridge-wake, then saveEscalations() with `[...preAwaitState,
// newRecord]` AFTER that await resolved. Under N concurrent calls, every one
// of them could load the SAME pre-wake state before any of them had saved,
// so every one passed the rate-limit check (cap bypassed), and whichever
// call's save ran last won, silently discarding every other call's record
// (lost update) — empirically reproduced at 5/5 concurrent 'critical' calls
// all returning 200 with only 1 of 5 records persisted, cap of 3 notwith-
// standing.
//
// The fix: reserveEscalation() runs the load+check+append+save sequence
// BEFORE the caller's bridge-wake await, and finalizeEscalationOutcome()
// re-reads + replaces-in-place AFTER it resolves — both funneled through
// withEscalationsLock so concurrent callers' reserve/finalize steps queue
// and run one at a time (each always seeing whatever the previous one just
// persisted), while the slow bridge-wake await itself happens OUTSIDE the
// lock so unrelated concurrent escalations don't serialize behind each
// other's up-to-120s wait — only the two short, synchronous read-modify-
// write steps do.
// ============================================================================

let escalationsLock: Promise<void> = Promise.resolve();

/**
 * Runs `fn` once every previously-queued call has settled (resolved OR
 * thrown), one at a time, in the order `withEscalationsLock` was called —
 * the standard promise-chained mutex pattern. A throwing/rejecting `fn`
 * still propagates to ITS OWN caller (via the returned promise) but never
 * wedges the queue for later callers, since the queue's own tail always
 * resolves to undefined regardless of how `fn` settled.
 *
 * Exported so escalations.test.ts can exercise the ordering/no-wedge
 * guarantee directly; reserveEscalation/finalizeEscalationOutcome below are
 * the only production callers.
 */
export function withEscalationsLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = escalationsLock.then(fn);
  escalationsLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * The ONLY sanctioned way to decide "does this escalation get to happen" —
 * atomically (see withEscalationsLock): re-reads the CURRENT persisted
 * state, runs checkRateLimit against it, and — only if allowed — appends
 * `record` (consuming its slot in the cap/cooldown) and persists, all before
 * returning. Callers must invoke this BEFORE any long-running await (the
 * bridge-wake), passing a record whose smsOutcome is a placeholder (callers
 * use 'pending') to be corrected by finalizeEscalationOutcome once the real
 * outcome is known.
 */
export function reserveEscalation(
  dataDir: string,
  now: number,
  severity: EscalationSeverity,
  record: EscalationRecord
): Promise<RateLimitResult> {
  return withEscalationsLock(() => {
    const state = loadEscalations(dataDir);
    const rateLimit = checkRateLimit(state.escalations, now, severity);
    if (!rateLimit.allowed) return rateLimit;
    saveEscalations(dataDir, { escalations: [...state.escalations, record] });
    return rateLimit;
  });
}

/**
 * Replaces the `smsOutcome` of the record `id` (from a prior
 * reserveEscalation call) in place — atomically (see withEscalationsLock):
 * re-reads the CURRENT persisted state first, never a snapshot from before
 * the caller's bridge-wake await. A no-op save if `id` is no longer present
 * (not expected in practice — nothing else ever removes records); doesn't
 * throw either way, so a caller can always call this unconditionally once
 * the real outcome is known.
 *
 * Known accepted gap (documented, not fixed here — out of this fix round's
 * scope per the no-gold-plating rule): if the gateway process crashes
 * between reserveEscalation and finalizeEscalationOutcome, that one record
 * is stuck at 'pending' forever — there is no boot-time sweep to reconcile
 * it. It still correctly counted against that day's cap when it was
 * reserved, so the policy the cap protects is not violated; only that one
 * record's audit trail is incomplete.
 */
export function finalizeEscalationOutcome(dataDir: string, id: string, smsOutcome: SmsOutcome): Promise<void> {
  return withEscalationsLock(() => {
    const state = loadEscalations(dataDir);
    const escalations = state.escalations.map((r) => (r.id === id ? { ...r, smsOutcome } : r));
    saveEscalations(dataDir, { escalations });
  });
}

// ============================================================================
// Quiet hours: 00:00-08:00 local by default (design doc), env-overridable.
// ============================================================================

export interface QuietHoursOptions {
  /** Inclusive start hour, 0-23. Default 0 (midnight). */
  startHour?: number;
  /** Exclusive end hour, 0-23. Default 8. */
  endHour?: number;
}

/**
 * `now`'s hour is read in the SERVER's local time zone (`Date#getHours`) —
 * matching the design doc's "00:00-08:00 local" framing literally (the
 * gateway is a single-machine, single-timezone deployment; no per-user TZ
 * concept exists anywhere else in this codebase either).
 * startHour === endHour disables the window entirely (never quiet) rather
 * than treating it as "always quiet" — a safer default for a misconfigured
 * override than silently blocking every high-severity SMS.
 */
export function isQuietHours(now: Date, opts: QuietHoursOptions = {}): boolean {
  const startHour = opts.startHour ?? 0;
  const endHour = opts.endHour ?? 8;
  if (startHour === endHour) return false;
  const hour = now.getHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wraps midnight (e.g. a 22-6 window) -- not the default, but handled for
  // whoever sets an override shaped that way.
  return hour >= startHour || hour < endHour;
}

function parseHourEnv(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : undefined;
}

/** Reads AGENT_OS_ESCALATE_QUIET_START_HOUR / _END_HOUR; an absent or out-of-range value falls back to isQuietHours' own default for that side. */
export function quietHoursOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): QuietHoursOptions {
  return {
    startHour: parseHourEnv(env.AGENT_OS_ESCALATE_QUIET_START_HOUR),
    endHour: parseHourEnv(env.AGENT_OS_ESCALATE_QUIET_END_HOUR),
  };
}

// ============================================================================
// Secret guard: the escalation body/title must never carry secrets, keys, or
// file contents (design doc "Policy") — title+pointer only. Regex guard for
// OBVIOUS key shapes; not a general-purpose secret scanner (that's a much
// bigger, separately-scoped problem) — this blocks the clear, cheap cases an
// SMS trigger realistically needs to worry about.
// ============================================================================

export type SecretGuardResult = { ok: true } | { ok: false; reason: string };

const SECRET_PATTERNS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  { reason: 'looks like an AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: 'looks like an sk-/pk- style API key (OpenAI/Anthropic/Stripe-shaped)', pattern: /\b[sp]k-[A-Za-z0-9_-]{16,}\b/i },
  { reason: 'looks like a Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  {
    reason: 'looks like an inline secret/password/token/key assignment',
    pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*\S{4,}/i,
  },
];

/**
 * Never include the matched substring in the returned reason — only which
 * PATTERN CLASS tripped. Echoing the match back would defeat the guard's
 * entire purpose (e.g. in an error response that itself gets logged/SMS'd).
 */
export function secretGuard(text: string): SecretGuardResult {
  for (const { reason, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason };
  }
  return { ok: true };
}
