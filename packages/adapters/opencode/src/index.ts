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
import { opencodeManifest, OPENCODE_MODEL_PATTERN } from './manifest.js';
import {
  cliCommandOf,
  collectStderr,
  finalMessageOf,
  OpencodeJsonEvent,
  spawnOpencodeTurn,
  transportOf,
  turnErrorOf,
} from './cliProcess.js';
import { isExistingFile, isOnPath } from './findBinary.js';

export { opencodeManifest };
export type { OpencodeTransportConfig } from './cliProcess.js';

/**
 * CRITICAL: the OPENCODE SESSION must read the nonce file itself with its
 * own tools. The adapter/gateway process NEVER touches the filesystem for
 * this. Verified live 2026-08-12: `opencode run --format json --auto`
 * issued its own `tool:"read"` call and returned the file contents.
 */
const NONCE_PROMPT = (noncePath: string) =>
  `You are answering a proof-of-life challenge for Agent OS. ` +
  `Read the exact file at this path using your own tools: ${noncePath} ` +
  `Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.`;

function mapOpencodeEventToAgentEvents(ev: OpencodeJsonEvent, messageId: string): AgentEvent[] {
  if (ev.type === 'tool_use' && ev.part?.tool) {
    const tool = ev.part.tool;
    const status = ev.part.state?.status;
    const out: AgentEvent[] = [
      {
        type: 'tool-start',
        tool,
        args: ev.part.state?.input ?? {},
        messageId,
      },
    ];
    if (status === 'completed' || status === 'error') {
      out.push({
        type: 'tool-end',
        tool,
        result: {
          status,
          output: (ev.part.state?.output ?? ev.part.state?.error ?? '').slice(0, 2000),
        },
        messageId,
      });
    }
    return out;
  }

  if (ev.type === 'text' && ev.part?.text) {
    return [{ type: 'token', delta: ev.part.text, messageId }];
  }

  if (ev.type === 'step_finish' && ev.part?.reason === 'stop') {
    const out: AgentEvent[] = [];
    // CONTRACT: usage must precede message-complete, or the relay drops it.
    const usage = ev.part.tokens;
    if (usage) {
      out.push({
        type: 'usage',
        tokensIn: usage.input ?? 0,
        tokensOut: usage.output ?? 0,
        messageId,
      });
    }
    out.push({ type: 'message-complete', messageId });
    return out;
  }

  if (ev.type === 'error') {
    const message = ev.error?.data?.message ?? ev.error?.name ?? 'opencode error';
    return [
      {
        type: 'error',
        code: 'opencode-error',
        message,
        recoverable: true,
        messageId,
      },
      { type: 'message-complete', messageId },
    ];
  }

  return [];
}

class OpencodeSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private sessionId: string | undefined;
  private activeChild: ReturnType<typeof spawnOpencodeTurn>['child'] | null = null;
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
  ): Promise<{ events: OpencodeJsonEvent[]; exitCode: number | null; stderr: string }> {
    const invocation = spawnOpencodeTurn(this.config, {
      prompt,
      resumeSessionId: this.sessionId,
    });
    this.activeChild = invocation.child;
    const stderrCollector = collectStderr(invocation.child);

    const collected: OpencodeJsonEvent[] = [];
    try {
      for await (const ev of invocation.events) {
        collected.push(ev);
        this.enqueue(...mapOpencodeEventToAgentEvents(ev, messageId));
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
    if (this.disposed) throw new Error('OpenCode session disposed');
    await this.sendGate.enter('OpenCode session busy — gateway must serialize sends per agent');
    const messageId = `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    this.sendGate.attach(
      (async () => {
        try {
          const { events, exitCode, stderr } = await this.runTurn(prompt, messageId);
          if (exitCode !== 0 && exitCode !== null && !finalMessageOf(events)) {
            this.enqueue({
              type: 'error',
              code: 'cli-exit',
              message: `opencode exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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
        const { events, exitCode, stderr } = await this.runTurn(
          NONCE_PROMPT(challenge.noncePath),
          `pol-${challengeId}`
        );
        const failure = turnErrorOf(events);
        if (failure) {
          return {
            challengeId,
            type,
            success: false,
            error: failure.slice(0, 300),
            latencyMs: Date.now() - start,
          };
        }
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `opencode exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
            latencyMs: Date.now() - start,
          };
        }
        const nonce = (finalMessageOf(events) ?? '').trim();
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
          'List the files in your current working directory using your shell tool ' +
            '(bash / Get-ChildItem) and reply with ONLY the name of one file or directory you see.',
          `probe-${challengeId}`
        );
        const failure = turnErrorOf(events);
        if (failure) {
          return {
            challengeId,
            type,
            success: false,
            error: failure.slice(0, 300),
            latencyMs: Date.now() - start,
          };
        }
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `opencode exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
            latencyMs: Date.now() - start,
          };
        }
        const text = (finalMessageOf(events) ?? '').trim();
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

  /**
   * Identity is config-pinned (see OPENCODE_MODEL_PATTERN). The session's
   * own answer only overrides the pin when it parses as a real listed id.
   */
  private async fetchModelId(): Promise<string> {
    const { events, exitCode } = await this.runTurn(
      'Reply with ONLY your model identifier (for example opencode/ling-3.0-tiny-free), nothing else.',
      `identity-${Date.now().toString(36)}`
    );
    if (exitCode !== 0 && exitCode !== null) return this.modelId;
    const answer = (finalMessageOf(events) ?? '').trim().split(/\s+/)[0] ?? '';
    if (
      answer &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(answer) &&
      new RegExp(OPENCODE_MODEL_PATTERN).test(answer)
    ) {
      this.modelId = answer;
    }
    return this.modelId;
  }
}

/**
 * Auth-failure classifier, deliberately narrow. Judge from the turn's own
 * error only — never from `opencode providers list` (which reported
 * 0 credentials on 2026-08-12 while free `opencode/*` models still
 * answered) and never from unrelated stderr.
 */
export function isAuthFailure(text: string | undefined): boolean {
  if (!text) return false;
  const lines = text
    .toLowerCase()
    .split('\n')
    .filter((l) => !l.includes('rmcp') && !l.includes('mcp'));
  return lines.some(
    (l) =>
      l.includes('not logged in') ||
      l.includes('please log in') ||
      l.includes('login required') ||
      l.includes('providers login') ||
      l.includes('no credentials') ||
      l.includes('not authenticated')
  );
}

async function verifyBinaryAndAuth(
  config: AdapterConfig
): Promise<{ modelId: string; sessionId?: string }> {
  const cmd = cliCommandOf(config);
  const found = isExistingFile(cmd) || (await isOnPath(cmd));
  if (!found) {
    throw new AdapterError(
      'binary-not-found',
      `'${cmd}' was not found (checked as file path and on PATH)`,
      'Install opencode (npm install -g opencode-ai) so `opencode` is on PATH, then retry.'
    );
  }

  const invocation = spawnOpencodeTurn(config, {
    prompt: 'Reply with ONLY the word OK.',
  });
  const stderrCollector = collectStderr(invocation.child);
  const events: OpencodeJsonEvent[] = [];
  try {
    for await (const ev of invocation.events) {
      events.push(ev);
    }
  } catch (e) {
    throw new AdapterError(
      'handshake-failed',
      `OpenCode CLI invocation failed: ${e instanceof Error ? e.message : String(e)}`,
      'Check that the opencode CLI runs correctly from a terminal, then retry.'
    );
  }

  const [sessionId, exitCode] = await Promise.all([invocation.sessionId, invocation.exitCode]);
  const stderr = stderrCollector.text();
  const failure = turnErrorOf(events);
  const answered = finalMessageOf(events);

  // A REAL answer settles it. Do not sniff stderr for auth words first —
  // Codex's MCP 401 taught that lesson; reuse it here.
  if (answered && !failure && (exitCode === 0 || exitCode === null)) {
    const pinned = transportOf(config).model?.trim();
    return { modelId: pinned && new RegExp(OPENCODE_MODEL_PATTERN).test(pinned) ? pinned : 'opencode/ling-3.0-tiny-free', sessionId };
  }

  if (isAuthFailure(failure) || (!answered && isAuthFailure(stderr))) {
    throw new AdapterError(
      'auth-missing',
      `OpenCode CLI is not authenticated${failure ? `: ${failure.slice(0, 200)}` : ''}`,
      'Run `opencode auth login` once outside this app to sign in to a provider. Agents must never enter credentials.'
    );
  }

  if (failure) {
    throw new AdapterError(
      'handshake-failed',
      `OpenCode CLI reported an error: ${failure.slice(0, 300)}`,
      `A wrong or unprovisioned transport.model is the usual cause. Run the same '${cmd} run --format json' command from a terminal.`
    );
  }

  if (exitCode !== 0 && exitCode !== null) {
    throw new AdapterError(
      'handshake-failed',
      `OpenCode CLI exited with code ${exitCode}: ${stderr.slice(0, 300)}`,
      'Run the same command from a terminal to see the full error.'
    );
  }

  if (!answered) {
    throw new AdapterError(
      'handshake-failed',
      'OpenCode CLI produced no text event on --format json output',
      `Confirm '${cmd} run --format json -m opencode/ling-3.0-tiny-free "hi"' works from a terminal.`
    );
  }

  const pinned = transportOf(config).model?.trim();
  return { modelId: pinned ?? 'opencode/ling-3.0-tiny-free', sessionId };
}

export const opencodeAdapter: AgentAdapter = {
  manifest: opencodeManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const { modelId, sessionId } = await verifyBinaryAndAuth(config);
    return new OpencodeSession(config, Date.now(), modelId, sessionId);
  },
};

export async function getIdentityFromOpencodeSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
