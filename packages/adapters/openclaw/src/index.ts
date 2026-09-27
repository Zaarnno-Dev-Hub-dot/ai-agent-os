/**
 * OpenClaw adapter — `ws` flavor (PRD §3, §3.1). Connects as an operator client
 * to the OpenClaw Gateway's typed WebSocket API (default ws://127.0.0.1:18789),
 * declares role + scopes at handshake, and targets a named OpenClaw agent
 * workspace via `agentId`.
 *
 * LIVE-TEST STATUS (disclose unprompted per BUILDER_PROTOCOL.md): at build
 * time, `Test-NetConnection 127.0.0.1 18789` failed (nothing listening) and no
 * `openclaw` CLI was found on PATH. This adapter is code-complete against the
 * protocol documented at docs.openclaw.ai/gateway/protocol (fetched 2026-07-04)
 * but has NOT been hand-tested against a real OpenClaw gateway handshake. The
 * exact streaming event names/shapes for chat deltas, tool events, and
 * completion are best-effort from the docs (see protocol.ts header) — the
 * event mapper below is written defensively (multiple plausible field names,
 * no throw on unrecognized events) for that reason, but should be re-verified
 * against a live gateway before this harness is trusted for Phase 1's gate.
 *
 * CRITICAL (same invariant as claude-code/grok-build, gate-blocker 1
 * precedent): the OPENCLAW AGENT's own tools must perform the nonce-file
 * read. This adapter process NEVER touches the filesystem for a challenge —
 * it dispatches a chat.send instructing the remote agent to read the path
 * and reply with only the contents, then reads the agent's reply back off
 * the WS event stream. A bare relay with no real tool access cannot pass.
 */
import {
  AdapterConfig,
  AdapterError,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  Challenge,
  ChallengeResponse,
  ChallengeType,
  HealthReport,
  OutboundMessage,
} from '@agent-os/shared';
import { openclawManifest } from './manifest.js';
import { OpenClawWsClient } from './wsClient.js';
import {
  ChatEventPayload,
  ErrorEventPayload,
  OpenClawTransportConfig,
  SessionMessagePayload,
  SessionToolEventPayload,
} from './protocol.js';
import type { EventFrame } from './protocol.js';

export { openclawManifest, OPENCLAW_DEFAULT_MODEL_PATTERN } from './manifest.js';
export type { OpenClawTransportConfig } from './protocol.js';

const NONCE_INSTRUCTIONS = (noncePath: string) =>
  `You are answering a proof-of-life challenge for Agent OS. ` +
  `Use your own file-reading tool to read the exact file at this path: ${noncePath} ` +
  `Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.`;

function transportOf(config: AdapterConfig): OpenClawTransportConfig {
  return config.transport as OpenClawTransportConfig;
}

function extractDeltaText(payload: ChatEventPayload | SessionMessagePayload | undefined): string | undefined {
  if (!payload) return undefined;
  if ('deltaText' in payload && typeof payload.deltaText === 'string') return payload.deltaText;
  if ('message' in payload && typeof (payload as ChatEventPayload).message === 'string') {
    return (payload as ChatEventPayload).message;
  }
  if ('content' in payload && typeof (payload as SessionMessagePayload).content === 'string') {
    return (payload as SessionMessagePayload).content;
  }
  return undefined;
}

/**
 * Map one inbound OpenClaw event frame to zero or more AgentEvents for a
 * specific in-flight turn (messageId). Unrecognized events are dropped, not
 * thrown — an unknown-but-harmless event must never crash the session.
 */
function mapEventFrame(frame: EventFrame, messageId: string): AgentEvent[] {
  switch (frame.event) {
    case 'chat':
    case 'chat.inject':
    case 'session.message': {
      const payload = frame.payload as ChatEventPayload & SessionMessagePayload;
      const delta = extractDeltaText(payload);
      const out: AgentEvent[] = [];
      if (delta) out.push({ type: 'token', delta, messageId });
      if (payload?.final) {
        if (payload.usage) {
          out.push({
            type: 'usage',
            tokensIn: payload.usage.input_tokens ?? 0,
            tokensOut: payload.usage.output_tokens ?? 0,
            messageId,
          });
        }
        out.push({ type: 'message-complete', messageId });
      }
      return out;
    }

    case 'session.tool': {
      const payload = frame.payload as SessionToolEventPayload;
      const tool = payload?.tool ?? payload?.toolId ?? 'tool';
      if (payload?.status === 'completed' || payload?.status === 'failed') {
        return [{ type: 'tool-end', tool, result: payload?.result ?? null, messageId }];
      }
      return [{ type: 'tool-start', tool, args: payload?.args ?? {}, messageId }];
    }

    case 'session.operation': {
      const payload = frame.payload as { summary?: string; text?: string } | undefined;
      const summary = payload?.summary ?? payload?.text;
      if (summary) return [{ type: 'thinking', summary, messageId }];
      return [];
    }

    case 'error': {
      const payload = frame.payload as ErrorEventPayload | undefined;
      return [
        {
          type: 'error',
          code: payload?.code ?? 'openclaw-error',
          message: payload?.message ?? 'OpenClaw reported an error',
          recoverable: payload?.recoverable ?? true,
          messageId,
        },
      ];
    }

    default:
      return [];
  }
}

class OpenClawSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private busy = false;
  private unsubscribe: (() => void) | undefined;
  private modelId = 'openclaw';

  constructor(
    private readonly client: OpenClawWsClient,
    private readonly config: AdapterConfig,
    private readonly startedAt: number
  ) {}

  private enqueue(...events: AgentEvent[]) {
    if (this.disposed || events.length === 0) return;
    this.queue.push(...events);
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private agentId(): string | undefined {
    return transportOf(this.config).agentId;
  }

  /**
   * Dispatch one chat.send turn and collect events for messageId until the
   * gateway reports the turn complete or the timeout elapses. Returns the
   * concatenated text reply (used both for normal sends and for challenge
   * dispatch — the nonce/identity/capability prompts all just read the
   * final reply text off the same path).
   */
  private async runTurn(
    prompt: string,
    messageId: string,
    timeoutMs = 60_000
  ): Promise<{ text: string; completed: boolean }> {
    let text = '';
    let completed = false;

    const off = this.client.onEvent((frame) => {
      const events = mapEventFrame(frame, messageId);
      for (const ev of events) {
        if (ev.type === 'token') text += ev.delta;
        if (ev.type === 'message-complete') completed = true;
      }
      this.enqueue(...events);
    });

    try {
      await this.client.request(
        'chat.send',
        {
          sessionKey: messageId,
          message: prompt,
          agentId: this.agentId(),
        },
        timeoutMs
      );

      const deadline = Date.now() + timeoutMs;
      while (!completed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      off();
    }

    return { text: text.trim(), completed };
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.disposed) throw new Error('OpenClaw session disposed');
    if (this.busy) throw new Error('OpenClaw session busy — gateway must serialize sends per agent');
    this.busy = true;
    const messageId = `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    (async () => {
      try {
        const { completed } = await this.runTurn(prompt, messageId);
        if (!completed) {
          this.enqueue({
            type: 'error',
            code: 'openclaw-timeout',
            message: 'OpenClaw did not report chat.send completion before timeout',
            recoverable: true,
            messageId,
          });
        }
      } catch (e) {
        this.enqueue({
          type: 'error',
          code: 'openclaw-send-failed',
          message: e instanceof Error ? e.message : String(e),
          recoverable: true,
          messageId,
        });
      } finally {
        this.busy = false;
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
    const challengeId = challenge.challengeId;
    const type = challenge.type as ChallengeType;

    try {
      if (challenge.type === 'identity-echo') {
        const modelId = await this.fetchModelId();
        return { challengeId, type, success: true, data: { modelId }, latencyMs: Date.now() - start };
      }

      if (challenge.type === 'nonce-file') {
        // NON-NEGOTIABLE: the OpenClaw agent's own tools read the file — this
        // process never touches challenge.noncePath itself.
        const { text, completed } = await this.runTurn(
          NONCE_INSTRUCTIONS(challenge.noncePath),
          `pol-${challengeId}`,
          challenge.timeoutMs
        );
        if (!completed) {
          return {
            challengeId,
            type,
            success: false,
            error: 'OpenClaw did not complete the nonce-file turn before timeout',
            latencyMs: Date.now() - start,
          };
        }
        return {
          challengeId,
          type,
          success: text.length > 0,
          data: { nonce: text, text },
          latencyMs: Date.now() - start,
        };
      }

      if (challenge.type === 'capability-probe') {
        const { text, completed } = await this.runTurn(
          'List the files in your current working directory using your own file-listing tool ' +
            'and reply with ONLY the name of one file or directory you see.',
          `probe-${challengeId}`,
          challenge.timeoutMs
        );
        return {
          challengeId,
          type,
          success: completed && text.length > 0,
          data: { capability: challenge.capability, result: text.slice(0, 500) },
          latencyMs: Date.now() - start,
        };
      }

      return { challengeId, type, success: false, error: 'Unknown challenge type', latencyMs: Date.now() - start };
    } catch (e) {
      return {
        challengeId,
        type,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - start,
      };
    }
  }

  async health(): Promise<HealthReport> {
    const t0 = Date.now();
    const ok = this.client.isOpen && !this.disposed;
    return {
      ok,
      latencyMs: Date.now() - t0,
      modelId: this.modelId,
      sessionAgeMs: Date.now() - this.startedAt,
    };
  }

  async interrupt(): Promise<void> {
    if (!this.client.isOpen) return;
    try {
      await this.client.request('sessions.stop', { agentId: this.agentId() }, 5_000);
    } catch {
      // Best-effort; interrupt must not throw if the gateway has no matching method/session.
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    await this.client.close();
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private async fetchModelId(): Promise<string> {
    try {
      const res = await this.client.request<{ agentId?: string }, { agents?: Array<{ id: string; model?: string }> }>(
        'agents.list',
        { agentId: this.agentId() },
        10_000
      );
      const wanted = this.agentId();
      const entry = wanted
        ? res.payload?.agents?.find((a) => a.id === wanted)
        : res.payload?.agents?.[0];
      if (entry?.model) {
        this.modelId = entry.model;
        return this.modelId;
      }
    } catch {
      // Fall through to the chat-turn self-report below.
    }

    const { text, completed } = await this.runTurn(
      'Reply with ONLY your model identifier, nothing else.',
      `identity-${Date.now().toString(36)}`,
      15_000
    );
    if (completed && text) {
      this.modelId = text.split(/\s+/)[0] ?? this.modelId;
    }
    return this.modelId;
  }
}

export const openclawAdapter: AgentAdapter = {
  manifest: openclawManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const transport = transportOf(config);
    const client = await OpenClawWsClient.connect(transport);
    return new OpenClawSession(client, config, Date.now());
  },
};

/** Identity helper for verifier deps — reports model id from inside the OpenClaw session itself. */
export async function getIdentityFromOpenClawSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
