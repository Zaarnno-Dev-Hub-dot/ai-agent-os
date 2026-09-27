/**
 * Attested-tier verifier (docs/DESIGN-seat-verification-tiers.md). Lives
 * OUTSIDE packages/shared on purpose — verifier.ts is FROZEN (Fable-owned,
 * "do not modify without review") and its challenge sequence hard-assumes
 * tool possession (nonce-FILE, capability-probe against a manifest
 * capability) that a bare tool-less HTTP completions endpoint can never
 * have. This module is the parallel path for manifests that opt into
 * `verification: 'attested'` instead of the (implicit) `full` tier.
 *
 * Three checks, same fail-closed philosophy as `full`, stopping at the first
 * failure:
 *   1. identity-echo — reused VERBATIM from the frozen verifier's public
 *      runChallenge() (no tools involved in that challenge at all — it's
 *      already tool-less), so the regex fail-closed behavior is byte-
 *      identical to `full`.
 *   2. attested-nonce — live round-trip nonce sent IN the prompt, judged
 *      here against a structured `{"nonce":"..."}` echo. Noise-tolerant
 *      retries with a freshly generated nonce each attempt on a miss (see
 *      withNoiseTolerance) — a live small model can occasionally miscopy an
 *      exact-echo value; a static mock fails every fresh attempt the same.
 *   3. attested-probe x2 — randomized arithmetic + string-transform
 *      micro-questions, judged here. Catches static/mock endpoints: the
 *      expected answer is freshly randomized every verification, so a canned
 *      responder cannot pass twice, let alone once against a fresh question.
 *      Same noise-tolerant retries as the nonce step (live-verified
 *      2026-07-08 against the real reality-check endpoint: even a genuinely
 *      live model occasionally flubs an artificial micro-task) — this does
 *      not rescue a static/mock responder, which fails every fresh attempt
 *      the same way.
 *
 * The two new challenge kinds are constructed here and cast through
 * AgentSession.prove()'s frozen `Challenge`/`ChallengeResponse` signature —
 * see packages/adapters/ollama/src/attestedProtocol.ts's doc comment for the
 * full endpoint-typed-cast rationale (same idiom as room.rollover).
 */

import type {
  AdapterManifest,
  AgentSession,
  AgentStatus,
  Challenge,
  ChallengeResponse,
  ProofOfLifeVerifier,
} from '@agent-os/shared';
import {
  buildArithmeticProbe,
  buildStringTransformProbe,
  checkProbeAnswer,
  parseNonceEcho,
  type AttestedChallengeResponse,
  type AttestedNonceChallenge,
  type AttestedProbeChallenge,
} from '@agent-os/adapters-ollama';

/**
 * Manifest-verification-tier read: packages/shared's AdapterManifest has no
 * `verification` field (frozen) — endpoint-typed cast, same idiom as
 * room.rollover (docs/TECH-DEBT.md). A manifest without the field is `full`.
 */
export function isAttestedManifest(manifest: AdapterManifest): boolean {
  return (manifest as AdapterManifest & { verification?: 'attested' }).verification === 'attested';
}

/**
 * "The verifier REFUSES to run `attested` for a manifest that declares
 * tools (no quiet downgrades)" — design doc invariant. A capability string
 * containing "tool" (file-tools, session-tools, the bare "tools" hermes
 * declares) is the signal a manifest grants real tool/filesystem access;
 * that combination with `attested` would silently downgrade a
 * tool-capable seat's proof-of-life to a weaker check than it should get.
 */
export function manifestDeclaresTools(manifest: AdapterManifest): boolean {
  return manifest.capabilities.some((c) => c.toLowerCase().includes('tool'));
}

const ATTESTED_CHALLENGE_TIMEOUT_MS = 120_000;

function nextChallengeId(counter: { n: number }): string {
  counter.n += 1;
  return `atch-${counter.n}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Digits only, on purpose. Live-verified 2026-07-08 against the real
 * reality-check endpoint through two prior designs: a long
 * `atn-<timestamp>-<rand><rand>` nonce (30+ chars) AND a short 8-char
 * lowercase-alphanumeric nonce BOTH still gave llama3.2:3b real trouble
 * echoing them back exactly, even with a retry — the same per-character
 * tokenization weak spot as the string-transform probe's original reversal
 * design. A random alphanumeric string splits into unpredictable subword
 * tokens; a random NUMBER tokenizes far more predictably (the arithmetic
 * probe, also all-digits, showed a ~0% failure rate across the same live
 * runs where the alphanumeric nonce failed repeatedly). This tier's threat
 * model doesn't need collision-resistance at security-secret scale (design
 * doc: "the in-prompt echo is not a leak here") — 9 random digits (1e9
 * possibilities) is ample for "changes every call", the actual requirement.
 */
function generateNonce(): string {
  return String(Math.floor(100_000_000 + Math.random() * 900_000_000));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Reads a session.prove() ChallengeResponse back as the attested wire shape (cast at the endpoint — see module doc comment). */
function asAttestedResponse(response: ChallengeResponse): AttestedChallengeResponse {
  return response as unknown as AttestedChallengeResponse;
}

async function runNonceStep(
  session: AgentSession,
  counter: { n: number },
  timeoutMs: number
): Promise<ChallengeResponse> {
  const challengeId = nextChallengeId(counter);
  const start = Date.now();
  const nonce = generateNonce();
  const challenge: AttestedNonceChallenge = {
    type: 'attested-nonce',
    challengeId,
    timestamp: Date.now(),
    timeoutMs,
    nonce,
  };

  const fail = (error: string): ChallengeResponse =>
    ({
      challengeId,
      type: 'attested-nonce',
      success: false,
      error,
      latencyMs: Date.now() - start,
    }) as unknown as ChallengeResponse;

  try {
    const raw = await withTimeout(
      session.prove(challenge as unknown as Challenge),
      timeoutMs,
      'attested-nonce'
    );
    const response = asAttestedResponse(raw);
    if (!response.success || !response.data?.raw) {
      return fail(response.error ?? 'Endpoint returned no text for the nonce challenge');
    }
    const echo = parseNonceEcho(response.data.raw, nonce);
    if (echo.matched) {
      return {
        challengeId,
        type: 'attested-nonce',
        success: true,
        data: { nonce, text: response.data.raw },
        latencyMs: Date.now() - start,
      } as unknown as ChallengeResponse;
    }
    if (echo.genericResponseSuspected) {
      return fail(
        'Generic-response detector: endpoint answered with prose instead of the structured nonce echo — placeholder/static-mock suspected'
      );
    }
    return fail(`Nonce mismatch: endpoint did not echo back {"nonce":"${nonce}"}`);
  } catch (e) {
    return fail(`Attested nonce challenge failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runProbeStep(
  session: AgentSession,
  counter: { n: number },
  timeoutMs: number,
  probe: ReturnType<typeof buildArithmeticProbe> | ReturnType<typeof buildStringTransformProbe>
): Promise<ChallengeResponse> {
  const challengeId = nextChallengeId(counter);
  const start = Date.now();
  const challenge: AttestedProbeChallenge = {
    type: 'attested-probe',
    challengeId,
    timestamp: Date.now(),
    timeoutMs,
    probeId: probe.probeId,
    question: probe.question,
  };

  const fail = (error: string): ChallengeResponse =>
    ({
      challengeId,
      type: 'attested-probe',
      success: false,
      error,
      latencyMs: Date.now() - start,
    }) as unknown as ChallengeResponse;

  try {
    const raw = await withTimeout(
      session.prove(challenge as unknown as Challenge),
      timeoutMs,
      `attested-probe-${probe.probeId}`
    );
    const response = asAttestedResponse(raw);
    if (!response.success || !response.data?.raw) {
      return fail(response.error ?? `Endpoint returned no text for the ${probe.probeId} probe`);
    }
    if (checkProbeAnswer(probe.probeId, response.data.raw, probe.expected)) {
      return {
        challengeId,
        type: 'attested-probe',
        success: true,
        data: { capability: probe.probeId, result: response.data.raw.slice(0, 200) },
        latencyMs: Date.now() - start,
      } as unknown as ChallengeResponse;
    }
    return fail(
      `Canned-responder probe (${probe.probeId}) failed: expected an answer matching "${probe.expected}", got "${response.data.raw.slice(0, 200)}"`
    );
  } catch (e) {
    return fail(`Attested ${probe.probeId} probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Live-verified noise tolerance (2026-07-08, real reality-check endpoint,
 * llama3.2:3b + qwen2.5:7b): a genuinely live small local model occasionally
 * misses an exact-echo/artificial-micro-task challenge even when it is
 * unambiguously the right, live model — three separate designs iterated
 * live (nonce length/alphabet, probe word length, retry count) before
 * landing here. A miss is noise, not evidence of an impostor, PROVIDED the
 * retry gets a genuinely fresh challenge each time (never re-ask the same
 * question) — this does NOT weaken the anti-mock guarantee: a static/canned
 * responder fails every fresh attempt identically (it cannot produce a live
 * answer to any of them), so this can never rescue an impostor, only
 * forgive a real model's occasional flub. Only the LAST attempt's response
 * is kept in challengeHistory (a passing retry looks identical to a
 * first-try pass to the caller).
 */
const NOISE_RETRY_ATTEMPTS = 3;

async function withNoiseTolerance(attempt: () => Promise<ChallengeResponse>): Promise<ChallengeResponse> {
  let last: ChallengeResponse | undefined;
  for (let i = 0; i < NOISE_RETRY_ATTEMPTS; i++) {
    last = await attempt();
    if (last.success) return last;
  }
  return last!;
}

/**
 * Full attested-tier challenge sequence: identity → live nonce → arithmetic
 * probe → string-transform probe. Stops at the first failure, mirroring the
 * frozen verifier's runFullChallenge. Returns the same
 * `{status, responses}` shape connectAgent already expects from
 * runFullChallengeWithTransientRetry, so the call site in agents.ts is a
 * plain branch, not a fork of the surrounding bookkeeping.
 */
export async function runAttestedChallenge(
  agentId: string,
  session: AgentSession,
  manifest: AdapterManifest,
  verifier: ProofOfLifeVerifier,
  timeoutMs: number = ATTESTED_CHALLENGE_TIMEOUT_MS
): Promise<{ status: AgentStatus; responses: ChallengeResponse[] }> {
  if (manifestDeclaresTools(manifest)) {
    // Fail closed with ZERO live calls — a manifest declaring tools has no
    // business requesting the weaker tool-less tier at all (design doc: "no
    // quiet downgrades").
    return {
      status: 'FAILED',
      responses: [
        {
          challengeId: 'atch-refused',
          type: 'identity-echo',
          success: false,
          error: `Refused: manifest "${manifest.id}" declares tool capabilities [${manifest.capabilities.join(', ')}] but requested the attested (tool-less) verification tier — no quiet downgrades (docs/DESIGN-seat-verification-tiers.md).`,
          latencyMs: 0,
        },
      ],
    };
  }

  const counter = { n: 0 };
  const responses: ChallengeResponse[] = [];

  // Step 1 — identity, byte-identical fail-closed logic to `full` (this
  // challenge never touches tools even on tool-capable manifests).
  const identity = await verifier.runChallenge(agentId, session, manifest, 'identity-echo');
  responses.push(identity);
  if (!identity.success) return { status: 'FAILED', responses };

  // Step 2 — live round-trip nonce, with noise-tolerant retries on a miss
  // (see withNoiseTolerance doc comment).
  const nonceResult = await withNoiseTolerance(() => runNonceStep(session, counter, timeoutMs));
  responses.push(nonceResult);
  if (!nonceResult.success) return { status: 'FAILED', responses };

  // Step 3 — two randomized canned-responder probes, same noise-tolerant
  // retries (a freshly randomized question every attempt).
  const probeBuilders = [buildArithmeticProbe, buildStringTransformProbe];
  for (const buildProbe of probeBuilders) {
    const probeResult = await withNoiseTolerance(() => runProbeStep(session, counter, timeoutMs, buildProbe()));
    responses.push(probeResult);
    if (!probeResult.success) return { status: 'FAILED', responses };
  }

  return { status: 'VERIFIED', responses };
}
