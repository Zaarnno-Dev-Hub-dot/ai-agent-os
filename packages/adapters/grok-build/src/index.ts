import {
  AdapterConfig,
  AdapterError,
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
import { grokBuildManifest } from './manifest.js';
import {
  challengeEffortFor,
  chatTurnOptionsFor,
  cliCommandOf,
  GrokStreamJsonEvent,
  collectStderr,
  spawnGrokTurn,
  transportOf,
} from './cliProcess.js';
import { defaultGrokInstallPath, isExistingFile, isOnPath } from './findBinary.js';

export { grokBuildManifest };
export type { GrokBuildTransportConfig } from './cliProcess.js';

/**
 * CRITICAL (same invariant as the Claude Code adapter, gate-blocker 1
 * precedent): the GROK BUILD SESSION must read the nonce file itself via its
 * own tools. The adapter/gateway process NEVER touches the filesystem for
 * this — that is the painted-status hole that failed review round 2. We
 * prompt the CLI turn to read the file and restrict tools to a read-only
 * capability, so a bare LLM completion without real file access cannot pass.
 */
const NONCE_RUN_INSTRUCTIONS = (noncePath: string) =>
  `You are answering a proof-of-life challenge for Agent OS. ` +
  `Use your file-read tool to read the exact file at this path: ${noncePath} ` +
  `Reply with ONLY the raw file contents — no markdown fences, no explanation, no extra lines.`;

function extractText(ev: GrokStreamJsonEvent): string | undefined {
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

/**
 * Final assistant text of a turn. Live schema (grok 0.2.82): the reply is the
 * concatenation of `{"type":"text","data":...}` deltas — there is no aggregate
 * result event. Falls back to Claude-style result/content extraction for
 * other builds.
 */
function finalTextOf(events: GrokStreamJsonEvent[]): string {
  const deltas = events
    .filter((e) => e.type === 'text' && typeof e.data === 'string')
    .map((e) => e.data as string)
    .join('');
  if (deltas) return deltas;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = extractText(events[i]);
    if (t) return t;
  }
  return '';
}

export function mapStreamEventToAgentEvents(ev: GrokStreamJsonEvent, messageId: string): AgentEvent[] {
  // Live schema (grok 0.2.82, verified 2026-07-04): text deltas carry the
  // reply; thought deltas are internal reasoning (not surfaced as chat
  // tokens); `end` closes the turn and carries the session id.
  if (ev.type === 'text' && typeof ev.data === 'string' && ev.data) {
    return [{ type: 'token', delta: ev.data, messageId }];
  }
  if (ev.type === 'thought') {
    return [];
  }
  if (ev.type === 'end') {
    // Grok 0.2.82 cancels headless turns that hit a tool-approval prompt
    // (stopReason "Cancelled" instead of "EndTurn") — surface that instead of
    // completing silently. Fallback end events without a stopReason stay as-is.
    //
    // 2026-08-08: the CLI CHANGED THIS STRING'S CASING between versions —
    // 0.2.82 emitted `EndTurn`, the installed 0.2.118 emits `end_turn`. The
    // old exact-match comparison therefore classified every NORMAL, SUCCESSFUL
    // turn as a failure, and the relay dropped the reply: both Grok seats sat
    // VERIFIED in a room, consumed their turn, and produced nothing. That is
    // how the 8/8 burn-down room came to look like the models were ignoring
    // the operator. Compare on a normalized form (case-folded, separators stripped)
    // so `EndTurn`, `end_turn`, and `end-turn` all read as a clean finish,
    // while genuine `Cancelled` still surfaces as the error it is.
    const stopReason = typeof ev.stopReason === 'string' ? ev.stopReason : undefined;
    const isCleanFinish =
      stopReason === undefined || stopReason.toLowerCase().replace(/[_\-\s]/g, '') === 'endturn';
    if (!isCleanFinish) {
      return [
        {
          type: 'error',
          code: 'turn-stopped',
          message: `Grok Build turn ended without completing (stopReason: ${ev.stopReason})`,
          recoverable: true,
          messageId,
        },
        { type: 'message-complete', messageId },
      ];
    }
    return [{ type: 'message-complete', messageId }];
  }
  if (ev.type === 'error') {
    // Live schema: {"type":"error","message":"<string>"} (e.g. API 400s).
    const rawMsg = (ev as Record<string, unknown>).message;
    return [
      {
        type: 'error',
        code: 'stream-error',
        message: typeof rawMsg === 'string' ? rawMsg : 'Grok Build stream error',
        recoverable: true,
        messageId,
      },
    ];
  }

  // Claude-style fallbacks below, retained defensively for other builds.
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
        message: typeof ev.result === 'string' ? ev.result : ev.error ?? 'Grok Build run failed',
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

class GrokBuildSession implements AgentSession {
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private disposed = false;
  private sessionId: string | undefined;
  private activeChild: ReturnType<typeof spawnGrokTurn>['child'] | null = null;
  /** Q7 (TOP-TIER-QUEUE.md, 2026-07-21): the hand-rolled busy-wait send gate, owned once in @agent-os/shared instead of duplicated per adapter. Same grace-wait-then-throw semantics as before. */
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
    opts: { allowedTools?: string[]; systemPrompt?: string; alwaysApprove?: boolean; effort?: string } = {}
  ): Promise<{ events: GrokStreamJsonEvent[]; exitCode: number | null; stderr: string }> {
    const invocation = spawnGrokTurn(this.config, {
      prompt,
      resumeSessionId: this.sessionId,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
      alwaysApprove: opts.alwaysApprove,
      effort: opts.effort,
    });
    this.activeChild = invocation.child;
    const stderrCollector = collectStderr(invocation.child);

    const collected: GrokStreamJsonEvent[] = [];
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
    if (this.disposed) throw new Error('Grok Build session disposed');
    // Q7: grace-wait-then-throw, now owned by BusySendGate (packages/shared)
    // instead of hand-rolled here — same semantics, see its class doc
    // comment for why (2026-07-04 grok-build busy-race, this exact adapter).
    await this.sendGate.enter('Grok Build session busy — gateway must serialize sends per agent');
    const messageId = `gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = `[${msg.senderName ?? msg.senderId}]: ${msg.content}`;

    this.sendGate.attach(
      (async () => {
        try {
          // Grok 0.2.82 CANCELS a headless turn the instant it wants to use any
          // tool that would need interactive approval (cliProcess.ts's
          // spawnGrokTurn doc comment, verified live 2026-07-04) — so a normal
          // relay chat turn that touches Shell/Write/etc without --always-approve
          // dies with stopReason "Cancelled" before it can do anything. the operator's
          // 2026-07-18 "go" covered unattended BUILDING, not unrestricted
          // Shell/Write on every room a seat happens to sit in — Fable ruling
          // M-WM-1/B4-M3 (2026-07-21) scopes --always-approve to rooms in the
          // seat's config-named full-auto allowlist (fullAutoRoomIds /
          // GROKBUILD_FULL_AUTO_ROOMS); every other room gets RESTRICTED_CHAT_TOOLS
          // (read-only) instead, so Shell/Write there just cancels the turn
          // rather than running unattended. See chatTurnOptionsFor's doc comment
          // (cliProcess.ts) for the full decision.
          const { exitCode, stderr } = await this.runTurn(
            prompt,
            messageId,
            chatTurnOptionsFor(this.config, msg.roomId)
          );
          if (exitCode !== 0 && exitCode !== null) {
            this.enqueue({
              type: 'error',
              code: 'cli-exit',
              message: `grok exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
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
        // The GROK BUILD SESSION reads the file itself — restrict tools to a
        // read-only capability so a bare completion (no real filesystem
        // access) cannot pass.
        const { events, exitCode, stderr } = await this.runTurn(
          `Read the file at this absolute path and return only its contents: ${challenge.noncePath}`,
          `pol-${challengeId}`,
          {
            // Grok 0.2.82's --tools values are PascalCase (verified live by
            // asking the session: Shell, Read, Grep, Glob, Write, ...).
            // Effort override is CONDITIONAL, not blanket-omitted: composer
            // errors on --effort at all, but grok-4.5 defaults to
            // 'high' reasoning effort and needs 'low' on this trivial read
            // to keep headroom under the 120s verifier budget. See
            // challengeEffortFor's doc comment (cliProcess.ts) for the full
            // history — this is the Wave 7 M0 fix for grok-4.5's post-restart
            // nonce-file timeouts.
            allowedTools: ['Read'],
            systemPrompt: NONCE_RUN_INSTRUCTIONS(challenge.noncePath),
            effort: challengeEffortFor(transportOf(this.config).model),
          }
        );
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `grok exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
            latencyMs: Date.now() - start,
          };
        }
        const nonce = finalTextOf(events).trim();
        const streamErr = events.find((e) => e.type === 'error');
        return {
          challengeId,
          type,
          success: nonce.length > 0,
          data: { nonce, text: nonce },
          error:
            nonce.length === 0 && streamErr
              ? String((streamErr as Record<string, unknown>).message ?? 'stream error')
              : undefined,
          latencyMs: Date.now() - start,
        };
      }

      if (challenge.type === 'capability-probe') {
        // Exercise the CLI's real tool access: list the workspace directory and
        // return a named file, proving actual filesystem tool use (not a bare API).
        const { events, exitCode, stderr } = await this.runTurn(
          'List the files in your current working directory using your shell/file tool ' +
            '(command: dir on Windows or ls elsewhere) and reply with ONLY the name of one file or directory you see.',
          `probe-${challengeId}`,
          {
            allowedTools: ['Shell'],
            alwaysApprove: true,
            // Same conditional-effort fix as the nonce-file challenge above.
            effort: challengeEffortFor(transportOf(this.config).model),
          }
        );
        if (exitCode !== 0 && exitCode !== null) {
          return {
            challengeId,
            type,
            success: false,
            error: `grok exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
            latencyMs: Date.now() - start,
          };
        }
        const text = finalTextOf(events).trim();
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
      'Reply with ONLY your model identifier (e.g. grok-4, grok-code-fast, etc), nothing else.',
      `identity-${Date.now().toString(36)}`,
      { allowedTools: [] }
    );
    if (exitCode !== 0 && exitCode !== null) return this.modelId;
    const text = finalTextOf(events).trim();
    if (text) this.modelId = text.split(/\s+/)[0] ?? this.modelId;
    return this.modelId;
  }
}

async function verifyBinaryAndAuth(config: AdapterConfig): Promise<{ modelId: string; sessionId?: string }> {
  const cmd = cliCommandOf(config);
  // cmd may be a concrete file path (the ~/.grok/bin default install or a
  // transport override) — only fall back to PATH resolution for bare names.
  const found = isExistingFile(cmd) || (await isOnPath(cmd));
  if (!found) {
    throw new AdapterError(
      'binary-not-found',
      `'${cmd}' was not found (checked as file path and on PATH)`,
      `Install the Grok Build CLI (expected at ${defaultGrokInstallPath()} or on PATH), then log in once with your SuperGrok account outside this app.`
    );
  }

  // One cheap real invocation to confirm the local login/auth works.
  const invocation = spawnGrokTurn(config, {
    prompt: 'Reply with ONLY the word OK.',
    allowedTools: [],
  });
  const stderrCollector = collectStderr(invocation.child);
  const collected: GrokStreamJsonEvent[] = [];
  let sawResult = false;
  try {
    for await (const ev of invocation.events) {
      collected.push(ev);
      // Live schema ends a turn with `end`; Claude-style builds end with `result`.
      if (ev.type === 'end') sawResult = true;
      if (ev.type === 'result') {
        sawResult = true;
        if (ev.is_error) {
          const msg = typeof ev.result === 'string' ? ev.result : ev.error ?? 'unknown error';
          throw new AdapterError(
            'auth-missing',
            `Grok Build CLI reported an error: ${msg}`,
            `Authenticate the Grok Build CLI with your SuperGrok subscription outside this app, then retry connect.`
          );
        }
      }
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw new AdapterError(
      'handshake-failed',
      `Grok Build CLI invocation failed: ${e instanceof Error ? e.message : String(e)}`,
      'Check that the grok CLI runs correctly from a terminal, then retry.'
    );
  }

  const [sessionId, exitCode] = await Promise.all([invocation.sessionId, invocation.exitCode]);
  const stderr = stderrCollector.text();
  const resultText = finalTextOf(collected);

  if (exitCode !== 0 && exitCode !== null) {
    const combined = `${stderr} ${resultText}`.toLowerCase();
    if (
      combined.includes('login') ||
      combined.includes('auth') ||
      combined.includes('not authenticated') ||
      combined.includes('unauthorized') ||
      combined.includes('supergrok')
    ) {
      throw new AdapterError(
        'auth-missing',
        `Grok Build CLI is not authenticated (exit ${exitCode})`,
        `Log in with your SuperGrok subscription outside this app, then retry connect.`
      );
    }
    throw new AdapterError(
      'handshake-failed',
      `Grok Build CLI exited with code ${exitCode}: ${stderr.slice(0, 300)}`,
      'Run the same command from a terminal to see the full error.'
    );
  }

  if (!sawResult) {
    throw new AdapterError(
      'handshake-failed',
      'Grok Build CLI produced no result event on streaming-json output',
      `Confirm '${cmd} -p "hi" --output-format streaming-json' works from a terminal.`
    );
  }

  return { modelId: 'grok', sessionId };
}

export const grokBuildAdapter: AgentAdapter = {
  manifest: grokBuildManifest,
  async connect(config: AdapterConfig): Promise<AgentSession> {
    const { modelId, sessionId } = await verifyBinaryAndAuth(config);
    return new GrokBuildSession(config, Date.now(), modelId, sessionId);
  },
};

/** Identity helper for verifier deps — reports model id from inside the session itself. */
export async function getIdentityFromGrokBuildSession(
  session: AgentSession
): Promise<{ modelId: string; accountId?: string }> {
  const h = await session.health();
  return { modelId: h.modelId };
}
