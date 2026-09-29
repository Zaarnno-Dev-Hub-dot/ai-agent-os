import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import type { Readable } from 'stream';
import type { AdapterConfig } from '@agent-os/shared';
import { defaultGrokInstallPath } from './findBinary.js';

export type GrokChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface GrokBuildTransportConfig {
  /** Override the CLI command name/path (default: 'grok'). */
  cliCommand?: string;
  /** Working directory the CLI is spawned in (defaults to config.workspace). */
  cwd?: string;
  /**
   * Flag name for prompt input. Overridable in case the real CLI differs —
   * this has not been verified against a live binary; see manifest.ts note.
   */
  promptFlag?: string;
  /** Flag name for streaming JSON output mode (default: '--output-format'). */
  outputFormatFlag?: string;
  /** Value passed to outputFormatFlag. */
  outputFormatValue?: string;
  /** Flag name for session resume (default: '--resume'). */
  resumeFlag?: string;
  /** Flag name for restricting tool access (default: '--tools', verified live vs grok 0.2.82). */
  allowedToolsFlag?: string;
  /** Flag name for overriding the system prompt (default: '--system-prompt-override', verified live). */
  systemPromptFlag?: string;
  /**
   * Model for every turn (-m), e.g. 'grok-build'. Mirrors claude-code's
   * ClaudeCodeTransportConfig.model field exactly:
   * unset = the CLI's account default (grok-composer-2.5-fast).
   */
  model?: string;
  /** Extra CLI args appended to every invocation (advanced/testing only). */
  extraArgs?: string[];
  /**
   * Rooms where this seat's ordinary relay CHAT turns (send()) run with
   * --always-approve (unattended tool use, including Shell/Write) — a
   * comma-free array of room ids/names, config-named the same way
   * claude-code's disallowedTools is (ClaudeCodeTransportConfig). Added
   * 2026-07-21 (Fable ruling M-WM-1/B4-M3): the 2026-07-18 the operator "go"
   * covered unattended BUILDING, not unrestricted Shell/Write on every room
   * a grok-build seat happens to sit in. Every room NOT in this list gets
   * the restricted, read-only chat-turn posture instead (see
   * RESTRICTED_CHAT_TOOLS / chatTurnOptionsFor below) — fail-closed: unset
   * (and no GROKBUILD_FULL_AUTO_ROOMS env var either) means NO room gets
   * full auto. Verification turns (nonce-file, capability-probe in
   * index.ts's prove()) are unaffected — they already pin their own tight
   * allowedTools + a single canned prompt, not a user-driven chat turn.
   */
  fullAutoRoomIds?: string[];
}

export function transportOf(config: AdapterConfig): GrokBuildTransportConfig {
  return (config.transport ?? {}) as GrokBuildTransportConfig;
}

/**
 * Env var fallback for the full-auto room allowlist, read only when the
 * transport config's fullAutoRoomIds is absent (the config field wins when
 * both are set) — lets ops flip a seat's allowlist (e.g.
 * scripts/lib/connectSeats.mjs's TRANSPORT_OVERRIDES) without a code change.
 * Comma-separated room ids/names, whitespace-trimmed, empty entries dropped.
 */
export const FULL_AUTO_ROOMS_ENV_VAR = 'GROKBUILD_FULL_AUTO_ROOMS';

/**
 * Full-auto room allowlist for THIS seat's chat turns (send()), resolved
 * from config first, then the env var, defaulting to the empty set — a
 * seat with no allowlist configured anywhere runs every chat turn under the
 * restricted posture, never full auto (fail-closed default, Fable ruling
 * M-WM-1/B4-M3).
 *
 * B4 fix (2026-07-21 review-panel finding): gates on PRESENCE of
 * fullAutoRoomIds, not .length. An explicit `fullAutoRoomIds: []` ("full-auto
 * in NO room") is a deliberate, more-restrictive config and must be
 * authoritative — it must NEVER fall through to
 * GROKBUILD_FULL_AUTO_ROOMS, which is process-global and could silently
 * re-grant full-auto in rooms the operator explicitly zeroed out. Only a
 * genuinely UNSET field (undefined) consults the env var. See
 * fullAutoRoomIds's doc comment above for the history.
 */
export function fullAutoRoomsFor(config: AdapterConfig): Set<string> {
  const t = transportOf(config);
  if (t.fullAutoRoomIds !== undefined) {
    return new Set(t.fullAutoRoomIds.map((r) => r.trim()).filter(Boolean));
  }
  const fromEnv = process.env[FULL_AUTO_ROOMS_ENV_VAR];
  if (fromEnv) {
    return new Set(
      fromEnv
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
    );
  }
  return new Set();
}

/**
 * Read-only tool set a chat turn gets when its room is NOT in the full-auto
 * allowlist — no Shell, no Write, mirroring the OUTCOME of the claude-code
 * adapter's --disallowedTools posture (ClaudeCodeTransportConfig.disallowedTools),
 * even though grok's CLI only exposes an ALLOWlist flag (--tools) rather
 * than a denylist: allowing only read tools has the same effect here as
 * denying Shell/Write does there. Names verified live vs grok 0.2.82 (see
 * the capability-probe/nonce-file comments in index.ts for the PascalCase
 * vocabulary: Shell, Read, Grep, Glob, Write, ...).
 *
 * SECURITY — RESIDUAL EXFIL CHANNEL, KNOWINGLY UNRESOLVED (M10, 2026-07-21
 * review-panel finding): this is READ-ONLY, not READ-SCOPED. grok 0.2.82's
 * only verified tool-restriction surface is --tools, a tool-NAME allowlist
 * — there is no confirmed
 * flag that pins Read/Grep/Glob to a directory (no --tools-dir, --cwd-root,
 * sandbox, or similar has been verified live against the real binary). That
 * means a prompt-injected turn in a non-full-auto room can still
 * Read/Grep/Glob ANY absolute path the seat's OS user can reach — SSH keys,
 * tokens, bridge.env, other seats' data, content the Circe read-prohibition
 * edict forbids — and echo it into its reply, which relay.ts's
 * commitAgentReply persists, broadcasts, and fans out to every room member.
 * Do NOT "fix" this by inventing a path-scoping flag that hasn't been
 * confirmed live against the CLI — that would be a false sense of security.
 * Until grok ships and this file verifies a real one, treat every restricted
 * room as UNTRUSTED for any host that holds secrets the seat's OS user can
 * read (secrets-never-in-chat, Circe edict). cliProcess.test.ts's
 * 'RESTRICTED_CHAT_TOOLS (M10 residual exfil channel)' test pins this gap so
 * it can't be silently forgotten; if a verified path-scoping flag ever
 * ships, wire it into chatTurnOptionsFor and update/remove that test.
 */
export const RESTRICTED_CHAT_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * Tool posture for one relay chat turn (send()), decided purely by whether
 * `roomId` is in this seat's full-auto allowlist. Full auto also omits
 * allowedTools entirely (unattended building needs unrestricted tool
 * access) — restricted omits alwaysApprove entirely, so any tool needing
 * interactive approval (Shell, Write, anything outside RESTRICTED_CHAT_TOOLS)
 * simply cancels the turn (Grok 0.2.82's documented behavior, see
 * spawnGrokTurn's alwaysApprove doc comment below) instead of running
 * unattended. `roomId` undefined (a send() call that somehow bypassed the
 * relay's stamping) is treated as "not in the allowlist" — fail closed.
 */
export function chatTurnOptionsFor(
  config: AdapterConfig,
  roomId: string | undefined
): { alwaysApprove?: boolean; allowedTools?: string[] } {
  if (roomId !== undefined && fullAutoRoomsFor(config).has(roomId)) {
    return { alwaysApprove: true };
  }
  return { allowedTools: RESTRICTED_CHAT_TOOLS };
}

/**
 * Effort override for VERIFICATION challenge turns only (nonce-file,
 * capability-probe in index.ts's `prove()`) — NEVER for chat/relay turns,
 * which always use whatever effort the seat/CLI defaults to.
 *
 * History (Wave 7 M0, 2026-07-09 — root cause of grok-build#fast failing
 * verification after a gateway restart while the primary grok-build seat
 * verified fine): 2026-07-04's gate doc records challenge turns were first
 * pinned to `--effort low` because thinking-model latency flaked the 120s
 * verifier timeout on the fleet's one grok model at the time. Wave 5
 * (2026-07-08, grok-seats) DROPPED that override entirely for every grok
 * seat, because the newly-pinned default model, grok-composer-2.5-fast,
 * errors when passed --effort at all (`supports_reasoning_effort: false`
 * per the CLI's own `~/.grok/models_cache.json`) — the 120s budget was left
 * to absorb composer's default (fast, non-reasoning) latency instead, which
 * works fine for composer.
 *
 * Wave 5 ALSO added a second permanent seat, grok-build#fast, pinned to
 * grok-4.5 — a real reasoning model whose CLI-reported default is
 * `reasoning_effort: "high"` (`supports_reasoning_effort: true`, confirmed
 * live via `~/.grok/models_cache.json` 2026-07-09) — and the blanket
 * removal above silently re-exposed the exact slow-turn risk `--effort low`
 * was built to fix, but now only for grok-4.5's trivial nonce-file/dir-list
 * verification turns (gateway log: both timed out at the 120s budget after
 * the day's gateway restart).
 *
 * Fix: scope the override back in, per-model, for reasoning-capable models
 * only, so composer's 400 is never risked and grok-4.5's verification turns get
 * their latency headroom back (live-timed: ~5s at default high effort,
 * ~5s at --effort low in isolation — the margin matters under the
 * concurrent-connect load a gateway restart creates, e.g. the "AgentOS
 * Seats" boot task racing manual reconnects, not steady-state solo timing).
 * KNOWN_REASONING_MODELS is an explicit allowlist (not a heuristic guessed
 * from the id string) — add a model id here only after confirming live via
 * `grok models` that it both accepts --effort and benefits from 'low' on a
 * trivial file-read/dir-list challenge turn.
 */
const KNOWN_REASONING_MODELS = new Set(['grok-4.5']);

export function challengeEffortFor(model: string | undefined): string | undefined {
  return model && KNOWN_REASONING_MODELS.has(model) ? 'low' : undefined;
}

export function cliCommandOf(config: AdapterConfig): string {
  const override = transportOf(config).cliCommand?.trim();
  if (override) return override;
  // Installer doesn't touch PATH (verified live 2026-07-04): prefer the
  // default install location when present, fall back to PATH resolution.
  const installed = defaultGrokInstallPath();
  return existsSync(installed) ? installed : 'grok';
}

/**
 * Raw line-delimited JSON events emitted by `grok --output-format
 * streaming-json`, VERIFIED LIVE against grok 0.2.82 (2026-07-04, this
 * machine). The real vocabulary observed:
 *   {"type":"thought","data":"<token>"}   — reasoning delta
 *   {"type":"text","data":"<token>"}      — assistant text delta
 *   {"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
 * Session id arrives ONLY on the `end` event, camelCase. The Claude-style
 * fields below are retained as defensive fallbacks for other builds.
 */
export interface GrokStreamJsonEvent {
  type: string;
  /** Token payload on `thought`/`text` delta events (verified live). */
  data?: string;
  /** Session id on the `end` event (verified live, camelCase). */
  sessionId?: string;
  stopReason?: string;
  requestId?: string;
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

/** Session id from either the live schema (`sessionId`, end event) or Claude-style `session_id`. */
function sessionIdIn(ev: GrokStreamJsonEvent): string | undefined {
  if (typeof ev.sessionId === 'string' && ev.sessionId) return ev.sessionId;
  if (typeof ev.session_id === 'string' && ev.session_id) return ev.session_id;
  return undefined;
}

export interface CliInvocation {
  child: GrokChildProcess;
  /** Resolves with the session id captured from the first stream event, if any. */
  sessionId: Promise<string | undefined>;
  events: AsyncIterable<GrokStreamJsonEvent>;
  /** Resolves when the process exits (0 = clean). */
  exitCode: Promise<number | null>;
}

/**
 * Spawn `grok -p "<prompt>" --output-format streaming-json [--resume <id>]
 * [--allowed-tools <list>]` and parse newline-delimited JSON off stdout.
 *
 * NEVER used to read files on the adapter's own behalf — this is purely a
 * transport for driving the CLI's own turn; any filesystem access it reports
 * happened inside the CLI's own tool-use, not this process. This is the same
 * invariant claude-code/src/cliProcess.ts documents, and it is why the
 * nonce-file challenge in index.ts drives a real CLI turn instead of calling
 * fs.readFile directly.
 */
export function spawnGrokTurn(
  config: AdapterConfig,
  opts: {
    prompt: string;
    resumeSessionId?: string;
    allowedTools?: string[];
    systemPrompt?: string;
    /**
     * Pass --always-approve for this single turn. Grok 0.2.82 CANCELS headless
     * turns that hit a tool-approval prompt (verified live: Shell without this
     * flag → stopReason "Cancelled", with it → EndTurn). Used for the tightly
     * scoped verification turns (nonce-file's single Read-restricted prompt,
     * capability-probe's single Shell-restricted prompt) AND, as of 2026-07-21
     * (Fable ruling M-WM-1/B4-M3), for relay CHAT turns (send()) whose room is
     * in the seat's full-auto allowlist (fullAutoRoomsFor/chatTurnOptionsFor
     * above) — every chat turn outside that allowlist omits this flag and gets
     * RESTRICTED_CHAT_TOOLS instead, so an unlisted room's turn just cancels
     * on Shell/Write rather than running either unattended. This is NOT "never
     * a default for relay chat turns" anymore (that was the pre-ruling
     * contract, superseded here) — it is conditional on room membership.
     */
    alwaysApprove?: boolean;
    /**
     * --effort level for this turn (low|medium|high|xhigh|max). Challenge
     * turns (nonce read, capability probe) are trivial — 'low' cuts the
     * thinking-model latency that was flaking the verifier timeout.
     */
    effort?: string;
  }
): CliInvocation {
  const t = transportOf(config);
  const cmd = cliCommandOf(config);
  const promptFlag = t.promptFlag?.trim() || '-p';
  const outputFormatFlag = t.outputFormatFlag?.trim() || '--output-format';
  const outputFormatValue = t.outputFormatValue?.trim() || 'streaming-json';
  const resumeFlag = t.resumeFlag?.trim() || '--resume';
  const allowedToolsFlag = t.allowedToolsFlag?.trim() || '--tools';
  const systemPromptFlag = t.systemPromptFlag?.trim() || '--system-prompt-override';

  const args = [promptFlag, opts.prompt, outputFormatFlag, outputFormatValue];
  if (opts.resumeSessionId) {
    args.push(resumeFlag, opts.resumeSessionId);
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push(allowedToolsFlag, opts.allowedTools.join(','));
  }
  if (opts.systemPrompt) {
    args.push(systemPromptFlag, opts.systemPrompt);
  }
  if (opts.alwaysApprove) {
    args.push('--always-approve');
  }
  if (opts.effort) {
    args.push('--effort', opts.effort);
  }
  if (t.model) {
    args.push('-m', t.model);
  }
  if (t.extraArgs) args.push(...t.extraArgs);

  const cwd = t.cwd ?? config.workspace ?? process.cwd();
  // spawn() errors with ENOENT on a missing cwd — on a fresh machine the
  // per-agent workspace dir doesn't exist until the first nonce challenge
  // writes into it, so ensure it here.
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

  async function* parse(): AsyncGenerator<GrokStreamJsonEvent> {
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: GrokStreamJsonEvent;
        try {
          parsed = JSON.parse(line) as GrokStreamJsonEvent;
        } catch {
          continue; // ignore malformed/partial line
        }
        const sid = sessionIdIn(parsed);
        if (!sessionIdSettled && sid) {
          sessionIdSettled = true;
          resolveSessionId(sid);
        }
        yield parsed;
      }
    }
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim()) as GrokStreamJsonEvent;
        const sid = sessionIdIn(parsed);
        if (!sessionIdSettled && sid) {
          sessionIdSettled = true;
          resolveSessionId(sid);
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
export function collectStderr(child: GrokChildProcess): { text(): string } {
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { text: () => text };
}
