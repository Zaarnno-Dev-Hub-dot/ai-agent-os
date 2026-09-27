import {
  AdapterConfig,
  AdapterError,
  AgentActivity,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  BusySendGate,
  Challenge,
  ChallengeResponse,
  ChallengeType,
  HealthReport,
  OutboundMessage,
} from '@agent-os/shared';
import { cursorManifest } from './manifest.js';
import {
  cliCommandOf,
  collectStderr,
  extractText,
  spawnCursorTurn,
  type CursorStreamJsonEvent,
  toWslPath,
  transportOf,
} from './cliProcess.js';
import { isExistingFile, isOnPath, wslAgentAvailable } from './findBinary.js';

export { cursorManifest };
export type { CursorTransportConfig } from './cliProcess.js';
export { buildArgs, toWslPath, applyCursorAuthEnv } from './cliProcess.js';

/**
 * CRITICAL: the CURSOR SESSION must read the nonce file itself via its own
 * tools. The adapter/gateway process NEVER touches the filesystem for PoL —
 * that is the painted-status hole that failed prior reviews.
 */
const NONCE_RUN_INSTRUCTIONS = (noncePath: string) =>
  `You are answering a proof-of-life challenge for Agent OS. ` +
  `Use your Read/file tool to read the exact file at this path: ${noncePath} ` +
  `Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.`;

function mapStreamEventToAgentEvents(ev: CursorStreamJsonEvent, messageId: string): AgentEvent[] {
  if (ev.type === 'assistant' && ev.message) {
    const out: AgentEvent[] = [];
    for (const block of ev.message.content ?? []) {
      if ((block.type === 'text' || block.type === 'output_text') && block.text) {
        out.push({ type: 'token', delta: block.text, messageId });
      } else if (block.type === 'tool_use' || block.type === 'tool_call') {
        out.push({
          type: 'tool-start',
          tool: block.name ?? 'tool',
          args: block.input ?? {},
          messageId,
        });
      }
    }
    return out;
  }

  if (ev.type === 'tool_call' || ev.type === 'tool-call') {
    const name =
      (typeof (ev as { name?: string }).name === 'string' && (ev as { name?: string }).name) ||
      'tool';
    return [{ type: 'tool-start', tool: name, args: {}, messageId }];
  }

  if (ev.type === 'result') {
    const out: AgentEvent[] = [];
    if (ev.is_error) {
      const errMsg =
        typeof ev.result === 'string'
          ? ev.result
          : typeof ev.error === 'string'
            ? ev.error
            : ev.error && typeof ev.error === 'object' && 'message' in ev.error
              ? String((ev.error as { message?: string }).message ?? 'Cursor Agent run failed')
              : 'Cursor Agent run failed';
      out.push({
        type: 'error',
        code: ev.subtype ?? 'result-error',
        message: errMsg,
        recoverable: true,
        messageId,
      });
    }
    const usage = ev.usage ?? ev.message?.usage;
    if (usage) {
      const u = usage as {
        input_tokens?: number;
        output_tokens?: number;
        inputTokens?: number;
        outputTokens?: number;
      };
      out.push({
        type: 'usage',
        tokensIn: u.input_tokens ?? u.inputTokens ?? 0,
        tokensOut: u.output_tokens ?? u.outputTokens ?? 0,
        messageId,
      });
    }
    out.push({ type: 'message-complete', messageId });
    return out;
  }

  return [];
}

export function isAuthFailure(text: string): boolean {
  return /authentication\s+required|not\s+authenticated|not\s+logged\s+in|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|cursor[_\s-]?api[_\s-]?key|permission_denied|run\s+'?agent\s+login'?/i.test(
    text
  );
}

class CursorSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private sessionId: string | undefined;
  private activeChild: ReturnType<typeof spawnCursorTurn>['child'] | null = null;
  private readonly sendGate = new BusySendGate();

  constructor(
    private readonly config: AdapterConfig,
    private readonly startedAt: number,
    private modelId: string,
    initialSessionId: string | undefined
  ) {
    this.sessionId = initialSessionId;
  }

  private enqueue(...events: AgentEvent[]) {
    if (this.disposed || events.length === 0) return;
    this.queue.push(...events);
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private async runTurn(
    prompt: string,
    messageId: string
  ): Promise<{ events: CursorStreamJsonEvent[]; exitCode: number | null; stderr: string }> {
    const invocation = spawnCursorTurn(this.config, {
      prompt,
      resumeSessionId: this.sessionId,
    });
    this.activeChild = invocation.child;
    const stderrCollector = collectStderr(invocation.child);

    const collected: CursorStreamJsonEvent[] = [];
    try {
      for await (const ev of invocation.events) {
        collected.push(ev);
        this.enqueue(...mapStreamEventToAgentEvents(ev, messageId));
      }
    } finally {
      this.activeChild = null;
    }

    const [resolvedSessionId, exitCode] = await Promise.all([
      invocation.sessionId,
      invocation.exitCode,
    ]);
    if (resolvedSessionId) this.sessionId = resolvedSessionId;

    return { events: collected, exitCode, stderr: stderrCollector.text() };
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.disposed) throw new Error('Cursor session disposed');
    await this.sendGate.enter('Cursor session busy — gateway must serialize sends per agent');
    const messageId = `cur-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    this.sendGate.attach(
      (async () => {
        try {
          const { exitCode, stderr } = await this.runTurn(prompt, messageId);
          if (exitCode !== 0 && exitCode !== null) {
            this.enqueue({
              type: 'error',
              code: 'cli-exit',
              message: `cursor agent exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
              recoverable: true,
              messageId,
            });
          }
        } catch (e) {
          this.enqueue({
            type: 'error',
            code: 'cli-spawn',
            message: e instanceof Error ? e.message : String(e),
            recoverable: true,
            messageId,
          });
        } finally {
          this.sendGate.release();
        }
      })()
    );
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
        // Path the Linux agent can open when launched via WSL.
        const winPath = challenge.noncePath;
        const agentPath =
          process.platform === 'win32' && transportOf(this.config).useWsl !== false
            ? toWslPath(winPath)
            : winPath;
        const prompt =
          NONCE_RUN_INSTRUCTIONS(agentPath) +
          `\nAbsolute path: ${agentPath}\n` +
          `If that path fails, also try the Windows path: ${winPath}`;
        const { events, exitCode, stderr } = await this.runTurn(prompt, `pol-${challengeId}`);
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `cursor agent exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
            latencyMs: Date.now() - start,
          };
        }
        const resultEvent = events.find((e) => e.type === 'result');
        const text = resultEvent ? extractText(resultEvent) : undefined;
        const nonce = (text ?? '').trim();
        return {
          challengeId,
          type,
          success: nonce.length > 0,
          data: { nonce, text: nonce },
          latencyMs: Date.now() - start,
        };
      }

      if (challenge.type === 'capability-probe') {
        const { events, exitCode, stderr } = await this.runTurn(
          'List files in the workspace with your shell tool (ls or dir) and reply with ONLY the name of one file or directory you see.',
          `probe-${challengeId}`
        );
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `cursor agent exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
            latencyMs: Date.now() - start,
          };
        }
        const resultEvent = events.find((e) => e.type === 'result');
        const text = (resultEvent ? extractText(resultEvent) : undefined)?.trim() ?? '';
        return {
          challengeId,
          type,
          success: text.length > 0,
          data: { capability: challenge.capability, result: text.slice(0, 500) },
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
    return {
      ok: !this.disposed,
      latencyMs: Date.now() - t0,
      modelId: this.modelId,
      sessionAgeMs: Date.now() - this.startedAt,
    };
  }

  async activity(): Promise<AgentActivity | undefined> {
    if (!this.activeChild) return undefined;
    return { verb: 'processing turn', at: Date.now() };
  }

  async interrupt(): Promise<void> {
    if (this.activeChild) {
      this.activeChild.kill('SIGTERM');
    }
    if (this.sendGate.current) await this.sendGate.current.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.interrupt();
    const wake = this.waiters.splice(0);
    for (const w of wake) w();
  }

  private async fetchModelId(): Promise<string> {
    const pinned = transportOf(this.config).model?.trim();
    if (pinned) {
      this.modelId = pinned;
      return this.modelId;
    }
    const { events, exitCode } = await this.runTurn(
      'Reply with ONLY your model identifier string, nothing else.',
      `identity-${Date.now().toString(36)}`
    );
    if (exitCode !== 0 && exitCode !== null) return this.modelId;
    const resultEvent = events.find((e) => e.type === 'result');
    const text = (resultEvent ? extractText(resultEvent) : undefined)?.trim();
    if (text) this.modelId = text.split(/\s+/)[0] ?? this.modelId;
    // Prefer model field on init/result if present
    for (const ev of events) {
      if (typeof ev.model === 'string' && ev.model.trim()) {
        this.modelId = ev.model.trim();
        break;
      }
      if (typeof ev.message?.model === 'string' && ev.message.model.trim()) {
        this.modelId = ev.message.model.trim();
        break;
      }
    }
    return this.modelId;
  }
}

async function verifyBinaryAndAuth(
  config: AdapterConfig
): Promise<{ modelId: string; sessionId?: string }> {
  const cmd = cliCommandOf(config);
  const nativeFound = isExistingFile(cmd) || (await isOnPath(cmd));
  const wslOk = await wslAgentAvailable();
  if (!nativeFound && !wslOk) {
    throw new AdapterError(
      'binary-not-found',
      `'${cmd}' was not found (Windows path/PATH) and WSL agent is unavailable`,
      `Install Cursor Agent CLI: in WSL run curl https://cursor.com/install -fsS | bash. Then set CURSOR_API_KEY in your environment or run 'agent login' (inside WSL on Windows).`
    );
  }

  const modelHint = transportOf(config).model?.trim() || 'auto';
  const invocation = spawnCursorTurn(config, {
    prompt: 'Reply with ONLY the word OK.',
  });
  const stderrCollector = collectStderr(invocation.child);
  let resultText: string | undefined;
  let sawResult = false;
  let modelFromStream: string | undefined;

  try {
    for await (const ev of invocation.events) {
      if (typeof ev.model === 'string' && ev.model.trim()) modelFromStream = ev.model.trim();
      if (typeof ev.message?.model === 'string' && ev.message.model.trim()) {
        modelFromStream = ev.message.model.trim();
      }
      if (ev.type === 'result') {
        sawResult = true;
        resultText = extractText(ev);
        if (ev.is_error) {
          const msg =
            typeof ev.result === 'string'
              ? ev.result
              : typeof ev.error === 'string'
                ? ev.error
                : 'unknown error';
          if (isAuthFailure(msg)) {
            throw new AdapterError(
              'auth-missing',
              `Cursor Agent CLI reported auth error: ${msg}`,
              `Set CURSOR_API_KEY in your environment or run 'agent login' (inside WSL on Windows), then retry connect.`
            );
          }
          throw new AdapterError(
            'handshake-failed',
            `Cursor Agent CLI reported an error: ${msg}`,
            'Run the same agent -p command from a terminal to see the full error.'
          );
        }
      }
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw new AdapterError(
      'handshake-failed',
      `Cursor Agent CLI invocation failed: ${e instanceof Error ? e.message : String(e)}`,
      'Check that wsl agent -p "hi" --output-format stream-json works from a terminal.'
    );
  }

  const [sessionId, exitCode] = await Promise.all([invocation.sessionId, invocation.exitCode]);
  const stderr = stderrCollector.text();
  const combined = `${stderr} ${resultText ?? ''}`;

  if (exitCode !== 0 && exitCode !== null) {
    if (isAuthFailure(combined)) {
      throw new AdapterError(
        'auth-missing',
        `Cursor Agent CLI is not authenticated (exit ${exitCode})`,
        `Set CURSOR_API_KEY in your environment or run 'agent login' (inside WSL on Windows), then retry.`
      );
    }
    throw new AdapterError(
      'handshake-failed',
      `Cursor Agent CLI exited with code ${exitCode}: ${stderr.slice(0, 300)}`,
      'Run the same command from a terminal to see the full error.'
    );
  }

  if (!sawResult) {
    throw new AdapterError(
      'handshake-failed',
      'Cursor Agent CLI produced no result event on stream-json output',
      `Confirm 'wsl agent -p "hi" --output-format stream-json --yolo' works.`
    );
  }

  return { modelId: modelFromStream || modelHint, sessionId };
}

export const cursorAdapter: AgentAdapter = {
  manifest: cursorManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    // Default pin so identity.modelPattern always has a legal config-pinned id
    // even when the stream omits model (same honesty as Codex/opencode).
    const t = { ...(config.transport ?? {}) } as Record<string, unknown>;
    if (typeof t.model !== 'string' || !String(t.model).trim()) {
      t.model = 'auto';
    }
    if (t.useWsl === undefined && process.platform === 'win32') {
      t.useWsl = true;
    }
    const cfg: AdapterConfig = { ...config, transport: t };
    const { modelId, sessionId } = await verifyBinaryAndAuth(cfg);
    return new CursorSession(cfg, Date.now(), modelId, sessionId);
  },
};

export async function getIdentityFromCursorSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
