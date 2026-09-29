/**
 * Attested-tier challenge wire shapes. packages/shared's `Challenge`/
 * `ChallengeResponse` unions are FROZEN and closed to exactly
 * `identity-echo | nonce-file | capability-probe` — full-tier challenges that
 * assume tool possession this tool-less endpoint can never have.
 *
 * These two new challenge kinds are typed HERE, in this leaf adapter
 * package, and cast to/from the frozen unions at the two endpoints that
 * speak them: gateway/attestedVerifier.ts (constructs the challenge, judges
 * the answer) and this adapter's OllamaSession.prove() (receives it, does
 * the live round trip, reports back the raw text — it does NOT judge
 * correctness itself, same separation of concerns as the frozen verifier's
 * runNonceFile, which ignores the adapter's own `success` flag and compares
 * `response.data.nonce` itself). Same endpoint-typed-cast idiom already used
 * for room.rollover / state.sync additive fields elsewhere in this repo
 * — packages/shared stays untouched.
 */

export interface AttestedNonceChallenge {
  type: 'attested-nonce';
  challengeId: string;
  timestamp: number;
  timeoutMs: number;
  /**
   * Sent IN the prompt, on purpose. This is NOT the same security posture as
   * the frozen nonce-file challenge — this tier's threat model is "is a live
   * model behind the endpoint answering THIS challenge", not "can the agent
   * reach a file only it can read".
   */
  nonce: string;
}

export interface AttestedProbeChallenge {
  type: 'attested-probe';
  challengeId: string;
  timestamp: number;
  timeoutMs: number;
  probeId: 'arithmetic' | 'string-transform';
  /** The literal prompt text sent to the model for this probe. */
  question: string;
}

export type AttestedChallenge = AttestedNonceChallenge | AttestedProbeChallenge;
export type AttestedChallengeType = AttestedChallenge['type'];

export interface AttestedChallengeResponseData {
  /** Raw model text for this turn, verbatim — the verifier judges correctness from this. */
  raw?: string;
  /** Endpoint self-reported model id from the response body (informational; identity-echo is the real identity check). */
  reportedModel?: string;
}

export interface AttestedChallengeResponse {
  challengeId: string;
  type: AttestedChallengeType;
  /** Transport-level success only (the round trip completed) — NOT an answer-correctness verdict. The caller judges that from `data.raw`. */
  success: boolean;
  data?: AttestedChallengeResponseData;
  error?: string;
  latencyMs: number;
}

// ----------------------------------------------------------------------------
// Nonce echo parsing (verifier-side judgement, exported so both the gateway
// orchestrator and this package's own tests can exercise the same tolerant
// parser without duplicating it).
// ----------------------------------------------------------------------------

/** Prose this long with no structured echo trips the generic-response detector — same threshold philosophy as the frozen verifier's GENERIC_PROSE_THRESHOLD, reimplemented here since verifier.ts is frozen and this is a different challenge shape entirely. */
export const ATTESTED_GENERIC_PROSE_THRESHOLD = 40;

export interface NonceEchoResult {
  matched: boolean;
  /** Set when the response looked like unstructured prose rather than a structured echo — the impostor/static-mock signature. */
  genericResponseSuspected: boolean;
  parsedNonce?: string;
}

/**
 * Tolerant extraction of `{"nonce":"<value>"}` from a live model's raw text —
 * models routinely wrap JSON in markdown fences or add a trailing newline.
 * Tries a strict JSON.parse first (after stripping fences), then falls back
 * to a regex for `"nonce"` `:` `"<value>"` inside otherwise-noisy text.
 */
export function parseNonceEcho(raw: string, expectedNonce: string): NonceEchoResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === 'object' && 'nonce' in parsed) {
      const value = (parsed as { nonce?: unknown }).nonce;
      if (typeof value === 'string') {
        return { matched: value === expectedNonce, genericResponseSuspected: false, parsedNonce: value };
      }
    }
  } catch {
    /* fall through to regex */
  }

  const m = cleaned.match(/"nonce"\s*:\s*"([^"]*)"/i);
  if (m) {
    return { matched: m[1] === expectedNonce, genericResponseSuspected: false, parsedNonce: m[1] };
  }

  // No structured echo found. A bare mock/impostor answers with plausible
  // prose instead of the exact structure — flag it the same way the frozen
  // verifier's generic-response detector does for nonce-file.
  const prose = cleaned.replace(/[{}"]/g, '').trim();
  return {
    matched: false,
    genericResponseSuspected: prose.length > ATTESTED_GENERIC_PROSE_THRESHOLD,
  };
}

// ----------------------------------------------------------------------------
// Canned-responder probes: two randomized micro-questions.
// Regenerated fresh on every verification so a static/mock endpoint that
// always returns the same canned text cannot pass twice in a row, let alone
// once against a freshly-randomized expected answer.
// ----------------------------------------------------------------------------

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export interface GeneratedProbe {
  probeId: 'arithmetic' | 'string-transform';
  question: string;
  expected: string;
}

export function buildArithmeticProbe(): GeneratedProbe {
  const a = randInt(11, 89);
  const b = randInt(11, 89);
  return {
    probeId: 'arithmetic',
    question: `Reply with ONLY the sum of ${a} and ${b} as a single integer. No words, no punctuation, nothing else.`,
    expected: String(a + b),
  };
}

/**
 * Short, common, single-morpheme words on purpose — live-verified against
 * the real reality-check endpoint (2026-07-08): qwen2.5:7b occasionally
 * garbled a longer/rarer word even under this easier uppercase transform
 * (one run: "lighthouse" -> "LHOUSE"). Shorter, everyday words tokenize more
 * predictably and cut that error rate; the caller (attestedVerifier.ts)
 * additionally retries a probe miss once with a freshly randomized question
 * as defense in depth against the residual noise.
 */
const PROBE_WORDS = [
  'candle',
  'copper',
  'forest',
  'garden',
  'pencil',
  'planet',
  'ribbon',
  'silver',
  'violet',
  'window',
] as const;

/**
 * Uppercase conversion, NOT character reversal. A first version of this
 * probe asked for the word spelled backwards — live-verified against the
 * real reality-check endpoint (2026-07-08), qwen2.5:7b got a 10-letter
 * reversal wrong ("lighthouse" -> "ehotwiregl") while llama3.2:3b got a
 * *different* word's reversal right, confirming this is the well-known LLM
 * tokenization weak spot (per-character manipulation), not a static/mock
 * signature — it would have produced false FAILED on a genuinely live small
 * model. Case conversion is a transform a mock still can't fake (the word
 * and its expected uppercase form are freshly randomized every call) without
 * the reversal's per-character fragility.
 */
export function buildStringTransformProbe(): GeneratedProbe {
  const word = PROBE_WORDS[randInt(0, PROBE_WORDS.length - 1)];
  return {
    probeId: 'string-transform',
    question: `Reply with ONLY the word "${word}" in ALL UPPERCASE LETTERS. No spaces, no punctuation, nothing else.`,
    expected: word.toUpperCase(),
  };
}

/**
 * Judges a probe answer against its expected value. Each probe kind gets its
 * own tolerant extraction — a live model told "ONLY the integer" still
 * sometimes wraps it in a stray period or a word, and that shouldn't read as
 * an impostor; a static mock that ignores the question entirely still fails
 * because the expected value is freshly randomized every call.
 */
export function checkProbeAnswer(probeId: GeneratedProbe['probeId'], raw: string, expected: string): boolean {
  if (probeId === 'arithmetic') {
    const m = raw.match(/-?\d+/);
    return m !== null && m[0] === expected;
  }
  // string-transform: strip everything but letters, lowercase, compare directly.
  const normalized = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  return normalized === expected.toLowerCase();
}
