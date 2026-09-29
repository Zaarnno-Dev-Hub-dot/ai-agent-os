/**
 * Proof-of-Life Verifier — the anti-placeholder system.
 *
 * Owner: Fable 5. Reference implementation; do not modify without review.
 *
 * Status state machine (verifier-owned; adapters and UI never set status):
 * REGISTERED → CONNECTING → CHALLENGED → VERIFIED → (STALE ↔ VERIFIED) → OFFLINE | FAILED
 *
 * SECURITY INVARIANTS
 * 1. The nonce value NEVER leaves this module. The agent receives only the
 *    path of the nonce file; only a session with real filesystem access to its
 *    workspace can return the nonce. (The previous draft leaked the nonce in
 *    the challenge payload, letting any bare LLM echo it back.)
 * 2. Identity is checked against manifest-declared RegExp patterns, and fails
 *    CLOSED on invalid patterns or missing reports.
 * 3. Every challenge is bounded by challengeTimeoutMs — a hung session fails.
 */

import {
  AgentSession,
  AdapterManifest,
  AgentStatus,
  Challenge,
  ChallengeResponse,
  ChallengeType,
} from './types';

export interface VerifierConfig {
  /** Workspace root for nonce files */
  workspaceRoot: string;
  /** Hard deadline per challenge */
  challengeTimeoutMs: number;
  /** Heartbeat interval */
  heartbeatIntervalMs: number;
  /** Missed heartbeats before STALE */
  staleThreshold: number;
  /** Periodic re-verification interval */
  proofOfLifeIntervalHours: number;
}

export interface VerifierDeps {
  /** Write a nonce file into the agent's workspace; returns the absolute path the AGENT can read it at. */
  writeNonceFile: (agentId: string, nonce: string) => Promise<string>;
  /** Best-effort cleanup of a nonce file after the challenge resolves. */
  removeNonceFile?: (path: string) => Promise<void>;
  /** Exercise one manifest-declared capability for real. Throw on failure. */
  probeCapability: (session: AgentSession, capability: string) => Promise<unknown>;
  /** Ask the session to report its identity from inside the harness. */
  getIdentityFromSession: (session: AgentSession) => Promise<{ modelId: string; accountId?: string }>;
}

/** Prose longer than this in place of structured data trips the generic-response detector. */
const GENERIC_PROSE_THRESHOLD = 40;

export class ProofOfLifeVerifier {
  private challengeCounter = 0;

  constructor(
    private readonly config: VerifierConfig,
    private readonly deps: VerifierDeps
  ) {}

  /**
   * Full challenge sequence: identity → nonce-file → capability-probe.
   * Stops at the first failure. Only a clean sweep yields VERIFIED.
   */
  async runFullChallenge(
    agentId: string,
    session: AgentSession,
    manifest: AdapterManifest
  ): Promise<{ status: AgentStatus; responses: ChallengeResponse[] }> {
    const responses: ChallengeResponse[] = [];
    for (const type of ['identity-echo', 'nonce-file', 'capability-probe'] as const) {
      const response = await this.runChallenge(agentId, session, manifest, type);
      responses.push(response);
      if (!response.success) return { status: 'FAILED', responses };
    }
    return { status: 'VERIFIED', responses };
  }

  /** Single challenge (used for re-challenge after reconnect / STALE recovery). */
  async runChallenge(
    agentId: string,
    session: AgentSession,
    manifest: AdapterManifest,
    type: ChallengeType
  ): Promise<ChallengeResponse> {
    switch (type) {
      case 'identity-echo':
        return this.runIdentityEcho(session, manifest);
      case 'nonce-file':
        return this.runNonceFile(agentId, session);
      case 'capability-probe':
        return this.runCapabilityProbe(session, manifest);
    }
  }

  // --------------------------------------------------------------------------

  private async runIdentityEcho(
    session: AgentSession,
    manifest: AdapterManifest
  ): Promise<ChallengeResponse> {
    const challengeId = this.nextChallengeId();
    const start = Date.now();
    const fail = (error: string): ChallengeResponse => ({
      challengeId,
      type: 'identity-echo',
      success: false,
      error,
      latencyMs: Date.now() - start,
    });

    let modelRe: RegExp;
    let accountRe: RegExp | undefined;
    try {
      modelRe = new RegExp(manifest.identity.modelPattern, 'i');
      accountRe = manifest.identity.accountPattern
        ? new RegExp(manifest.identity.accountPattern, 'i')
        : undefined;
    } catch (e) {
      // Fail closed: a manifest with a broken pattern must not verify anything.
      return fail(`Invalid identity pattern in manifest: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const identity = await withTimeout(
        this.deps.getIdentityFromSession(session),
        this.config.challengeTimeoutMs,
        'identity-echo'
      );
      if (!identity.modelId) return fail('Session reported no model id');
      if (!modelRe.test(identity.modelId)) {
        return fail(
          `Identity mismatch: model "${identity.modelId}" does not match manifest pattern /${manifest.identity.modelPattern}/i`
        );
      }
      if (accountRe && !accountRe.test(identity.accountId ?? '')) {
        return fail(
          `Identity mismatch: account "${identity.accountId ?? '(none)'}" does not match /${manifest.identity.accountPattern}/i`
        );
      }
      return {
        challengeId,
        type: 'identity-echo',
        success: true,
        data: { modelId: identity.modelId, accountId: identity.accountId },
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      return fail(`Identity echo failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async runNonceFile(agentId: string, session: AgentSession): Promise<ChallengeResponse> {
    const challengeId = this.nextChallengeId();
    const start = Date.now();
    const nonce = this.generateNonce();
    const fail = (error: string): ChallengeResponse => ({
      challengeId,
      type: 'nonce-file',
      success: false,
      error,
      latencyMs: Date.now() - start,
    });

    let noncePath: string | undefined;
    try {
      noncePath = await this.deps.writeNonceFile(agentId, nonce);

      // INVARIANT 1: the challenge carries the PATH only — never the nonce.
      const challenge: Challenge = {
        type: 'nonce-file',
        challengeId,
        timestamp: Date.now(),
        timeoutMs: this.config.challengeTimeoutMs,
        noncePath,
      };

      const response = await withTimeout(
        session.prove(challenge),
        this.config.challengeTimeoutMs,
        'nonce-file'
      );

      const returned = response.data?.nonce;
      if (returned === nonce) {
        return {
          challengeId,
          type: 'nonce-file',
          success: true,
          data: { nonce },
          latencyMs: Date.now() - start,
        };
      }

      // Generic-response detector: prose in place of the file's contents is the
      // impostor signature (bare LLM APIs answer challenges with plausible text).
      const prose = response.data?.text ?? (returned === undefined ? JSON.stringify(response.data ?? '') : '');
      if (!returned && prose.replace(/[{}"]/g, '').trim().length > GENERIC_PROSE_THRESHOLD) {
        return fail(
          'Generic-response detector: agent answered with prose instead of the nonce file contents — placeholder/impostor suspected'
        );
      }
      return fail(`Nonce mismatch: agent did not return the contents of ${noncePath}`);
    } catch (e) {
      return fail(`Nonce challenge failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (noncePath && this.deps.removeNonceFile) {
        await this.deps.removeNonceFile(noncePath).catch(() => undefined);
      }
    }
  }

  private async runCapabilityProbe(
    session: AgentSession,
    manifest: AdapterManifest
  ): Promise<ChallengeResponse> {
    const challengeId = this.nextChallengeId();
    const start = Date.now();
    const capability = manifest.capabilities[0];
    if (!capability) {
      return {
        challengeId,
        type: 'capability-probe',
        success: false,
        error: 'No capabilities declared in manifest',
        latencyMs: Date.now() - start,
      };
    }
    try {
      const result = await withTimeout(
        this.deps.probeCapability(session, capability),
        this.config.challengeTimeoutMs,
        'capability-probe'
      );
      return {
        challengeId,
        type: 'capability-probe',
        success: true,
        data: {
          capability,
          result: (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 500),
        },
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      return {
        challengeId,
        type: 'capability-probe',
        success: false,
        error: `Capability probe failed for "${capability}": ${e instanceof Error ? e.message : String(e)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  // --------------------------------------------------------------------------

  /** STALE when >= staleThreshold heartbeat intervals have been missed. */
  isStale(lastHeartbeat: number): boolean {
    const missed = Math.floor((Date.now() - lastHeartbeat) / this.config.heartbeatIntervalMs);
    return missed >= this.config.staleThreshold;
  }

  /**
   * Pick the next periodic challenge. nonce-file is the strongest check, so it
   * runs whenever it isn't among the last three responses; otherwise rotate to
   * the least-recently-used type.
   */
  getNextChallengeType(history: ChallengeResponse[]): ChallengeType {
    const recent = history.slice(-3).map((r) => r.type);
    if (!recent.includes('nonce-file')) return 'nonce-file';
    const all: ChallengeType[] = ['identity-echo', 'nonce-file', 'capability-probe'];
    return all.find((t) => !recent.includes(t)) ?? 'nonce-file';
  }

  private generateNonce(): string {
    const rand = () => Math.random().toString(36).slice(2, 10);
    return `pol-${Date.now().toString(36)}-${rand()}${rand()}`;
  }

  private nextChallengeId(): string {
    return `ch-${++this.challengeCounter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Verifier with PRD Phase 1 defaults. workspaceRoot resolves under the repo's data dir. */
export function createVerifier(deps: VerifierDeps, workspaceRoot?: string): ProofOfLifeVerifier {
  return new ProofOfLifeVerifier(
    {
      workspaceRoot:
        workspaceRoot ??
        process.env['AGENT_WORKSPACE_ROOT'] ??
        `${process.cwd()}/data/agent-workspaces`,
      challengeTimeoutMs: 30_000,
      heartbeatIntervalMs: 20_000,
      staleThreshold: 2,
      proofOfLifeIntervalHours: 24,
    },
    deps
  );
}
