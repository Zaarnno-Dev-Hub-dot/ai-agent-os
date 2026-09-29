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
import { codexManifest, CODEX_MODEL_PATTERN } from './manifest.js';
import {
  cliCommandOf,
  CodexJsonEvent,
  collectStderr,
  finalMessageOf,
  parseModelSpec,
  spawnCodexTurn,
  transportOf,
  turnErrorOf,
} from './cliProcess.js';
import { isExistingFile, isOnPath } from './findBinary.js';

export { codexManifest };
export type { CodexTransportConfig } from './cliProcess.js';

/**
 * CRITICAL: the CODEX SESSION must read
 * the nonce file itself with its own tools. The adapter/gateway process NEVER
 * touches the filesystem for this. Verified live 2026-08-08: the CLI answered
 * a nonce challenge by issuing its own `Get-Content` shell call under a
 * read-only sandbox and returning the contents — real tool use, not a
 * completion.
 */
const NONCE_PROMPT = (noncePath: string) =>
  `You are answering a proof-of-life challenge for Agent OS. ` +
  `Read the exact file at this path using your own tools: ${noncePath} ` +
  `Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.`;

function mapCodexEventToAgentEvents(ev: CodexJsonEvent, messageId: string): AgentEvent[] {
  if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
    return [
      {
        type: 'tool-start',
        tool: 'shell',
        args: { command: ev.item.command ?? '' },
        messageId,
      },
    ];
  }

  if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
    return [
      {
        type: 'tool-end',
        tool: 'shell',
        result: {
          exitCode: ev.item.exit_code ?? null,
          output: (ev.item.aggregated_output ?? '').slice(0, 2000),
        },
        messageId,
      },
    ];
  }

  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
    return [{ type: 'token', delta: ev.item.text, messageId }];
  }

  if (ev.type === 'item.completed' && ev.item?.type === 'error' && ev.item.message) {
    // Non-fatal CLI notices arrive as completed items of type 'error' (e.g.
    // unknown-model metadata warnings). Surfaced as recoverable; the turn may
    // still produce a real answer, and turn.failed covers the fatal case.
    return [
      {
        type: 'error',
        code: 'codex-notice',
        message: ev.item.message,
        recoverable: true,
        messageId,
      },
    ];
  }

  if (ev.type === 'turn.completed') {
    const out: AgentEvent[] = [];
    // CONTRACT: usage must precede message-complete, or the relay drops it
    // (AgentRelayWorker.handleEvent reads pendingUsage during
    // commitAgentReply, which only fires on message-complete). Same ordering
    // invariant the claude-code adapter documents.
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

  if (ev.type === 'turn.failed') {
    return [
      {
        type: 'error',
        code: 'turn-failed',
        message: ev.error?.message ?? 'codex turn failed',
        recoverable: true,
        messageId,
      },
      { type: 'message-complete', messageId },
    ];
  }

  return [];
}

class CodexSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private sessionId: string | undefined;
  private activeChild: ReturnType<typeof spawnCodexTurn>['child'] | null = null;
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
    opts: { sandboxOverride?: string } = {}
  ): Promise<{ events: CodexJsonEvent[]; exitCode: number | null; stderr: string }> {
    const invocation = spawnCodexTurn(this.config, {
      prompt,
      resumeSessionId: this.sessionId,
      sandboxOverride: opts.sandboxOverride,
    });
    this.activeChild = invocation.child;
    const stderrCollector = collectStderr(invocation.child);

    const collected: CodexJsonEvent[] = [];
    try {
      for await (const ev of invocation.events) {
        collected.push(ev);
        this.enqueue(...mapCodexEventToAgentEvents(ev, messageId));
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
    if (this.disposed) throw new Error('Codex session disposed');
    await this.sendGate.enter('Codex session busy — gateway must serialize sends per agent');
    const messageId = `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    this.sendGate.attach(
      (async () => {
        try {
          const { exitCode, stderr } = await this.runTurn(prompt, messageId);
          if (exitCode !== 0 && exitCode !== null) {
            this.enqueue({
              type: 'error',
              code: 'cli-exit',
              message: `codex exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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
        // read-only sandbox: proving tool access never requires write access.
        const { events, exitCode, stderr } = await this.runTurn(
          NONCE_PROMPT(challenge.noncePath),
          `pol-${challengeId}`,
          { sandboxOverride: 'read-only' }
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
            error: `codex exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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
        // Exercise real tool access: list the workspace dir with the CLI's own
        // shell tool and name one entry. A bare completion cannot answer this.
        const { events, exitCode, stderr } = await this.runTurn(
          'List the files in your current working directory using your shell tool ' +
            '(Get-ChildItem on Windows, ls elsewhere) and reply with ONLY the name of one file or directory you see.',
          `probe-${challengeId}`,
          { sandboxOverride: 'read-only' }
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
            error: `codex exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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

  /** Same derived-from-dispatch-state emitter as claude-code: no fabricated verbs. */
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
   * Identity, honestly scoped — see CODEX_MODEL_PATTERN's doc comment. The
   * pinned transport model is the baseline; the session's own answer only
   * overrides it when it PARSES as a plausible model id AND matches the
   * manifest pattern. A model that answers "I'm an agent based on GPT-5" (the
   * Codex system prompt's own phrasing) therefore leaves the pinned value
   * intact rather than corrupting it with prose.
   */
  private async fetchModelId(): Promise<string> {
    const { events, exitCode } = await this.runTurn(
      'Reply with ONLY your model identifier (for example gpt-5.6-terra), nothing else.',
      `identity-${Date.now().toString(36)}`,
      { sandboxOverride: 'read-only' }
    );
    if (exitCode !== 0 && exitCode !== null) return this.modelId;
    const answer = (finalMessageOf(events) ?? '').trim().split(/\s+/)[0] ?? '';
    if (answer && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(answer) && new RegExp(CODEX_MODEL_PATTERN).test(answer)) {
      this.modelId = answer;
    }
    return this.modelId;
  }
}

/**
 * Auth-failure classifier, deliberately narrow (see verifyBinaryAndAuth).
 * Matches only phrasings Codex itself uses for a signed-out CLI, and ignores
 * any line mentioning MCP transports — those carry their own upstream 401s
 * that say nothing about whether Codex is logged in.
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
      l.includes('run `codex login`') ||
      l.includes("run 'codex login'") ||
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
      `Install the Codex desktop app (bundles the CLI at %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<build>\\codex.exe) or the standalone codex CLI, and sign in once outside this app.`
    );
  }

  // One cheap real invocation to confirm the local login/auth works.
  const invocation = spawnCodexTurn(config, {
    prompt: 'Reply with ONLY the word OK.',
    sandboxOverride: 'read-only',
  });
  const stderrCollector = collectStderr(invocation.child);
  const events: CodexJsonEvent[] = [];
  try {
    for await (const ev of invocation.events) {
      events.push(ev);
    }
  } catch (e) {
    throw new AdapterError(
      'handshake-failed',
      `Codex CLI invocation failed: ${e instanceof Error ? e.message : String(e)}`,
      'Check that the codex CLI runs correctly from a terminal, then retry.'
    );
  }

  const [sessionId, exitCode] = await Promise.all([invocation.sessionId, invocation.exitCode]);
  const stderr = stderrCollector.text();
  const failure = turnErrorOf(events);
  const answered = finalMessageOf(events);

  // A REAL answer settles it: the CLI ran a turn against a live account.
  //
  // Do NOT sniff stderr for auth words before this point. Codex writes
  // unrelated diagnostics to stderr on every run — including
  // `rmcp::transport::worker: ... HTTP 401 Unauthorized` from configured MCP
  // servers, and skill-parse errors — and an earlier version of this function
  // matched that 401 and reported a perfectly authenticated seat as
  // 'auth-missing' (caught live on the first connect attempt, 2026-08-08).
  // Auth is judged ONLY from the CLI's own turn failure, and only when the
  // turn produced no answer at all.
  if (answered && !failure && (exitCode === 0 || exitCode === null)) {
    const pinnedOk = parseModelSpec(transportOf(config).model).model;
    return { modelId: pinnedOk ?? 'codex', sessionId };
  }

  if (isAuthFailure(failure) || (!answered && isAuthFailure(stderr))) {
    throw new AdapterError(
      'auth-missing',
      `Codex CLI is not authenticated${failure ? `: ${failure.slice(0, 200)}` : ''}`,
      `Run '${cmd} login' once outside this app to authenticate, then retry connect.`
    );
  }

  if (failure) {
    throw new AdapterError(
      'handshake-failed',
      `Codex CLI reported an error: ${failure.slice(0, 300)}`,
      `A wrong or unprovisioned transport.model is the usual cause — the CLI says so explicitly. Run the same '${cmd} exec' command from a terminal to see the full error.`
    );
  }

  if (exitCode !== 0 && exitCode !== null) {
    throw new AdapterError(
      'handshake-failed',
      `Codex CLI exited with code ${exitCode}: ${stderr.slice(0, 300)}`,
      'Run the same command from a terminal to see the full error.'
    );
  }

  if (!finalMessageOf(events)) {
    throw new AdapterError(
      'handshake-failed',
      'Codex CLI produced no agent_message on --json output',
      `Confirm '${cmd} exec --json --skip-git-repo-check "hi"' works from a terminal.`
    );
  }

  // Baseline identity = the pinned model (see CODEX_MODEL_PATTERN). Falls back
  // to the manifest id when the seat is left unpinned, exactly like
  // claude-code returns 'claude-code'.
  const pinned = parseModelSpec(transportOf(config).model).model;
  return { modelId: pinned ?? 'codex', sessionId };
}

export const codexAdapter: AgentAdapter = {
  manifest: codexManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const { modelId, sessionId } = await verifyBinaryAndAuth(config);
    return new CodexSession(config, Date.now(), modelId, sessionId);
  },
};

/** Identity helper for verifier deps — reports model id from inside the session itself. */
export async function getIdentityFromCodexSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
