import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import type { Readable } from 'stream';
import type { AdapterConfig } from '@agent-os/shared';
import { defaultOpencodeInstallPath } from './findBinary.js';

export type OpencodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface OpencodeTransportConfig {
  /** Override the CLI command name/path (default: bundled opencode.exe, else 'opencode'). */
  cliCommand?: string;
  /** Working directory the CLI is spawned in (defaults to config.workspace). */
  cwd?: string;
  /** Extra CLI args appended to every invocation (advanced/testing only). */
  extraArgs?: string[];
  /**
   * Model for every turn, in opencode's `provider/model` form
   * (e.g. 'opencode/ling-3.0-tiny-free'). Bare ids only — `--variant`
   * (reasoning effort) exists on the CLI and `high` worked live 2026-08-12,
   * but max/minimal/low/medium were not proven, so this adapter does not
   * invent an effort knob.
   */
  model?: string;
}

/** Shell-metacharacter-free model ids. Allows the required `provider/model` slash. */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Session ids look like `ses_00898e58dffeiwEMD2dWo4nu1k`. */
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function transportOf(config: AdapterConfig): OpencodeTransportConfig {
  return (config.transport ?? {}) as OpencodeTransportConfig;
}

export function cliCommandOf(config: AdapterConfig): string {
  const override = transportOf(config).cliCommand?.trim();
  if (override) return override;
  return defaultOpencodeInstallPath() ?? 'opencode';
}

/**
 * Raw line-delimited JSON events from `opencode run --format json`
 * (schema observed live on CLI 1.18.15, 2026-08-12). Read defensively.
 */
export interface OpencodeJsonEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    tool?: string;
    text?: string;
    reason?: string;
    callID?: string;
    messageID?: string;
    sessionID?: string;
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { write?: number; read?: number };
    };
    cost?: number;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
    };
    [key: string]: unknown;
  };
  error?: { name?: string; data?: { message?: string; ref?: string } };
  [key: string]: unknown;
}

export interface CliInvocation {
  child: OpencodeChildProcess;
  sessionId: Promise<string | undefined>;
  events: AsyncIterable<OpencodeJsonEvent>;
  exitCode: Promise<number | null>;
}

/**
 * Build the argv for one `opencode run` turn.
 *
 * CRITICAL flag note (the Codex seat's actual failure mode, inverted):
 * Codex's resume path rejected `-s` because `-s` meant sandbox. Here `-s`
 * IS the session id (`opencode run -s <sessionID>`). Fresh and resume are
 * the SAME subcommand — help texts are identical — so both paths share
 * this builder. There is no separate `run resume`.
 *
 * `--auto` is required for a headless seat: without it, file/shell
 * permission prompts hang the process. `--format json` is the event stream.
 */
export function buildArgs(
  config: AdapterConfig,
  opts: { prompt: string; resumeSessionId?: string }
): string[] {
  const t = transportOf(config);
  const model = t.model?.trim();

  const flags: string[] = ['run', '--format', 'json', '--auto'];
  if (model && SAFE_MODEL.test(model)) flags.push('-m', model);
  if (opts.resumeSessionId && SAFE_SESSION.test(opts.resumeSessionId)) {
    flags.push('-s', opts.resumeSessionId);
  }
  if (t.extraArgs) flags.push(...t.extraArgs);
  flags.push(opts.prompt);
  return flags;
}

/**
 * Spawn one `opencode run --format json` turn and parse JSONL off stdout.
 *
 * NEVER used to read files on the adapter's own behalf — filesystem access
 * reported here happened inside the CLI's own tool-use. That is what makes
 * the nonce-file challenge meaningful.
 */
export function spawnOpencodeTurn(
  config: AdapterConfig,
  opts: { prompt: string; resumeSessionId?: string }
): CliInvocation {
  const cmd = cliCommandOf(config);
  const args = buildArgs(config, opts);

  const t = transportOf(config);
  const cwd = t.cwd ?? config.workspace ?? process.cwd();
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

  function noteSessionId(parsed: OpencodeJsonEvent): void {
    const id = parsed.sessionID ?? parsed.part?.sessionID;
    if (!sessionIdSettled && typeof id === 'string' && id) {
      sessionIdSettled = true;
      resolveSessionId(id);
    }
  }

  async function* parse(): AsyncGenerator<OpencodeJsonEvent> {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('{')) continue;
        let parsed: OpencodeJsonEvent;
        try {
          parsed = JSON.parse(line) as OpencodeJsonEvent;
        } catch {
          continue;
        }
        noteSessionId(parsed);
        yield parsed;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('{')) {
      try {
        const parsed = JSON.parse(tail) as OpencodeJsonEvent;
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

export function collectStderr(child: OpencodeChildProcess): { text(): string } {
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { text: () => text };
}

/** The assistant's final message text for a completed turn, if any. */
export function finalMessageOf(events: OpencodeJsonEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'text' && ev.part?.text) return ev.part.text;
  }
  return undefined;
}

/** First hard error reported by the CLI for a turn, if any. */
export function turnErrorOf(events: OpencodeJsonEvent[]): string | undefined {
  for (const ev of events) {
    if (ev.type === 'error') {
      return ev.error?.data?.message ?? ev.error?.name ?? 'opencode turn error';
    }
  }
  return undefined;
}

export function usageOf(
  events: OpencodeJsonEvent[]
): { input: number; output: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const tokens = events[i].part?.tokens;
    if (events[i].type === 'step_finish' && tokens) {
      return { input: tokens.input ?? 0, output: tokens.output ?? 0 };
    }
  }
  return undefined;
}
