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
import { claudeCodeManifest } from './manifest.js';
import {
  cliCommandOf,
  ClaudeStreamJsonEvent,
  collectStderr,
  spawnClaudeTurn,
} from './cliProcess.js';
import { isExistingFile, isOnPath } from './findBinary.js';

export { claudeCodeManifest };
export type { ClaudeCodeTransportConfig } from './cliProcess.js';

/**
 * CRITICAL (per gate-blocker 1 precedent on the Hermes adapter): the CLAUDE CODE
 * SESSION must read the nonce file itself via its own tools. The adapter/gateway
 * process NEVER touches the filesystem for this — that is the painted-status hole
 * that failed review round 2. We prompt the CLI turn to read the file and restrict
 * tools to Read only, so a bare LLM completion without real file access cannot pass.
 */
const NONCE_RUN_INSTRUCTIONS = (noncePath: string) =>
  `You are answering a proof-of-life challenge for Agent OS. ` +
  `Use the Read tool to read the exact file at this path: ${noncePath} ` +
  `Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.`;

function extractText(ev: ClaudeStreamJsonEvent): string | undefined {
  if (ev.type === 'result' && typeof ev.result === 'string') return ev.result;
  const content = ev.message?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (text) return text;
  }
  return undefined;
}

function mapStreamEventToAgentEvents(ev: ClaudeStreamJsonEvent, messageId: string): AgentEvent[] {
  // Token-level deltas (streaming partial assistant text), when the CLI emits them.
  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
    return [{ type: 'token', delta: ev.delta.text, messageId }];
  }

  if (ev.type === 'assistant' && ev.message) {
    const out: AgentEvent[] = [];
    for (const block of ev.message.content ?? []) {
      if (block.type === 'text' && block.text) {
        out.push({ type: 'token', delta: block.text, messageId });
      } else if (block.type === 'tool_use') {
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

  if (ev.type === 'user' && ev.message) {
    // tool_result blocks come back on a synthetic "user" event in stream-json
    const out: AgentEvent[] = [];
    for (const block of ev.message.content ?? []) {
      if (block.type === 'tool_result') {
        out.push({
          type: 'tool-end',
          tool: block.tool_use_id ?? 'tool',
          result: block.content ?? null,
          messageId,
        });
      }
    }
    return out;
  }

  if (ev.type === 'result') {
    const out: AgentEvent[] = [];
    if (ev.is_error) {
      out.push({
        type: 'error',
        code: ev.subtype ?? 'result-error',
        message: typeof ev.result === 'string' ? ev.result : ev.error ?? 'Claude Code run failed',
        recoverable: true,
        messageId,
      });
    }
    // CONTRACT: usage must precede message-complete, or the relay drops it
    // (AgentRelayWorker.handleEvent reads pendingUsage during
    // commitAgentReply, which only fires on message-complete; runOne's
    // finally nulls this.current right after, so a later usage is dropped).
    const usage = ev.usage ?? ev.message?.usage;
    if (usage) {
      out.push({
        type: 'usage',
        tokensIn: usage.input_tokens ?? 0,
        tokensOut: usage.output_tokens ?? 0,
        messageId,
      });
    }
    out.push({ type: 'message-complete', messageId });
    return out;
  }

  return [];
}

class ClaudeCodeSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private sessionId: string | undefined;
  private activeChild: ReturnType<typeof spawnClaudeTurn>['child'] | null = null;
  /** Q7: the hand-rolled busy-wait send gate, owned once in @agent-os/shared instead of duplicated per adapter. Same grace-wait-then-throw semantics as before. */
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
    messageId: string,
    opts: { allowedTools?: string[]; systemPrompt?: string } = {}
  ): Promise<{ events: ClaudeStreamJsonEvent[]; exitCode: number | null; stderr: string }> {
    const invocation = spawnClaudeTurn(this.config, {
      prompt,
      resumeSessionId: this.sessionId,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
    });
    this.activeChild = invocation.child;
    const stderrCollector = collectStderr(invocation.child);

    const collected: ClaudeStreamJsonEvent[] = [];
    try {
      for await (const ev of invocation.events) {
        collected.push(ev);
        this.enqueue(...mapStreamEventToAgentEvents(ev, messageId));
      }
    } finally {
      this.activeChild = null;
    }

    const [resolvedSessionId, exitCode] = await Promise.all([invocation.sessionId, invocation.exitCode]);
    if (resolvedSessionId) this.sessionId = resolvedSessionId;

    return { events: collected, exitCode, stderr: stderrCollector.text() };
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.disposed) throw new Error('Claude Code session disposed');
    // Q7: grace-wait-then-throw, now owned by BusySendGate (packages/shared)
    // instead of hand-rolled here — same semantics, see its class doc
    // comment for why (2026-07-04 grok-build busy-race).
    await this.sendGate.enter('Claude Code session busy — gateway must serialize sends per agent');
    const messageId = `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    this.sendGate.attach(
      (async () => {
        try {
          const { exitCode, stderr } = await this.runTurn(prompt, messageId);
          if (exitCode !== 0 && exitCode !== null) {
            this.enqueue({
              type: 'error',
              code: 'cli-exit',
              message: `claude exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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
        // The CLAUDE CODE SESSION reads the file itself — restrict tools to Read
        // only so a bare completion (no real filesystem access) cannot pass.
        const { events, exitCode, stderr } = await this.runTurn(
          `Read the file at this absolute path and return only its contents: ${challenge.noncePath}`,
          `pol-${challengeId}`,
          {
            allowedTools: ['Read'],
            systemPrompt: NONCE_RUN_INSTRUCTIONS(challenge.noncePath),
          }
        );
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `claude exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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
        // Exercise the CLI's real tool access: list the workspace directory and
        // return a named file, proving actual filesystem tool use (not a bare API).
        const { events, exitCode, stderr } = await this.runTurn(
          'List the files in your current working directory using the Bash tool ' +
            '(command: dir on Windows or ls elsewhere) and reply with ONLY the name of one file or directory you see.',
          `probe-${challengeId}`,
          { allowedTools: ['Bash'] }
        );
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `claude exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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

  /**
   * G2b reference emitter. Derived from
   * dispatch state this session already tracks for interrupt() — activeChild is
   * non-null only while a real CLI turn is running. No harness cooperation, no
   * fabricated verbs: undefined when idle, so the UI falls back to board/last-said.
   */
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
    // Cheap: ask the session what model it is running as, from inside itself.
    const { events, exitCode } = await this.runTurn(
      'Reply with ONLY your model identifier (e.g. claude-sonnet-4-5, claude-opus-4, etc), nothing else.',
      `identity-${Date.now().toString(36)}`,
      { allowedTools: [] }
    );
    if (exitCode !== 0 && exitCode !== null) return this.modelId;
    const resultEvent = events.find((e) => e.type === 'result');
    const text = (resultEvent ? extractText(resultEvent) : undefined)?.trim();
    if (text) this.modelId = text.split(/\s+/)[0] ?? this.modelId;
    return this.modelId;
  }
}

async function verifyBinaryAndAuth(config: AdapterConfig): Promise<{ modelId: string; sessionId?: string }> {
  const cmd = cliCommandOf(config);
  // cmd may be a concrete file path (desktop-app bundle or transport
  // override) — only fall back to PATH resolution for bare names.
  const found = isExistingFile(cmd) || (await isOnPath(cmd));
  if (!found) {
    throw new AdapterError(
      'binary-not-found',
      `'${cmd}' was not found (checked as file path and on PATH)`,
      `Install the Claude Code CLI (desktop app, or npm install -g @anthropic-ai/claude-code) and log in once outside this app.`
    );
  }

  // One cheap real invocation to confirm the local login/auth works.
  const invocation = spawnClaudeTurn(config, {
    prompt: 'Reply with ONLY the word OK.',
    allowedTools: [],
  });
  const stderrCollector = collectStderr(invocation.child);
  let resultText: string | undefined;
  let sawResult = false;
  try {
    for await (const ev of invocation.events) {
      if (ev.type === 'result') {
        sawResult = true;
        resultText = extractText(ev);
        if (ev.is_error) {
          const msg = typeof ev.result === 'string' ? ev.result : ev.error ?? 'unknown error';
          throw new AdapterError(
            'auth-missing',
            `Claude Code CLI reported an error: ${msg}`,
            `Run '${cmd} login' once outside this app to authenticate the local session, then retry connect.`
          );
        }
      }
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw new AdapterError(
      'handshake-failed',
      `Claude Code CLI invocation failed: ${e instanceof Error ? e.message : String(e)}`,
      'Check that the claude CLI runs correctly from a terminal, then retry.'
    );
  }

  const [sessionId, exitCode] = await Promise.all([invocation.sessionId, invocation.exitCode]);
  const stderr = stderrCollector.text();

  if (exitCode !== 0 && exitCode !== null) {
    const combined = `${stderr} ${resultText ?? ''}`.toLowerCase();
    if (
      combined.includes('login') ||
      combined.includes('auth') ||
      combined.includes('not authenticated') ||
      combined.includes('unauthorized')
    ) {
      throw new AdapterError(
        'auth-missing',
        `Claude Code CLI is not authenticated (exit ${exitCode})`,
        `Run '${cmd} login' once outside this app to authenticate, then retry connect.`
      );
    }
    throw new AdapterError(
      'handshake-failed',
      `Claude Code CLI exited with code ${exitCode}: ${stderr.slice(0, 300)}`,
      'Run the same command from a terminal to see the full error.'
    );
  }

  if (!sawResult) {
    throw new AdapterError(
      'handshake-failed',
      'Claude Code CLI produced no result event on stream-json output',
      `Confirm '${cmd} -p "hi" --output-format stream-json' works from a terminal.`
    );
  }

  return { modelId: 'claude-code', sessionId };
}

export const claudeCodeAdapter: AgentAdapter = {
  manifest: claudeCodeManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const { modelId, sessionId } = await verifyBinaryAndAuth(config);
    return new ClaudeCodeSession(config, Date.now(), modelId, sessionId);
  },
};

/** Identity helper for verifier deps — reports model id from inside the session itself. */
export async function getIdentityFromClaudeCodeSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
