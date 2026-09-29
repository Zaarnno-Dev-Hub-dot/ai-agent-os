/**
 * humanToken — the "only the operator decides" mechanism ("invariant-already-false
 * (loopback WS decide)"). Today any local non-browser WS client passes the
 * Origin gate (index.ts's ALLOWED_ORIGINS check only rejects a SPOOFED
 * browser origin — no Origin header at all is treated as "not a drive-by
 * vector" and passes through) and can call poll.decide. This module is the
 * fix: a boot-random token, minted once per gateway process, that
 * poll.decide / agent.disconnect / the review_policy toggle route all
 * require a caller to present.
 *
 * Delivery is index.ts's job (injected into the served index.html only —
 * see servedIndexHtml() there); this module only mints and compares.
 *
 * Honest limits: any local
 * process can fetch '/' and read the token out of the HTML. This contains
 * accidents, attested seats, and injected/hijacked tool-less seats that have
 * no HTTP-fetch capability of their own — it is NOT a boundary against
 * bash-capable local malice. Nothing on a single-user machine is.
 */

import { randomBytes, timingSafeEqual } from 'crypto';

/** 24 random bytes (192 bits) as hex — plenty to make guessing infeasible; length itself is not the security property here (see module doc: the boundary is "doesn't know to fetch/read the token", not entropy). */
export function mintHumanToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Constant-time compare against the expected token. `provided` is untrusted
 * wire input — anything other than a non-empty string of the SAME length as
 * `expected` fails fast (length-mismatch is not exploitable via timing: the
 * expected token's length is not itself a secret worth protecting, it's a
 * fixed constant for the process lifetime). A missing/undefined/empty
 * `provided` — the exact shape a naive/unaware caller sends — always fails.
 */
export function isValidHumanToken(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Standard rejection message for every humanToken-gated op — one string, not re-worded per call site. */
export const HUMAN_TOKEN_REQUIRED_ERROR =
  'unauthorized: this action requires the human token (served only via the dashboard page — a raw client without it cannot perform it).';
