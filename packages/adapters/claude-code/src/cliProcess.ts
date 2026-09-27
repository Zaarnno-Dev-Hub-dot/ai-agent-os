import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import type { Readable } from 'stream';
import type { AdapterConfig } from '@agent-os/shared';
import { defaultClaudeInstallPath } from './findBinary.js';

export type ClaudeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ClaudeCodeTransportConfig {
  /** Override the CLI command name/path (default: 'claude'). */
  cliCommand?: string;
  /** Working directory the CLI is spawned in (defaults to config.workspace). */
  cwd?: string;
  /** Extra CLI args appended to every invocation (advanced/testing only). */
  extraArgs?: string[];
  /**
   * Model for every turn (--model), e.g. 'claude-opus-4-8'. Unset = the CLI's
   * account default — which may be the most expensive tier; dashboard seats
   * should pin this deliberately (opus for the seat,
   * fable reserved for design/review sessions).
   */
  model?: string;
  /**
   * Effort level for every turn (--effort), one of 'low' | 'medium' | 'high'
   * | 'xhigh' | 'max' (CLI 2.1.205 --help). Unset = CLI default. Added
   * 2026-07-11 for the claude-code#advisor advisor seat (medium).
   */
  effort?: string;
  /**
   * Tool names to deny on EVERY turn (--disallowedTools), e.g.
   * ['Agent', 'Task'] to stop a seat from spawning subagents. Added
   * 2026-07-11 for the claude-code#advisor advisor seat (advisor-answers-only
   * safeguard, owner-approved). Applied in addition to any per-call
   * opts.allowedTools (challenges already restrict to a single tool, so the
   * two never conflict). Unset = no change from prior behavior (every other
   * claude-code seat keeps full tool access, same as before this field
   * existed).
   */
  disallowedTools?: string[];
}

/**
 * Effort values the CLI accepts (--effort, verified live against 2.1.205's
 * own --help on 2026-07-11 for the advisor seat).
 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Split the COMPOSITE '<model>:<effort>' form ('claude-opus-5:xhigh') into its
 * parts; a bare model id passes through untouched.
 *
 * WHY: the operator asked (2026-08-08) to change the Opus seat's effort from the
 * dash itself. `agent.set-model` is the gateway's only per-seat mutation verb,
 * so effort rides inside the model string and is split back out here — the
 * same mechanism the codex adapter uses, and the legal combinations are
 * enumerated in gateway/modelVocab.ts, so the existing server-side allowlist
 * covers effort with no new client event and no change to the frozen shared
 * package. A suffix is only read as effort when it is one of CLAUDE_EFFORTS,
 * so a future model id containing ':' is not mangled.
 */
export function parseModelSpec(spec: string | undefined): { model?: string; effort?: string } {
  const raw = spec?.trim();
  if (!raw) return {};
  const idx = raw.lastIndexOf(':');
  if (idx > 0) {
    const suffix = raw.slice(idx + 1);
    if ((CLAUDE_EFFORTS as readonly string[]).includes(suffix)) {
      return { model: raw.slice(0, idx), effort: suffix };
    }
  }
  return { model: raw };
}

export function transportOf(config: AdapterConfig): ClaudeCodeTransportConfig {
  return (config.transport ?? {}) as ClaudeCodeTransportConfig;
}

export function cliCommandOf(config: AdapterConfig): string {
  const override = transportOf(config).cliCommand?.trim();
  if (override) return override;
  // The desktop-app bundle isn't on PATH (verified live 2026-07-04): prefer
  // it when present, fall back to PATH resolution (npm-global installs).
  return defaultClaudeInstallPath() ?? 'claude';
}

/**
 * Raw line-delimited JSON events emitted by `claude --output-format stream-json`.
 * The exact field set varies by CLI version; we read defensively and only rely
 * on the `type` discriminator plus well-known nested shapes.
 */
export interface ClaudeStreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: unknown;
      tool_use_id?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  delta?: { type?: string; text?: string };
  result?: string;
  is_error?: boolean;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

export interface CliInvocation {
  child: ClaudeChildProcess;
  /** Resolves with the session id captured from the first stream event, if any. */
  sessionId: Promise<string | undefined>;
  events: AsyncIterable<ClaudeStreamJsonEvent>;
  /** Resolves when the process exits (0 = clean). */
  exitCode: Promise<number | null>;
}

/**
 * Spawn `claude -p "<prompt>" --output-format stream-json [--resume <id>]
 * [--allowedTools <list>]` and parse newline-delimited JSON off stdout.
 *
 * NEVER used to read files on the adapter's own behalf — this is purely a
 * transport for driving the CLI's own turn; any filesystem access it reports
 * happened inside the CLI's own tool-use, not this process.
 */
export function spawnClaudeTurn(
  config: AdapterConfig,
  opts: {
    prompt: string;
    resumeSessionId?: string;
    allowedTools?: string[];
    systemPrompt?: string;
  }
): CliInvocation {
  const t = transportOf(config);
  const cmd = cliCommandOf(config);
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }
  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }
  // Composite 'model:effort' (dash picker) splits here; a composite effort
  // wins over the connect-time transport.effort pin for that turn.
  const { model, effort: composedEffort } = parseModelSpec(t.model);
  const effort = composedEffort ?? t.effort;
  if (model) {
    args.push('--model', model);
  }
  if (effort) {
    args.push('--effort', effort);
  }
  if (t.disallowedTools && t.disallowedTools.length > 0) {
    args.push('--disallowedTools', t.disallowedTools.join(','));
  }
  if (t.extraArgs) args.push(...t.extraArgs);

  const cwd = t.cwd ?? config.workspace ?? process.cwd();
  // spawn() errors with ENOENT on a missing cwd — the per-agent workspace dir
  // doesn't exist on a fresh machine until the first nonce challenge writes
  // into it, so ensure it here (same fix as grok-build).
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let resolveSessionId: (id: string | undefined) => void;
  const sessionId = new Promise<string | undefined>((resolve) => {
    resolveSessionId = resolve;
  });
  let sessionIdSettled = false;

  let resolveExit: (code: number | null) => void;
  const exitCode = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  child.on('close', (code) => resolveExit(code));
  child.on('error', () => resolveExit(-1));

  async function* parse(): AsyncGenerator<ClaudeStreamJsonEvent> {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: ClaudeStreamJsonEvent;
        try {
          parsed = JSON.parse(line) as ClaudeStreamJsonEvent;
        } catch {
          continue; // ignore malformed/partial line
        }
        if (!sessionIdSettled && typeof parsed.session_id === 'string' && parsed.session_id) {
          sessionIdSettled = true;
          resolveSessionId(parsed.session_id);
        }
        yield parsed;
      }
    }
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim()) as ClaudeStreamJsonEvent;
        if (!sessionIdSettled && typeof parsed.session_id === 'string' && parsed.session_id) {
          sessionIdSettled = true;
          resolveSessionId(parsed.session_id);
        }
        yield parsed;
      } catch {
        /* ignore trailing partial */
      }
    }
    if (!sessionIdSettled) {
      sessionIdSettled = true;
      resolveSessionId(undefined);
    }
  }

  return { child, sessionId, events: parse(), exitCode };
}

/** Collect stderr text for diagnosability (auth errors, missing binary, etc). */
export function collectStderr(child: ClaudeChildProcess): { text(): string } {
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { text: () => text };
}
