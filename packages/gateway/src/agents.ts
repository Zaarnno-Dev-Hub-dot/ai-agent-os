import { mkdir, writeFile, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';
import {
  AdapterConfig,
  AdapterManifest,
  AgentAdapter,
  AgentSession,
  AgentState,
  AgentStatus,
  ChallengeResponse,
  ProofOfLifeVerifier,
  redactConfig,
} from '@agent-os/shared';
import { hermesAdapter, getIdentityFromHermesSession } from '@agent-os/adapters-hermes';
import { claudeCodeAdapter, getIdentityFromClaudeCodeSession } from '@agent-os/adapters-claude-code';
import { grokBuildAdapter, getIdentityFromGrokBuildSession } from '@agent-os/adapters-grok-build';
import { openclawAdapter, getIdentityFromOpenClawSession } from '@agent-os/adapters-openclaw';
import { ollamaAdapter, getIdentityFromOllamaSession } from '@agent-os/adapters-ollama';
import { codexAdapter, getIdentityFromCodexSession } from '@agent-os/adapters-codex';
import { opencodeAdapter, getIdentityFromOpencodeSession } from '@agent-os/adapters-opencode';
import { cursorAdapter, getIdentityFromCursorSession } from '@agent-os/adapters-cursor';
import type { RelayDeps } from './relay.js';
import { addAgentToRoom, registerAgentRelay, unregisterAgentRelay } from './relay.js';
import { isAttestedManifest, runAttestedChallenge } from './attestedVerifier.js';

/**
 * Per-adapter identity resolution. Each adapter owns how it reports identity
 * from inside its own session (Hermes: /v1/models; Claude Code: the CLI's own
 * self-report) — the registry just maps adapter id -> its adapter + helper.
 * Onboarding a new harness means adding one entry here, nothing else.
 */
interface AdapterRegistration {
  adapter: AgentAdapter;
  getIdentityFromSession: (session: AgentSession) => Promise<{ modelId: string; accountId?: string }>;
}

const adaptersByManifestId: Record<string, AdapterRegistration> = {
  hermes: { adapter: hermesAdapter, getIdentityFromSession: getIdentityFromHermesSession },
  'claude-code': { adapter: claudeCodeAdapter, getIdentityFromSession: getIdentityFromClaudeCodeSession },
  'grok-build': { adapter: grokBuildAdapter, getIdentityFromSession: getIdentityFromGrokBuildSession },
  openclaw: { adapter: openclawAdapter, getIdentityFromSession: getIdentityFromOpenClawSession },
  ollama: { adapter: ollamaAdapter, getIdentityFromSession: getIdentityFromOllamaSession },
  codex: { adapter: codexAdapter, getIdentityFromSession: getIdentityFromCodexSession },
  opencode: { adapter: opencodeAdapter, getIdentityFromSession: getIdentityFromOpencodeSession },
  cursor: { adapter: cursorAdapter, getIdentityFromSession: getIdentityFromCursorSession },
};

export function registerAdapter(manifestId: string, registration: AdapterRegistration): void {
  adaptersByManifestId[manifestId] = registration;
}

/**
 * The STATIC roster of manifest ids this build knows how to adapt for
 * (docs/DESIGN-agent-dossiers-surface.md F10) — every key of the registry
 * above, at whatever point the caller reads it. Deliberately NOT the
 * connected/VERIFIED `agents` map: that reflects who happens to be online
 * right now, which would make a down seat's dossier unreadable (F11) and
 * would let a seat that merely disconnects mid-session lose roster
 * membership between two reads of the same request. registerAdapter() can
 * still grow this set at runtime (tests do), but it never shrinks except at
 * process start — it is never touched by connectAgent/disconnectAgent.
 */
export function knownManifestIds(): string[] {
  return Object.keys(adaptersByManifestId);
}

// ============================================================================
// Multi-instance seats (docs/DESIGN-multi-instance.md)
//
// One manifest (adapter code, identity patterns, billing) can back multiple
// SEATS — separate authenticated sessions of the same harness (e.g. two
// Claude Code subscriptions). The manifest registry above stays keyed by
// manifestId; everything that used to assume agentId === manifestId (the
// agents/workers/verifier maps, workspace dirs, cost + relay bookkeeping) is
// keyed by seatId instead, derived here.
// ============================================================================

/** Slug rule for instanceId, per the design note. '#' is already excluded by this charset. */
export const INSTANCE_ID_PATTERN = /^[a-z0-9-]{1,16}$/;

/**
 * true when instanceId is a legal slug. Absent/undefined is NOT validated
 * here (that's "no instance requested" — callers check presence separately);
 * this only judges a non-empty candidate string.
 */
export function isValidInstanceId(instanceId: string): boolean {
  return INSTANCE_ID_PATTERN.test(instanceId);
}

/**
 * Seat id = manifestId when instanceId is absent or 'main' (BACK-COMPAT: this
 * is the id every existing room/alias/workspace already uses), else
 * `${manifestId}#${instanceId}`. Callers must validate instanceId with
 * isValidInstanceId() before calling this for any value that didn't just come
 * from that check — this function does not re-validate.
 */
export function deriveSeatId(manifestId: string, instanceId?: string): string {
  // '#' is the seat separator — a manifestId containing it would make seat
  // ids ambiguous to parse apart. The closed adapter registry already makes
  // this unreachable; this assert removes the reliance on that staying true
  // (adversarial-review hardening, 7/7).
  if (manifestId.includes('#')) {
    throw new Error(`manifestId must not contain '#': ${manifestId}`);
  }
  if (!instanceId || instanceId === 'main') return manifestId;
  return `${manifestId}#${instanceId}`;
}

/**
 * Per-seat display name: instanceLabel wins if given; otherwise the shared
 * manifest's displayName, suffixed with the instance slug so two seats of the
 * same harness are distinguishable in the UI even with no label set.
 */
export function seatDisplayName(
  manifest: AdapterManifest,
  instanceId: string | undefined,
  instanceLabel: string | undefined
): string {
  if (instanceLabel) return instanceLabel;
  if (!instanceId || instanceId === 'main') return manifest.displayName;
  return `${manifest.displayName} — ${instanceId}`;
}

/**
 * Per-seat "housed in" label (owner-directed, right-hand agent
 * info panel): WHICH ENVIRONMENT this seat's compute actually runs in (e.g.
 * "Laptop · Claude Code CLI -> Anthropic cloud"). packages/shared's
 * AdapterManifest has no `source` field (frozen) — each adapter's manifest.ts
 * instead declares it via a locally-widened type (same idiom as ollama's
 * manifest.ts `AttestedAdapterManifest`/`verification`), read here via an
 * endpoint-typed cast (same idiom as attestedVerifier.ts's isAttestedManifest).
 * `config.transport.source`, when a non-blank string, overrides the
 * manifest's static default for THIS seat only — `AdapterConfig.transport`
 * is already `Record<string, unknown>` (no wire-schema change), so a future
 * second seat of an existing harness on a different machine (e.g.
 * hermes#remote on a remote machine) can say so without a code change. Absent
 * manifest declaration (pre-this-feature adapter, or a test fixture) falls
 * back to 'unknown' rather than throwing — same "absent = unknown" spirit
 * as HealthReport's optional fields elsewhere in this codebase.
 */
export function resolveAgentSource(manifest: AdapterManifest, config: AdapterConfig): string {
  const override = config.transport?.source;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const declared = (manifest as AdapterManifest & { source?: string }).source;
  return declared && declared.trim() ? declared : 'unknown';
}

/**
 * Reads the already-resolved `source` off a per-seat manifest — connectAgent
 * bakes resolveAgentSource's result into `AgentState.manifest.source` once,
 * at connect time (same "resolve once, read many" shape as displayName), so
 * every later reader (index.ts's buildStateSync, dossiers, etc.) just reads
 * it back via this same endpoint-typed cast rather than re-resolving.
 */
/**
 * Per-seat identity pattern: `transport.modelPattern` (a RegExp source — the
 * Add agent panel derives one from the model name the user typed, e.g.
 * '^gpt-4o') replaces the manifest's default identity pattern for THIS seat
 * only. That is what lets one generic adapter (the OpenAI-compatible one)
 * verify any model without a code change. Throws on an invalid or oversized
 * pattern.
 */
export function applyModelPatternOverride(manifest: AdapterManifest, config: AdapterConfig): AdapterManifest {
  const raw = config.transport?.modelPattern;
  if (typeof raw !== 'string' || !raw.trim()) return manifest;
  const pattern = raw.trim();
  if (pattern.length > 200) throw new Error('transport.modelPattern is too long (max 200 characters).');
  try {
    new RegExp(pattern, 'i');
  } catch (e) {
    throw new Error(`transport.modelPattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ...manifest, identity: { ...manifest.identity, modelPattern: pattern } };
}

export function manifestSource(manifest: AdapterManifest): string {
  return (manifest as AdapterManifest & { source?: string }).source ?? 'unknown';
}

/**
 * Per-seat last-successful-room-message timestamp (2026-07-28, router-side
 * last-reply surfacing). Motivation: VERIFIED/lastHeartbeat alone proved
 * insufficient to catch a silently-dead seat — a seat no-showed 2 panels
 * while its status stayed VERIFIED throughout (heartbeat only proves the
 * session answered a liveness ping, never that it produced a real room
 * reply). AgentState has no field for this (packages/shared frozen) — same
 * additive-property-via-endpoint-typed-cast idiom as manifestSource above.
 * Unlike `source` (resolved once at connect time and baked into `manifest`,
 * which is itself reconstructed fresh per connect() call), this is mutated
 * in place on the SAME AgentState object across its whole connection
 * lifetime — same mutability shape as `lastHeartbeat`, so it lives directly
 * on the state object rather than nested in `manifest`. Storage is a plain
 * runtime property (not a Map/WeakMap keyed elsewhere) so it needs no
 * separate cleanup on disconnect — it is scoped to and garbage-collected
 * with whatever AgentState object connectAgent created for the seat.
 */
export function recordSeatReply(state: AgentState, atMs: number): void {
  (state as AgentState & { lastReplyAt?: string }).lastReplyAt = new Date(atMs).toISOString();
}

/**
 * Reads back the timestamp recordSeatReply wrote (ISO 8601, UTC) — same
 * endpoint-typed-cast idiom as manifestSource. Undefined means this seat's
 * current connection has not yet produced a successful room message (a
 * fresh connect(), or a seat that only ever answers heartbeats/challenges).
 */
export function seatLastReplyAt(state: AgentState): string | undefined {
  return (state as AgentState & { lastReplyAt?: string }).lastReplyAt;
}

// ============================================================================
// Remote-workspace nonce writer (docs/DESIGN-permanent-agents-2026-07-18.md,
// "hermes#remote seat"): the frozen verifier's nonce-file challenge writes a
// nonce somewhere the AGENT can read it back from, to prove real filesystem
// access to ITS OWN workspace. Every seat before hermes#remote runs on this
// laptop, so "the agent's workspace" == a local dir was always the same
// place the gateway itself runs — writeNonceFile just wrote there directly.
// hermes#remote's agent runs on a remote machine; a laptop-local path is
// unreadable to it BY DESIGN (the nonce must never travel in-band to bridge
// that gap — see verifier.ts SECURITY INVARIANTS). A seat's transport may
// declare `workspace: { kind: 'ssh', host, dir }` to redirect ONLY that
// seat's nonce writes over SSH onto `host`, returning the machine-LOCAL
// absolute path under `dir` — the agent still proves access to its own
// workspace, just reached over SSH instead of the local fs. Every seat with
// no `workspace` declared is byte-identical to before this existed.
// ============================================================================

export interface SshWorkspaceConfig {
  kind: 'ssh';
  host: string;
  dir: string;
}

/**
 * Reads+validates `config.transport.workspace` (same "endpoint-typed cast off
 * the untyped Record" idiom as resolveAgentSource above). Anything short of a
 * complete `{kind:'ssh', host, dir}` (wrong/missing kind, blank host or dir,
 * not an object) resolves to undefined — i.e. local nonce-write behavior —
 * rather than throwing, so a malformed transport config degrades to the safe
 * default instead of taking a seat down at connect time.
 */
export function resolveSshWorkspace(config: AdapterConfig): SshWorkspaceConfig | undefined {
  const workspace = config.transport?.workspace as
    | { kind?: unknown; host?: unknown; dir?: unknown }
    | undefined;
  if (!workspace || typeof workspace !== 'object') return undefined;
  if (workspace.kind !== 'ssh') return undefined;
  if (typeof workspace.host !== 'string' || !workspace.host.trim()) return undefined;
  if (typeof workspace.dir !== 'string' || !workspace.dir.trim()) return undefined;
  return { kind: 'ssh', host: workspace.host.trim(), dir: workspace.dir.trim() };
}

/** ConnectTimeout for the ssh handshake itself (seconds, ssh's own -o unit). */
const SSH_CONNECT_TIMEOUT_S = 8;
/**
 * Hard wall-clock bound on a whole ssh invocation (connect + remote command).
 * ConnectTimeout only bounds the handshake — a remote command that hangs
 * after connecting (e.g. `cat` blocked on a full remote disk) would not be
 * caught by it, and verifier.ts's own challengeTimeoutMs does NOT wrap
 * writeNonceFile (runNonceFile only wraps session.prove in withTimeout) — so
 * this is the only thing standing between an SSH hiccup and the challenge
 * hanging forever. "Fail cleanly, not hang" per the design note.
 */
const SSH_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Single-quotes a value for embedding in the REMOTE shell command string ssh
 * passes along — never a local shell (spawn() below has no shell of its own
 * involved). Trusted inputs only (transport-config host/dir, generated
 * filenames drawn from a closed manifestId/instanceId charset): this is
 * defense in depth, not a general-purpose shell-escaping utility.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `ssh -o BatchMode=yes -o ConnectTimeout=<n> <host> <remoteCommand>`,
 * optionally piping `input` to stdin and closing it. `input` (the nonce, for
 * every caller in this module) is the ONLY channel it ever travels over — it
 * is never interpolated into `remoteCommand` or any other argv element, so it
 * can never show up in a local or remote process listing or in a log line
 * built from `args`. BatchMode=yes makes ssh fail fast instead of blocking on
 * a host-key/passphrase prompt (no TTY here to answer one anyway). Never
 * throws — resolves `{ code: null, stderr }` on spawn failure, process
 * error, or timeout, so callers always get a clean failure to raise as an
 * Error rather than an unhandled rejection or a hang.
 */
export function runSshCommand(
  host: string,
  remoteCommand: string,
  opts: { input?: string; timeoutMs?: number } = {}
): Promise<{ code: number | null; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? SSH_COMMAND_TIMEOUT_MS;
  return new Promise((resolve) => {
    const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`, host, remoteCommand];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ssh', args, {
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, stderr: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stderr: stderr.trim() || `ssh command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr: stderr.trim() });
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (e) => {
      stderr = stderr ? `${stderr}\n${e.message}` : e.message;
      finish(null);
    });
    child.on('exit', (code) => finish(code));

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

/** Writes the nonce onto `ws.host` under `ws.dir` over SSH and returns the remote absolute path. */
async function writeRemoteNonceFile(ws: SshWorkspaceConfig, agentId: string, nonce: string): Promise<string> {
  const dir = ws.dir.replace(/\/+$/, '');
  const filename = `${agentId}-${Math.random().toString(36).slice(2, 10)}.nonce`;
  const remotePath = `${dir}/${filename}`;

  const mkdirResult = await runSshCommand(ws.host, `mkdir -p ${shellQuote(dir)}`);
  if (mkdirResult.code !== 0) {
    throw new Error(
      `remote workspace mkdir failed on ${ws.host}:${dir} — ${mkdirResult.stderr || `ssh exited ${mkdirResult.code}`}`
    );
  }

  // `cat > file` with the nonce on stdin: never on the command line (see
  // runSshCommand doc comment) and never logged here either.
  const writeResult = await runSshCommand(ws.host, `cat > ${shellQuote(remotePath)}`, { input: nonce });
  if (writeResult.code !== 0) {
    throw new Error(
      `remote nonce write failed on ${ws.host}:${remotePath} — ${writeResult.stderr || `ssh exited ${writeResult.code}`}`
    );
  }
  return remotePath;
}

/** Best-effort SSH delete, mirroring the local removeNonceFile's swallow-all-errors teardown. */
async function removeRemoteNonceFile(ws: SshWorkspaceConfig, path: string): Promise<void> {
  try {
    await runSshCommand(ws.host, `rm -f ${shellQuote(path)}`);
  } catch {
    /* best-effort */
  }
}

/**
 * Verifiers are cheap (config + deps, no I/O at construction), so we build one
 * per connect with the right adapter's identity resolver bound at construction.
 * No shared mutable state — concurrent connects each carry their own resolver.
 * `remoteWorkspace`, when given, redirects nonce-file I/O for THIS seat only
 * onto `remoteWorkspace.host` over SSH (see the module doc comment above);
 * absent (every seat but hermes#remote today), behavior is byte-identical to
 * before the remote-workspace writer existed.
 */
export function createVerifier(
  workspaceRoot: string,
  getIdentityFromSession: (session: AgentSession) => Promise<{ modelId: string; accountId?: string }>,
  remoteWorkspace?: SshWorkspaceConfig
): ProofOfLifeVerifier {
  return new ProofOfLifeVerifier(
    {
      workspaceRoot,
      // 120s: grok-build's thinking model showed 10-60s per headless turn
      // (measured live 2026-07-04, high variance); challenge turns also run
      // at --effort low to keep typical latency well under this.
      challengeTimeoutMs: 120_000,
      heartbeatIntervalMs: 20_000,
      staleThreshold: 2,
      proofOfLifeIntervalHours: 24,
    },
    {
      writeNonceFile: remoteWorkspace
        ? async (agentId, nonce) => writeRemoteNonceFile(remoteWorkspace, agentId, nonce)
        : async (agentId, nonce) => {
            const dir = join(workspaceRoot, agentId);
            await mkdir(dir, { recursive: true });
            const path = join(dir, `pol-${nonce}.txt`);
            await writeFile(path, nonce, 'utf8');
            return path;
          },
      removeNonceFile: remoteWorkspace
        ? async (path) => removeRemoteNonceFile(remoteWorkspace, path)
        : async (path) => {
            try {
              await unlink(path);
            } catch {
              /* ignore */
            }
          },
      probeCapability: async (session, capability) => {
        const res = await session.prove({
          type: 'capability-probe',
          challengeId: 'probe',
          timestamp: Date.now(),
          timeoutMs: 120_000,
          capability,
        });
        if (!res.success) throw new Error(res.error ?? 'capability probe failed');
        return res.data;
      },
      getIdentityFromSession,
    }
  );
}

// ============================================================================
// Verifier transient-retry (docs/TECH-DEBT.md "Verifier single-shot on
// transient upstream flakes"): grok's backend threw application/problem+json
// for ~a minute on 2026-07-05 and a single nonce/probe attempt landing inside
// that window = FAILED, even though the agent itself was fine. The retry
// wraps AROUND the shared verifier call here at the gateway call-site —
// packages/shared (verifier.ts) is FROZEN, so runFullChallenge itself is
// never touched; this module decides whether to call it a second time.
// ============================================================================

/**
 * True when a challenge failure looks like an upstream blip rather than a
 * genuine verification mismatch — network errors, 5xx responses,
 * application/problem+json bodies (grok's backend's actual failure mode
 * 2026-07-05), and timeouts. Deliberately string-matched against
 * ChallengeResponse.error (the only signal available at this call-site,
 * since shared's verifier.ts is frozen and cannot be changed to pass
 * through a richer error shape) rather than allow-listing challenge types —
 * any challenge (identity-echo, nonce-file, capability-probe) can hit the
 * same upstream hiccup.
 *
 * Deliberately NOT matched: identity/nonce mismatch text ("Identity
 * mismatch", "Nonce mismatch", "did not return the contents", the
 * generic-response detector) — those are genuine verification failures, not
 * transport flakes, and retrying them would just burn 2-5s to reproduce the
 * same, correct FAILED.
 */
export function isTransientChallengeFailure(response: ChallengeResponse): boolean {
  if (response.success) return false;
  const error = (response.error ?? '').toLowerCase();
  if (!error) return false;
  const transientPatterns = [
    /application\/problem\+json/,
    /\btimed?\s*out\b/,
    /\btimeout\b/,
    /\b5\d\d\b/, // 500-599 status codes
    /\becon(nrefused|nreset|nabort)\b/, // Node network error codes
    /\betimedout\b/,
    /\bnetwork error\b/,
    /\bfetch failed\b/,
    /\bsocket hang up\b/,
    /\bservice unavailable\b/,
    /\bbad gateway\b/,
    /\bgateway timeout\b/,
    /\binternal server error\b/,
  ];
  return transientPatterns.some((re) => re.test(error));
}

/** Short backoff window (2-5s) between the one auto-retry and the original attempt, per docs/TECH-DEBT.md. */
function transientRetryBackoffMs(): number {
  return 2_000 + Math.floor(Math.random() * 3_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the full challenge sequence, and — if it FAILED with the LAST
 * response looking transient (see isTransientChallengeFailure) — waits a
 * short backoff and retries the WHOLE sequence exactly once. A genuine
 * mismatch (wrong nonce answer, identity regex fail, etc.) returns
 * immediately with no retry. The second attempt's result (success or
 * failure) is always the one returned — no further retries.
 */
export async function runFullChallengeWithTransientRetry(
  verifier: ProofOfLifeVerifier,
  agentId: string,
  session: AgentSession,
  manifest: AdapterManifest
): Promise<{ status: AgentStatus; responses: ChallengeResponse[] }> {
  const first = await verifier.runFullChallenge(agentId, session, manifest);
  if (first.status !== 'FAILED') return first;

  const lastResponse = first.responses[first.responses.length - 1];
  if (!lastResponse || !isTransientChallengeFailure(lastResponse)) return first;

  console.error(
    `[verifier] transient failure on ${agentId} (${lastResponse.type}): ${lastResponse.error} — retrying once after backoff`
  );
  await sleep(transientRetryBackoffMs());
  return verifier.runFullChallenge(agentId, session, manifest);
}

export interface ConnectAgentOptions {
  /**
   * Multi-instance seat slug (docs/DESIGN-multi-instance.md). Absent/'main'
   * behaves byte-identically to the pre-multi-instance single-seat gateway —
   * seat id collapses to manifestId (deriveSeatId). Must already be validated
   * by the caller (isValidInstanceId) when present and not 'main'; this
   * function throws rather than silently coercing an invalid slug.
   */
  instanceId?: string;
  /** Display label for the seat's card. Falls back to seatDisplayName() when absent. */
  instanceLabel?: string;
}

export async function connectAgent(
  manifestId: string,
  config: AdapterConfig,
  agents: Map<string, AgentState>,
  workspaceRoot: string,
  relay?: { deps: RelayDeps; defaultRoomId: string },
  options?: ConnectAgentOptions
): Promise<{ agentId: string; status: AgentStatus; statusReason?: string }> {
  const registration = adaptersByManifestId[manifestId];
  if (!registration) {
    throw new Error(`Unknown manifest: ${manifestId}`);
  }
  const { adapter, getIdentityFromSession } = registration;

  const instanceId = options?.instanceId;
  if (instanceId && instanceId !== 'main' && !isValidInstanceId(instanceId)) {
    throw new Error(
      `Invalid instanceId "${instanceId}": must match [a-z0-9-]{1,16} (no '#').`
    );
  }

  // Seat id: manifestId when no/'main' instanceId (BACK-COMPAT — every
  // existing room/alias/workspace already keys off this exact id), else
  // `${manifestId}#${instanceId}`. Everything below keys off agentId, i.e.
  // the seat — the manifest registry above stays keyed by manifestId only.
  const agentId = deriveSeatId(manifestId, instanceId);

  // Duplicate-connect guard: if this SEAT is already connecting/verified,
  // return its existing status instead of reconnecting/re-challenging. Two
  // different seats of the same manifest (main + #work) never collide here —
  // they have different agentId keys.
  const existing = agents.get(agentId);
  if (existing && existing.session && existing.status !== 'OFFLINE' && existing.status !== 'FAILED') {
    return { agentId, status: existing.status, statusReason: existing.statusReason };
  }

  // Per-seat manifest: identical to the adapter's shared manifest except
  // displayName, so two seats of the same harness read distinctly on cards/
  // mentions/InspectPanel without touching the adapter registry's manifest
  // object (which stays shared — billing/identity/capabilities are IDENTICAL
  // across instances per the design note). `source` (2026-07-18) is resolved
  // and baked in here too — once, at connect time — so every later reader
  // (buildStateSync, dossiers, etc.) just reads `state.manifest.source` off
  // whatever seat it has, the same way it already reads `displayName`.
  const baseManifest = applyModelPatternOverride(adapter.manifest, config);
  const resolvedSource = resolveAgentSource(adapter.manifest, config);
  const manifest: AdapterManifest = (
    instanceId && instanceId !== 'main'
      ? {
          ...baseManifest,
          displayName: seatDisplayName(baseManifest, instanceId, options?.instanceLabel),
          source: resolvedSource,
        }
      : options?.instanceLabel
        ? { ...baseManifest, displayName: options.instanceLabel, source: resolvedSource }
        : { ...baseManifest, source: resolvedSource }
  ) as AdapterManifest & { source: string };

  const state: AgentState = {
    manifest,
    config: redactConfig(config),
    status: 'CONNECTING',
    lastHeartbeat: Date.now(),
    assignedRooms: existing?.assignedRooms ?? [],
    challengeHistory: [],
  };
  agents.set(agentId, state);

  // Fast-fail path (docs/TECH-DEBT.md "connect-agent.mjs hangs full 300s when
  // a seat binary is missing"): adapter.connect() throwing (binary-not-found,
  // auth-missing, handshake-failed — see e.g. claude-code's
  // verifyBinaryAndAuth) used to propagate straight out of connectAgent,
  // leaving `state` — already `agents.set()` above — stuck at CONNECTING
  // forever. The caller's catch block (gateway/src/index.ts) sent a
  // per-client roomError, which told the REQUESTING client, but never
  // touched agent state or broadcast agent.status, so state.sync and any
  // other listener (scripts/connect-agent.mjs waits on agent.status
  // FAILED/VERIFIED/OFFLINE) never learned the seat left CONNECTING —
  // exactly why the script timed out at its full 300s instead of failing
  // fast. Catch here, flip the seat to FAILED with the adapter's error as
  // statusReason (same shape as the verifier-rejection FAILED path below),
  // and return normally instead of throwing, so the existing agent.status
  // broadcast at the call site picks it up immediately.
  let session: AgentSession;
  try {
    session = await adapter.connect(config);
  } catch (e) {
    state.status = 'FAILED';
    state.statusReason = e instanceof Error ? e.message : String(e);
    state.lastHeartbeat = Date.now();
    return { agentId, status: state.status, statusReason: state.statusReason };
  }
  state.session = session;
  state.status = 'CHALLENGED';

  const remoteWorkspace = resolveSshWorkspace(config);
  const verifier = createVerifier(workspaceRoot, getIdentityFromSession, remoteWorkspace);
  // Verification-tier branch (docs/DESIGN-seat-verification-tiers.md): a
  // manifest declaring `verification: 'attested'` (tool-less HTTP seats,
  // e.g. ollama) runs the parallel attested challenge sequence instead of
  // the frozen full-tier verifier — see attestedVerifier.ts's module doc
  // comment for why this can't be a branch INSIDE verifier.ts. Every other
  // manifest (no `verification` field) is byte-identical to before this
  // tier existed: same call, same retry wrapper.
  const result = isAttestedManifest(adapter.manifest)
    ? await runAttestedChallenge(agentId, session, baseManifest, verifier)
    : await runFullChallengeWithTransientRetry(verifier, agentId, session, baseManifest);
  state.challengeHistory = result.responses;
  state.status = result.status;
  // runFullChallenge stops at the first failed challenge (verifier.ts), so on
  // FAILED the last response IS the failing one — surface its .error as the
  // human-useful reason instead of leaving statusReason undefined (TECH-DEBT
  // "verify-failure statusReason not populated": grok FAILED read reason "-",
  // and diagnosing it required the gate runner instead of the agent card).
  state.statusReason =
    state.status === 'FAILED'
      ? result.responses[result.responses.length - 1]?.error
      : undefined;
  state.lastHeartbeat = Date.now();
  state.health = await session.health();

  if (state.status === 'VERIFIED' && relay?.deps) {
    registerAgentRelay(agentId, session, relay.deps, adapter.manifest.trust);
    if (addAgentToRoom(relay.deps, relay.defaultRoomId, agentId)) {
      state.assignedRooms = [relay.defaultRoomId];
    }
  }

  return { agentId, status: state.status, statusReason: state.statusReason };
}

/**
 * Graceful teardown of a live seat — the inverse of connectAgent. One-off /
 * throwaway seats (multi-instance smoke tests, docs/DESIGN-multi-instance.md:
 * e.g. hermes#judge, claude-code#test) need a clean programmatic way to be shut
 * down. Nothing in the gateway polls health to REAP a seat whose adapter
 * process merely died — there is no heartbeat/stale timer running (the only
 * live intervals are memory re-index and the DB persist tick), so lastHeartbeat
 * is set once at connect and never re-checked. Without an explicit disconnect an
 * abandoned seat stays VERIFIED forever.
 *
 * Symmetric with connectAgent: connectAgent registers the relay worker and
 * flips status up through the challenge ladder; this unregisters the worker,
 * disposes the session, and flips status to OFFLINE ('Graceful disconnect', per
 * AgentStatus). Room membership is deliberately left intact — memberIds may name
 * a seat in any status (relay filters to VERIFIED itself), so an OFFLINE seat
 * simply receives no traffic, and a later reconnect restores its rooms.
 *
 * No-op-safe: an unknown seat, or one with no live session (already OFFLINE/
 * FAILED-and-torn-down, or REGISTERED-but-never-connected), returns
 * { ok: false } so the caller can report it without mutating state or
 * double-disposing. dispose() errors are swallowed — teardown is best-effort
 * (mirrors the verifier's removeNonceFile), and the seat is OFFLINE regardless.
 */
export async function disconnectAgent(
  agentId: string,
  agents: Map<string, AgentState>
): Promise<{ ok: boolean; agentId: string; status?: AgentStatus; error?: string }> {
  const state = agents.get(agentId);
  if (!state || !state.session) {
    return { ok: false, agentId, error: `Unknown or already-disconnected agent: ${agentId}` };
  }

  // Stop the relay worker BEFORE disposing so no queued/next turn can be handed
  // to a session that is about to be torn down (relayMessageToAgents resolves
  // the worker by id — a deleted worker simply receives nothing).
  unregisterAgentRelay(agentId);

  // Drop the live handle and flip status FIRST, before awaiting dispose(): a
  // concurrent duplicate agent.disconnect (or connectAgent's OFFLINE-revival
  // path) then sees a seat with no session and will not double-dispose.
  const session = state.session;
  state.session = undefined;
  state.status = 'OFFLINE';
  state.statusReason = undefined;
  state.health = undefined;
  state.lastHeartbeat = Date.now();

  try {
    await session.dispose();
  } catch {
    /* best-effort teardown — the seat is OFFLINE regardless */
  }

  return { ok: true, agentId, status: state.status };
}