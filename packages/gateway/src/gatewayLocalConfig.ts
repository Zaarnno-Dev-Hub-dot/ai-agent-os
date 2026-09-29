/**
 * Gateway-local config: knobs that are NOT part of the shared GatewayConfig.
 * Both live here because both are gateway-only defaults with an env override
 * and no per-room client event yet.
 */

/**
 * Single-turn token guard. A breach does not pause the room — it fails just that
 * turn's onward relay fan-out with a visible error event. 0 disables the
 * check entirely.
 */
export const DEFAULT_MAX_TOKENS_PER_TURN = 150_000;

export function maxTokensPerTurn(): number {
  const raw = process.env.AGENT_OS_MAX_TOKENS_PER_TURN;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_TOKENS_PER_TURN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_TOKENS_PER_TURN;
}

/**
 * Relay history window: last N non-deleted
 * room messages re-fed to agents without native session persistence. Older
 * history is dropped from the RELAY prompt only — the UI always shows full
 * history.
 */
export const DEFAULT_RELAY_WINDOW_MAX_MESSAGES = 30;

export function relayWindowMaxMessages(): number {
  const raw = process.env.AGENT_OS_RELAY_WINDOW;
  if (raw == null || raw.trim() === '') return DEFAULT_RELAY_WINDOW_MAX_MESSAGES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RELAY_WINDOW_MAX_MESSAGES;
}

/**
 * Per-seat override for the single-turn token guard above. maxTokensPerTurn()
 * is process-global (one cap for every seat) — this map lets ONE seat be
 * tightened without touching every other seat's cap, which a global env-var
 * change would do. Introduced for the Fable-5 advisor seat (the operator
 * 2026-07-11, the advisor-seat safeguards safeguards): 6,000 tokens/turn,
 * far tighter than the 150k global default. Keyed by seat id
 * (manifestId#instanceId, e.g. 'claude-code#advisor' — same id agent.status
 * events and RelayDeps.agentId use, NOT the bare manifestId).
 *
 * AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN (JSON object, e.g.
 * '{"claude-code#advisor":6000}') overrides/extends this map per machine
 * without a code change, same pattern as the other env overrides in this
 * file. Malformed JSON or a missing key silently falls through to the
 * built-in default, then to the process-global cap — never throws.
 */
const DEFAULT_PER_SEAT_MAX_TOKENS_PER_TURN: Readonly<Record<string, number>> = {
};

export function maxTokensPerTurnForSeat(seatId: string): number {
  const raw = process.env.AGENT_OS_PER_SEAT_MAX_TOKENS_PER_TURN;
  if (raw != null && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = parsed[seatId];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    } catch {
      /* malformed override JSON — fall through to built-in default/global cap */
    }
  }
  const builtIn = DEFAULT_PER_SEAT_MAX_TOKENS_PER_TURN[seatId];
  return builtIn != null ? builtIn : maxTokensPerTurn();
}
