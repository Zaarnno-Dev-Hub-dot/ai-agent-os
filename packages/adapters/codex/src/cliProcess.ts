import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import type { Readable } from 'stream';
import type { AdapterConfig } from '@agent-os/shared';
import { defaultCodexInstallPath } from './findBinary.js';
import { CODEX_EFFORTS } from './manifest.js';

export type CodexChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface CodexTransportConfig {
  /** Override the CLI command name/path (default: bundled codex.exe, else 'codex'). */
  cliCommand?: string;
  /** Working directory the CLI is spawned in (defaults to config.workspace). */
  cwd?: string;
  /** Extra CLI args appended to every invocation (advanced/testing only). */
  extraArgs?: string[];
  /**
   * Model for every turn. Accepts either a bare id ('gpt-5.6-terra') or the
   * COMPOSITE form '<model>:<effort>' ('gpt-5.6-terra:high') — see
   * parseModelSpec for why the composite exists.
   */
  model?: string;
  /**
   * Reasoning effort for every turn ('low' | 'medium' | 'high'), applied as
   * `-c model_reasoning_effort="<value>"`. A composite `model` string wins
   * over this field, so the dash's single picker can drive both.
   */
  effort?: string;
  /**
   * Sandbox policy for model-generated shell commands: 'read-only' |
   * 'workspace-write' | 'danger-full-access'. Defaults to 'workspace-write'
   * for ordinary turns; challenges force 'read-only' regardless, since
   * proving tool access never requires the ability to write.
   */
  sandbox?: string;
}

/** Shell-metacharacter-free ids only. Defense in depth behind MODEL_VOCAB. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ModelSpec {
  model?: string;
  effort?: string;
}

/**
 * Split '<model>:<effort>' into its parts.
 *
 * WHY THIS EXISTS: the operator asked to switch BOTH model tier and reasoning effort
 * from the dash. The gateway's only per-seat mutation verb is
 * `agent.set-model` (index.ts), whose value is checked against
 * gateway/modelVocab.ts and written to transport.model — there is no
 * `agent.set-effort`. Rather than add a new client event (which would mean
 * editing packages/gateway/src/index.ts and the UI store, both of which had
 * uncommitted work from another writer at build time — BUILDER_PROTOCOL rule
 * 6), effort rides IN the model string as a suffix and is split back out
 * here. The allowlist in modelVocab.ts enumerates the legal
 * model:effort combinations, so the existing server-side vocabulary check
 * covers effort for free and no unvalidated string ever reaches argv.
 *
 * A suffix is only treated as effort when it is one of CODEX_EFFORTS; any
 * other ':' content is left alone as part of the model id (so a future
 * 'family:tag'-shaped id does not get silently mangled).
 */
export function parseModelSpec(spec: string | undefined): ModelSpec {
  const raw = spec?.trim();
  if (!raw) return {};
  const idx = raw.lastIndexOf(':');
  if (idx > 0) {
    const suffix = raw.slice(idx + 1);
    if ((CODEX_EFFORTS as readonly string[]).includes(suffix)) {
      return { model: raw.slice(0, idx), effort: suffix };
    }
  }
  return { model: raw };
}

export function transportOf(config: AdapterConfig): CodexTransportConfig {
  return (config.transport ?? {}) as CodexTransportConfig;
}

export function cliCommandOf(config: AdapterConfig): string {
  const override = transportOf(config).cliCommand?.trim();
  if (override) return override;
  // The desktop-app bundle isn't on PATH (verified live 2026-08-08): prefer
  // it when present, fall back to PATH resolution (npm/standalone installs).
  return defaultCodexInstallPath() ?? 'codex';
}

/**
 * Raw line-delimited JSON events emitted by `codex exec --json`
 * (schema observed live on CLI 0.147.0-alpha.6.5). Read defensively: only the
 * `type` discriminator and well-known nested shapes are relied on, because
 * this CLI is on an alpha channel and the schema can move under us.
 */
export interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    message?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
  [key: string]: unknown;
}

export interface CliInvocation {
  child: CodexChildProcess;
  /** Resolves with the thread id captured from `thread.started`, if any. */
  sessionId: Promise<string | undefined>;
  events: AsyncIterable<CodexJsonEvent>;
  /** Resolves when the process exits (0 = clean). */
  exitCode: Promise<number | null>;
}

/**
 * Build the argv for one `codex exec` turn.
 *
 * `--skip-git-repo-check` is deliberate: per-seat workspace dirs the gateway
 * creates are not git repos, and without it the CLI refuses to run there.
 * Approval policy is left at the exec default (never) — a headless seat that
 * pauses for an interactive approval prompt is a hung seat.
 */
export function buildArgs(
  config: AdapterConfig,
  opts: { prompt: string; resumeSessionId?: string; sandboxOverride?: string }
): string[] {
  const t = transportOf(config);
  const { model, effort: composedEffort } = parseModelSpec(t.model);
  const effort = composedEffort ?? t.effort?.trim();
  const sandbox = opts.sandboxOverride ?? t.sandbox?.trim() ?? 'workspace-write';

  const flags: string[] = ['--json', '--skip-git-repo-check'];
  // Sandbox goes through `-c sandbox_mode=` rather than the `-s/--sandbox`
  // FLAG, because `codex exec resume` does not accept `-s` — it errors with
  // "unexpected argument '-s' found" and the turn produces no output at all.
  // That bit us live on 2026-08-08: the first (fresh) turn of a session
  // worked, then every RESUMED turn — which is every turn after connect,
  // including the nonce challenge — died at argv parsing, and the seat failed
  // with an empty-nonce mismatch that looked like the model misbehaving.
  // `-c` is accepted identically by both `exec` and `exec resume` (verified
  // live against 0.147.0-alpha.6.5's own --help and a real run), so both
  // paths now build the same way and cannot drift apart again.
  if (SAFE_TOKEN.test(sandbox)) flags.push('-c', `sandbox_mode="${sandbox}"`);
  if (model && SAFE_TOKEN.test(model)) flags.push('-m', model);
  if (effort && SAFE_TOKEN.test(effort)) {
    flags.push('-c', `model_reasoning_effort="${effort}"`);
  }
  if (t.extraArgs) flags.push(...t.extraArgs);

  // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` — options may precede
  // the positionals (CLI help, 0.147.0-alpha.6.5).
  return opts.resumeSessionId
    ? ['exec', 'resume', ...flags, opts.resumeSessionId, opts.prompt]
    : ['exec', ...flags, opts.prompt];
}

/**
 * Spawn one `codex exec` turn and parse newline-delimited JSON off stdout.
 *
 * NEVER used to read files on the adapter's own behalf — this is purely a
 * transport for driving the CLI's own turn; any filesystem access it reports
 * happened inside the CLI's own tool-use, not this process. That invariant is
 * what makes the nonce-file challenge meaningful (gate-blocker 1 precedent on
 * the Hermes adapter).
 */
export function spawnCodexTurn(
  config: AdapterConfig,
  opts: { prompt: string; resumeSessionId?: string; sandboxOverride?: string }
): CliInvocation {
  const cmd = cliCommandOf(config);
  const args = buildArgs(config, opts);

  const t = transportOf(config);
  const cwd = t.cwd ?? config.workspace ?? process.cwd();
  // spawn() errors with ENOENT on a missing cwd — the per-agent workspace dir
  // doesn't exist on a fresh machine until the first nonce challenge writes
  // into it (same fix as claude-code / grok-build).
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

  const child = spawn(cmd, args, {
    cwd,
    // stdin ignored on purpose: `codex exec` reads a prompt from stdin when
    // one is piped, and an inherited/open stdin makes it block on EOF.
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

  function noteSessionId(parsed: CodexJsonEvent): void {
    if (!sessionIdSettled && typeof parsed.thread_id === 'string' && parsed.thread_id) {
      sessionIdSettled = true;
      resolveSessionId(parsed.thread_id);
    }
  }

  async function* parse(): AsyncGenerator<CodexJsonEvent> {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('{')) continue; // CLI also prints plain log lines
        let parsed: CodexJsonEvent;
        try {
          parsed = JSON.parse(line) as CodexJsonEvent;
        } catch {
          continue; // ignore malformed/partial line
        }
        noteSessionId(parsed);
        yield parsed;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('{')) {
      try {
        const parsed = JSON.parse(tail) as CodexJsonEvent;
        noteSessionId(parsed);
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
export function collectStderr(child: CodexChildProcess): { text(): string } {
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { text: () => text };
}

/** The assistant's final message text for a completed turn, if any. */
export function finalMessageOf(events: CodexJsonEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
      return ev.item.text;
    }
  }
  return undefined;
}

/** First hard error reported by the CLI for a turn, if any. */
export function turnErrorOf(events: CodexJsonEvent[]): string | undefined {
  for (const ev of events) {
    if (ev.type === 'turn.failed') return ev.error?.message ?? 'codex turn failed';
    if (ev.type === 'error' && typeof ev.message === 'string') return ev.message;
  }
  return undefined;
}
