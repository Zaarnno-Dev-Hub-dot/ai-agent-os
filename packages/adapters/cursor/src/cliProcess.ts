import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';
import type { AdapterConfig } from '@agent-os/shared';
import { defaultCursorInstallPath } from './findBinary.js';

export type CursorChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface CursorTransportConfig {
  /** Override CLI path (Windows exe) or bare name. */
  cliCommand?: string;
  /** Force WSL launch even if a Windows binary exists. */
  useWsl?: boolean;
  /** Working directory override (defaults to config.workspace). */
  cwd?: string;
  /** Extra CLI args (advanced). */
  extraArgs?: string[];
  /**
   * Model id for --model (e.g. 'auto', 'sonnet-4.5'). Unset = CLI default.
   * Must match CURSOR_MODEL_PATTERN / gateway modelVocab.
   */
  model?: string;
}

/** Shell-safe model ids (no leading dash — arg-injection defense). */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function transportOf(config: AdapterConfig): CursorTransportConfig {
  return (config.transport ?? {}) as CursorTransportConfig;
}

export function cliCommandOf(config: AdapterConfig): string {
  const override = transportOf(config).cliCommand?.trim();
  if (override) return override;
  return defaultCursorInstallPath() ?? 'agent';
}

/**
 * Convert a Windows path to a WSL /mnt path so the Linux agent can read
 * gateway workspace files (nonce pol-*.txt under data/workspaces/cursor).
 */
export function toWslPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  return normalized;
}

/**
 * Load CURSOR_API_KEY into the child env without logging it.
 * Sources (first hit wins): existing process env, then hermes profile .env.
 * Never returns the value to callers — only mutates a copy of env.
 */
export function applyCursorAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (typeof out.CURSOR_API_KEY === 'string' && out.CURSOR_API_KEY.trim()) {
    return out;
  }
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'hermes', '.env'),
    join(homedir(), '.hermes', '.env'),
  ];
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        if (k !== 'CURSOR_API_KEY') continue;
        let v = t.slice(eq + 1).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v) {
          out.CURSOR_API_KEY = v;
          // Let WSL inherit this specific var from the Windows process env.
          const prev = out.WSLENV ?? '';
          if (!/(^|:)CURSOR_API_KEY(\/|$)/.test(prev)) {
            out.WSLENV = prev ? `${prev}:CURSOR_API_KEY/u` : 'CURSOR_API_KEY/u';
          }
          return out;
        }
      }
    } catch {
      /* ignore unreadable */
    }
  }
  return out;
}

/**
 * Raw NDJSON events from `agent -p --output-format stream-json`
 * (schema aligned with Paperclip cursor-local parse + live --help 2026-08-26).
 */
export interface CursorStreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  sessionId?: string;
  sessionID?: string;
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  result?: string;
  is_error?: boolean;
  error?: string | { message?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  model?: string;
  [key: string]: unknown;
}

export interface CliInvocation {
  child: CursorChildProcess;
  sessionId: Promise<string | undefined>;
  events: AsyncIterable<CursorStreamJsonEvent>;
  exitCode: Promise<number | null>;
}

/**
 * Build agent argv (WITHOUT the binary name).
 *
 * Paperclip pattern (verified against cursor-local execute.ts):
 *   agent -p --output-format stream-json --workspace <cwd> [--resume id] [--model m] --yolo
 * Prompt is passed as a final positional arg (and also works via stdin; we use argv
 * so Windows/WSL quoting stays in one place).
 *
 * CRITICAL: fresh turns must NOT pass --resume (Cursor probe). Resume is
 * `agent -p --resume <id> …`, not `agent resume`.
 */
export function buildArgs(
  config: AdapterConfig,
  opts: { prompt: string; resumeSessionId?: string; workspace?: string }
): string[] {
  const t = transportOf(config);
  const args = ['-p', '--output-format', 'stream-json'];
  const ws = opts.workspace ?? t.cwd ?? config.workspace;
  if (ws) {
    args.push('--workspace', ws);
  }
  // Headless: force tool allow (alias --yolo). Required so nonce Read/shell
  // doesn't hang on interactive approval.
  args.push('--yolo', '--trust');
  if (opts.resumeSessionId && SAFE_SESSION.test(opts.resumeSessionId)) {
    args.push('--resume', opts.resumeSessionId);
  }
  const model = t.model?.trim();
  if (model && SAFE_MODEL.test(model) && !model.startsWith('-')) {
    args.push('--model', model);
  }
  if (t.extraArgs?.length) args.push(...t.extraArgs);
  // Prompt last as positional (matches `agent [options] [prompt...]`).
  args.push(opts.prompt);
  return args;
}

function shouldUseWsl(config: AdapterConfig): boolean {
  const t = transportOf(config);
  if (t.useWsl === true) return true;
  if (t.useWsl === false) return false;
  if (process.platform !== 'win32') return false;
  const cmd = cliCommandOf(config);
  // Absolute Windows path that exists → native.
  if ((cmd.includes('\\') || cmd.includes('/')) && existsSync(cmd) && /\.exe$/i.test(cmd)) {
    return false;
  }
  // Official installer is linux-only here → default WSL.
  return true;
}

/**
 * Spawn one Cursor Agent turn. Never reads nonce files itself — the agent CLI must.
 */
export function spawnCursorTurn(
  config: AdapterConfig,
  opts: { prompt: string; resumeSessionId?: string }
): CliInvocation {
  const t = transportOf(config);
  const winCwd = t.cwd ?? config.workspace ?? process.cwd();
  if (!existsSync(winCwd)) mkdirSync(winCwd, { recursive: true });

  const env = applyCursorAuthEnv(process.env);
  const useWsl = shouldUseWsl(config);

  let cmd: string;
  let args: string[];
  let childCwd = winCwd;

  if (useWsl) {
    const wslWorkspace = toWslPath(winCwd);
    const agentArgs = buildArgs(config, {
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      workspace: wslWorkspace,
    });
    // Single bash -lc string; quote each arg for the inner shell.
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const inner = [
      'export PATH="$HOME/.local/bin:$PATH"',
      // Prefer env already injected via WSLENV; do not print.
      `agent ${agentArgs.map(q).join(' ')}`,
    ].join('; ');
    cmd = 'wsl.exe';
    args = ['-e', 'bash', '-lc', inner];
    childCwd = process.cwd();
  } else {
    cmd = cliCommandOf(config);
    args = buildArgs(config, {
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      workspace: winCwd,
    });
  }

  const child = spawn(cmd, args, {
    cwd: childCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }) as CursorChildProcess;

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

  function captureSession(parsed: CursorStreamJsonEvent) {
    if (sessionIdSettled) return;
    const id =
      (typeof parsed.session_id === 'string' && parsed.session_id) ||
      (typeof parsed.sessionId === 'string' && parsed.sessionId) ||
      (typeof parsed.sessionID === 'string' && parsed.sessionID) ||
      undefined;
    if (id) {
      sessionIdSettled = true;
      resolveSessionId(id);
    }
  }

  async function* parse(): AsyncGenerator<CursorStreamJsonEvent> {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        // Paperclip normalizes occasional stream prefixes; strip a leading "data: ".
        const cleaned = line.startsWith('data: ') ? line.slice(6).trim() : line;
        let parsed: CursorStreamJsonEvent;
        try {
          parsed = JSON.parse(cleaned) as CursorStreamJsonEvent;
        } catch {
          continue;
        }
        captureSession(parsed);
        yield parsed;
      }
    }
    if (buffer.trim()) {
      try {
        const cleaned = buffer.trim().startsWith('data: ')
          ? buffer.trim().slice(6).trim()
          : buffer.trim();
        const parsed = JSON.parse(cleaned) as CursorStreamJsonEvent;
        captureSession(parsed);
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

export function collectStderr(child: CursorChildProcess): { text(): string } {
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { text: () => text };
}

export function extractText(ev: CursorStreamJsonEvent): string | undefined {
  if (ev.type === 'result' && typeof ev.result === 'string') return ev.result;
  if (typeof ev.result === 'string' && ev.result) return ev.result;
  const content = ev.message?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (text) return text;
  }
  return undefined;
}

export function sessionIdOf(ev: CursorStreamJsonEvent): string | undefined {
  return (
    (typeof ev.session_id === 'string' && ev.session_id) ||
    (typeof ev.sessionId === 'string' && ev.sessionId) ||
    (typeof ev.sessionID === 'string' && ev.sessionID) ||
    undefined
  );
}
