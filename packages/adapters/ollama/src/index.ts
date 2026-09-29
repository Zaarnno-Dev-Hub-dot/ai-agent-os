import {
  AdapterConfig,
  AdapterError,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  Challenge,
  ChallengeResponse,
  HealthReport,
  OutboundMessage,
} from '@agent-os/shared';
import { ollamaManifest, type AttestedAdapterManifest } from './manifest.js';
import { chatCompletion, type ChatMessage, timeoutMsOf } from './httpClient.js';
import type { AttestedNonceChallenge, AttestedProbeChallenge } from './attestedProtocol.js';

export { ollamaManifest };
export type { AttestedAdapterManifest } from './manifest.js';
export type { OllamaTransportConfig } from './httpClient.js';
export * from './attestedProtocol.js';

class OllamaSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private busy = false;
  private turnPump: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;

  constructor(
    private readonly config: AdapterConfig,
    private readonly startedAt: number,
    /** Cached from the connect-time handshake / most recent live round trip — health() reads this instead of making its own call (see health() doc comment). */
    private cachedModelId: string
  ) {}

  private enqueue(...events: AgentEvent[]) {
    if (this.disposed || events.length === 0) return;
    this.queue.push(...events);
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.disposed) throw new Error('Ollama session disposed');
    // Same wait-out-the-in-flight-turn pattern as the grok-build adapter: the
    // relay's "turn done" signal streams out (message-complete) slightly
    // before this session's own pump resolves its finally block, so an
    // immediate next send() can observe busy=true for a few microtasks.
    while (this.busy && this.turnPump) {
      await this.turnPump.catch(() => undefined);
    }
    if (this.busy) throw new Error('Ollama session busy — gateway must serialize sends per agent');
    this.busy = true;
    const messageId = `ol-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Same sender-prefix convention as every other adapter (claude-code,
    // grok-build, hermes, openclaw) — composeWindowedOutbound already bakes
    // the room's windowed history + a "you are X, reply to the latest
    // message" instruction into msg.content; this adds the same per-turn
    // sender tag those adapters add on top of it.
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    const ac = new AbortController();
    this.activeAbort = ac;
    this.turnPump = (async () => {
      try {
        const result = await chatCompletion(this.config, [{ role: 'user', content: prompt }], {
          signal: ac.signal,
        });
        if (result.reportedModel) this.cachedModelId = result.reportedModel;
        if (result.text) {
          this.enqueue({ type: 'token', delta: result.text, messageId });
        }
        if (result.usage) {
          this.enqueue({
            type: 'usage',
            tokensIn: result.usage.promptTokens ?? 0,
            tokensOut: result.usage.completionTokens ?? 0,
            messageId,
          });
        }
        this.enqueue({ type: 'message-complete', messageId });
      } catch (e) {
        this.enqueue({
          type: 'error',
          code: 'http-error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: true,
          messageId,
        });
        this.enqueue({ type: 'message-complete', messageId });
      } finally {
        this.busy = false;
        if (this.activeAbort === ac) this.activeAbort = null;
      }
    })();
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (!this.disposed) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      await new Promise<void>((resolve) => {
        if (this.disposed) {
          resolve();
          return;
        }
        this.waiters.push(resolve);
      });
    }
  }

  async prove(challenge: Challenge): Promise<ChallengeResponse> {
    const start = Date.now();
    // packages/shared's Challenge/ChallengeType union is closed to
    // identity-echo | nonce-file | capability-probe — the two attested-tier
    // kinds are cast in at the two endpoints that speak them (see
    // attestedProtocol.ts's doc comment). Read the raw wire `type` before
    // narrowing against the real union so the attested kinds don't trip a
    // "no overlap" compile error, same idiom as gateway/index.ts's
    // room.rollover pre-switch handler.
    const rawType = (challenge as unknown as { type: string }).type;

    try {
      if (rawType === 'attested-nonce') {
        const c = challenge as unknown as AttestedNonceChallenge;
        // The challenge carries the bare nonce VALUE — this adapter builds the actual instructional
        // prompt around it, same division of labor as every other adapter's
        // nonce-file challenge (the verifier supplies the raw ingredient;
        // the adapter phrases it for its own harness). Omitting the
        // instructions here would send the model a bare random string with
        // no indication of what to do with it.
        const prompt =
          `You are answering a live proof-of-life challenge for Agent OS. ` +
          `Reply with ONLY a JSON object of the exact form {"nonce":"${c.nonce}"} — ` +
          `no markdown fences, no explanation, no extra text.`;
        return await this.runAttestedRoundTrip(c.challengeId, 'attested-nonce', prompt, start);
      }
      if (rawType === 'attested-probe') {
        const c = challenge as unknown as AttestedProbeChallenge;
        // The probe's `question` is already the complete instructional
        // prompt (built by gateway/attestedVerifier.ts's probe generators).
        return await this.runAttestedRoundTrip(c.challengeId, 'attested-probe', c.question, start);
      }

      if (challenge.type === 'identity-echo') {
        const modelId = await this.fetchModelId();
        return {
          challengeId: challenge.challengeId,
          type: 'identity-echo',
          success: true,
          data: { modelId },
          latencyMs: Date.now() - start,
        };
      }

      // nonce-file / capability-probe both assume real tool possession this
      // bare completions endpoint doesn't have — Policy: "attested
      // seats never receive workspace/file tasks." Fail honestly instead of
      // faking a pass; a manifest that somehow requested full-tier challenges
      // against this adapter must see a real failure, not painted status.
      if (challenge.type === 'nonce-file' || challenge.type === 'capability-probe') {
        return {
          challengeId: challenge.challengeId,
          type: challenge.type,
          success: false,
          error: `${challenge.type} is not supported by attested-tier tool-less seats`,
          latencyMs: Date.now() - start,
        };
      }

      // Every real Challenge member (identity-echo, nonce-file,
      // capability-probe) and both attested kinds are handled above — this
      // is unreachable for any actual caller, but stays a real failure
      // rather than a silent narrow-to-never so a future new challenge kind
      // fails loud instead of falling through unnoticed.
      return {
        challengeId: (challenge as unknown as { challengeId?: string }).challengeId ?? rawType,
        type: rawType as ChallengeResponse['type'],
        success: false,
        error: `Unknown challenge type: ${rawType}`,
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      return {
        challengeId: (challenge as unknown as { challengeId?: string }).challengeId ?? rawType,
        type: rawType as ChallengeResponse['type'],
        success: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * The live round trip behind BOTH attested-nonce and attested-probe: send
   * `prompt` to the real endpoint, hand back the raw text verbatim. This
   * does NOT judge correctness — `success` here means "the transport round
   * trip completed", not "the answer was right". gateway/attestedVerifier.ts
   * judges the nonce/probe answer itself from `data.raw`, mirroring how the
   * frozen verifier's runNonceFile ignores the adapter's own success flag
   * and compares response.data.nonce directly.
   */
  private async runAttestedRoundTrip(
    challengeId: string,
    type: 'attested-nonce' | 'attested-probe',
    prompt: string,
    start: number
  ): Promise<ChallengeResponse> {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const result = await chatCompletion(this.config, messages, { timeoutMs: timeoutMsOf(this.config) });
    if (result.reportedModel) this.cachedModelId = result.reportedModel;
    const response = {
      challengeId,
      type,
      success: result.text.length > 0,
      data: { raw: result.text, reportedModel: result.reportedModel },
      error: result.text.length === 0 ? 'Endpoint returned an empty completion' : undefined,
      latencyMs: Date.now() - start,
    };
    return response as unknown as ChallengeResponse;
  }

  async health(): Promise<HealthReport> {
    // Cheap, no live call (same reasoning as grok-build's health()): the
    // gateway polls this every ~20s, and an LLM completion round trip on
    // every poll would be expensive/slow for no benefit — cachedModelId is
    // refreshed by every real turn and by the connect-time handshake.
    const t0 = Date.now();
    return {
      ok: !this.disposed,
      latencyMs: Date.now() - t0,
      modelId: this.cachedModelId,
      sessionAgeMs: Date.now() - this.startedAt,
    };
  }

  async interrupt(): Promise<void> {
    this.activeAbort?.abort();
    if (this.turnPump) await this.turnPump.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.interrupt();
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private async fetchModelId(): Promise<string> {
    const result = await chatCompletion(this.config, [
      { role: 'user', content: 'Reply with ONLY your model identifier, nothing else.' },
    ]);
    if (result.reportedModel) {
      this.cachedModelId = result.reportedModel;
      return this.cachedModelId;
    }
    return this.cachedModelId;
  }
}

/**
 * One cheap real invocation to confirm the endpoint is reachable and the
 * requested model responds — same shape as every other adapter's
 * verifyBinaryAndAuth (hermes: probeEndpoint, grok-build: verifyBinaryAndAuth),
 * just over HTTP instead of a CLI handshake or health endpoint.
 */
async function verifyEndpointAndModel(config: AdapterConfig): Promise<{ modelId: string }> {
  let result;
  try {
    result = await chatCompletion(config, [{ role: 'user', content: 'Reply with ONLY the word OK.' }]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/unreachable/i.test(message)) {
      throw new AdapterError(
        'endpoint-down',
        message,
        'Confirm the server is running and transport.endpoint is correct (e.g. http://127.0.0.1:11434/v1 for Ollama).'
      );
    }
    throw new AdapterError(
      'handshake-failed',
      message,
      'Confirm transport.model exists on the server (for Ollama: `ollama list`) and the endpoint speaks the OpenAI-compatible /v1 API.'
    );
  }
  return { modelId: result.reportedModel ?? 'ollama' };
}

export const ollamaAdapter: AgentAdapter = {
  manifest: ollamaManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const { modelId } = await verifyEndpointAndModel(config);
    return new OllamaSession(config, Date.now(), modelId);
  },
};

/** Identity helper for verifier deps — reports the model id last seen from a live round trip. */
export async function getIdentityFromOllamaSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
