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
import { hermesManifest } from './manifest.js';
import {
  authHeaders,
  baseUrl,
  HermesRunSseEvent,
  HermesTransportConfig,
  startRun,
  stopRun,
  streamRunEvents,
  waitForRunTerminal,
} from './hermesRuns.js';
import { resolveHermesAdapterConfig } from './resolveHermesConfig.js';

export { hermesManifest };
export { resolveHermesAdapterConfig, defaultHermesKeyFile } from './resolveHermesConfig.js';

export type { HermesTransportConfig };

const NONCE_RUN_INSTRUCTIONS = `You are answering a proof-of-life challenge for Agent OS.
Use your read_file tool to read the exact filesystem path given in the user message.
Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.
If read_file shows LINE_NUM|CONTENT lines, reply with the CONTENT only (omit line numbers and pipes).`;

/** Hermes read_file returns LINE_NUM|CONTENT; strip gutters before nonce comparison. */
function stripHermesReadFileGutter(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return trimmed;
  const lines = trimmed.split(/\r?\n/);
  const stripped = lines.map((line) => {
    const pipe = line.indexOf('|');
    if (pipe > 0 && /^\d+$/.test(line.slice(0, pipe))) {
      return line.slice(pipe + 1);
    }
    return line;
  });
  return stripped.join('\n').trim();
}

async function probeEndpoint(config: AdapterConfig): Promise<void> {
  const url = `${baseUrl(config)}/health/detailed`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(config), signal: AbortSignal.timeout(8000) });
  } catch {
    throw new AdapterError(
      'endpoint-down',
      `Hermes API not reachable at ${baseUrl(config)}`,
      'Enable API_SERVER_ENABLED in your Hermes profile .env and restart the Hermes gateway.'
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new AdapterError(
      'auth-missing',
      'Hermes API rejected credentials',
      'Set API_SERVER_KEY in the Hermes .env (keyFile) or transport.apiKey for remote harnesses.'
    );
  }
  if (!res.ok) {
    throw new AdapterError('handshake-failed', `Hermes health returned ${res.status}`, url);
  }
}

/** Exported for unit testing the usage/message-complete ordering contract (see index.test.ts). */
export function mapSseToAgentEvents(ev: HermesRunSseEvent, messageId: string): AgentEvent[] {
  const name = ev.event;
  if (name === 'message.delta' && ev.delta) {
    return [{ type: 'token', delta: ev.delta, messageId }];
  }
  if (name === 'tool.started') {
    return [
      {
        type: 'tool-start',
        tool: ev.tool ?? 'tool',
        args: { preview: ev.preview ?? '' },
        messageId,
      },
    ];
  }
  if (name === 'tool.completed') {
    return [
      {
        type: 'tool-end',
        tool: ev.tool ?? 'tool',
        result: { duration: ev.duration, error: ev.error },
        messageId,
      },
    ];
  }
  if (name === 'reasoning.available' && ev.text) {
    return [{ type: 'thinking', summary: ev.text, messageId }];
  }
  if (name === 'run.completed') {
    // CONTRACT: usage must precede message-complete. The relay
    // (AgentRelayWorker.handleEvent) stashes 'usage' into pendingUsage and
    // reads it when 'message-complete' fires commitAgentReply; runOne's
    // finally then nulls this.current, so a usage event arriving AFTER
    // message-complete is silently dropped (handleEvent early-returns once
    // current is null). This was a live bug: usage was pushed last here.
    const out: AgentEvent[] = [];
    if (ev.usage) {
      out.push({
        type: 'usage',
        tokensIn: ev.usage.input_tokens ?? 0,
        tokensOut: ev.usage.output_tokens ?? 0,
        messageId,
      });
    }
    out.push({ type: 'message-complete', messageId });
    return out;
  }
  if (name === 'run.failed') {
    const msg = typeof ev.error === 'string' ? ev.error : 'Hermes run failed';
    return [{ type: 'error', code: 'run.failed', message: msg, recoverable: true, messageId }];
  }
  return [];
}

class HermesSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private activeRunId: string | null = null;
  private sseAbort: AbortController | null = null;
  private ssePump: Promise<void> | null = null;
  private disposed = false;
  /** Per-turn session rotation counter — see send() for why. */
  private turnCounter = 0;

  constructor(
    private readonly config: AdapterConfig,
    private readonly startedAt: number,
    private modelId: string
  ) {}

  private enqueue(...events: AgentEvent[]) {
    if (this.disposed || events.length === 0) return;
    this.queue.push(...events);
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private async pumpRunEvents(runId: string): Promise<void> {
    const messageId = runId;
    const ac = new AbortController();
    this.sseAbort = ac;
    try {
      for await (const ev of streamRunEvents(this.config, runId, ac.signal)) {
        this.enqueue(...mapSseToAgentEvents(ev, messageId));
        if (
          ev.event === 'run.completed' ||
          ev.event === 'run.failed' ||
          ev.event === 'run.cancelled'
        ) {
          break;
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        this.enqueue({
          type: 'error',
          code: 'sse',
          message: e instanceof Error ? e.message : String(e),
          recoverable: true,
          messageId,
        });
      }
    } finally {
      if (this.sseAbort === ac) this.sseAbort = null;
      this.activeRunId = null;
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.disposed) throw new Error('Hermes session disposed');
    if (this.activeRunId) {
      throw new Error('Hermes session busy — gateway must serialize sends per agent');
    }

    // Rotate to a fresh session id EVERY chat turn. A brand-new session per turn means
    // each turn's server-side context is exactly this turn's prompt — the
    // relay's own history windowing (relayWindow.ts) supplies whatever
    // prior context the agent should see. prove()/health() are untouched:
    // they build their own session ids for challenges and never reuse
    // config.sessionId for a chat turn either.
    // startedAt is included because turnCounter restarts at 1 for every new
    // HermesSession (gateway restart / reconnect) — without it, the second
    // connection's "-turn-1" would land in the SAME server-side session as
    // the first connection's, re-accumulating exactly the history this
    // rotation exists to shed.
    this.turnCounter += 1;
    const turnSessionId = `${this.config.sessionId ?? 'agent-os'}-${this.startedAt}-turn-${this.turnCounter}`;

    const runId = await startRun(this.config, {
      input: `[${msg.senderName ?? msg.senderId}]: ${msg.content}`,
      session_id: turnSessionId,
    });
    this.activeRunId = runId;
    this.ssePump = this.pumpRunEvents(runId);
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
        return {
          challengeId,
          type,
          success: true,
          data: { modelId },
          latencyMs: Date.now() - start,
        };
      }

      if (challenge.type === 'nonce-file') {
        const runId = await startRun(this.config, {
          instructions: NONCE_RUN_INSTRUCTIONS,
          input: `Read the file at this absolute path and return only its contents: ${challenge.noncePath}`,
          session_id: `agent-os-pol-${challenge.challengeId}`,
        });
        const terminal = await waitForRunTerminal(
          this.config,
          runId,
          challenge.timeoutMs,
          undefined
        );
        if (terminal.failed) {
          return {
            challengeId,
            type,
            success: false,
            error: terminal.error ?? 'nonce run failed',
            latencyMs: Date.now() - start,
          };
        }
        const nonce = stripHermesReadFileGutter(terminal.output);
        return {
          challengeId,
          type,
          success: nonce.length > 0,
          data: { nonce },
          latencyMs: Date.now() - start,
        };
      }

      if (challenge.type === 'capability-probe') {
        const res = await fetch(`${baseUrl(this.config)}/v1/capabilities`, {
          headers: authHeaders(this.config),
        });
        const text = (await res.text()).slice(0, 200);
        return {
          challengeId,
          type,
          success: res.ok,
          data: { capability: challenge.capability, result: text },
          latencyMs: Date.now() - start,
        };
      }

      return {
        challengeId,
        type,
        success: false,
        error: 'Unknown challenge type',
        latencyMs: Date.now() - start,
      };
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
    const modelId = await this.fetchModelId();
    const ok = modelId !== 'hermes-unknown';
    return {
      ok,
      latencyMs: Date.now() - t0,
      modelId,
      sessionAgeMs: Date.now() - this.startedAt,
    };
  }

  async interrupt(): Promise<void> {
    if (this.activeRunId) {
      await stopRun(this.config, this.activeRunId);
    }
    this.sseAbort?.abort();
    if (this.ssePump) await this.ssePump.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.interrupt();
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private async fetchModelId(): Promise<string> {
    const res = await fetch(`${baseUrl(this.config)}/v1/models`, {
      headers: authHeaders(this.config),
    });
    if (!res.ok) {
      this.modelId = 'hermes-unknown';
      return this.modelId;
    }
    const json = (await res.json()) as { data?: { id?: string }[] };
    const id = json.data?.[0]?.id ?? 'hermes';
    this.modelId = id;
    return id;
  }
}

export const hermesAdapter: AgentAdapter = {
  manifest: hermesManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const resolved = await resolveHermesAdapterConfig(config);
    const t = resolved.transport as HermesTransportConfig;
    if (!t.apiKey) {
      throw new AdapterError(
        'auth-missing',
        'Hermes API key required',
        'Set transport.keyFile to your Hermes .env (default on connect) or transport.apiKey for remote harnesses.'
      );
    }
    await probeEndpoint(resolved);
    const session = new HermesSession(resolved, Date.now(), 'hermes');
    await session.health();
    return session;
  },
};

/** Identity helper for verifier deps */
export async function getIdentityFromHermesSession(session: AgentSession): Promise<{
  modelId: string;
  accountId?: string;
}> {
  const h = await session.health();
  return { modelId: h.modelId };
}