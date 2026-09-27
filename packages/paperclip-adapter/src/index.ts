import type { AdapterSessionManagement, ServerAdapterModule } from "./vendor-types.js";
import { ADAPTER_LABEL, ADAPTER_TYPE } from "./server/constants.js";
import { execute, getConfigSchema, sessionCodec, testEnvironment } from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const models: { id: string; label: string }[] = [];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

export const agentConfigurationDoc = `# agentos_gateway agent configuration

Adapter: agentos_gateway

Use when:
- Paperclip should "hire" an agent that is actually one of our Agent OS
  gateway's nonce-verified seats (hermes, grok-build, openclaw, ...) without
  Paperclip spawning its own copy of that agent.
- Paperclip should wake the seat by posting into an Agent OS room as that
  seat and wait for the seat's reply turn (the gateway's mention-gate).

Don't use when:
- You want a Claude hire — policy is NO claude_local-style Claude hires via
  this bridge (quota). Claude stays conversational in Agent OS; only bridge
  hermes / grok-build / openclaw seats.
- The Agent OS gateway is not reachable from this Paperclip host, or the
  target seat is not yet AgentStatus VERIFIED on the gateway.

Required fields:
- gatewayUrl (string): Agent OS gateway base URL, for example http://127.0.0.1:4110.
- apiKey (string): the gateway's own API key. Sent as Authorization: Bearer <apiKey>.
  Distinct from any Paperclip-side agent key.
- seatId (string): the nonce-verified gateway seat this employee bridges to.

Optional fields:
- roomId (string): pin the bridge to an existing room (must exist, not be
  archived, and already have seatId as a member). Otherwise the gateway
  finds-or-creates a room named exactly "Paperclip — <seatId>" and reuses it
  by exact name on every later wake for that seat.
- sessionKeyStrategy (issue | agent | run | none): defaults to issue.
- timeoutSec (number): defaults to 570s; the gateway hard-caps at 600s
  regardless of what is configured here.
- pollIntervalMs (number): local bookkeeping only — the wake call itself is a
  single long-held HTTP request, not a client-side poll loop.
- dangerouslyAllowInsecureRemoteHttp (boolean): unsafe dev-only escape hatch
  for non-loopback plain HTTP gatewayUrl values.

Runtime mapping:
- Posts POST /api/bridge/wake with { seatId, prompt, roomId?, idempotencyKey,
  timeoutMs? }. idempotencyKey is always ctx.runId.
- On success (200): the seat's reply becomes this run's summary/resultJson,
  and sessionParams records { gatewaySeatId, gatewayInstanceId (the resolved
  roomId), strategy } so the next heartbeat resumes the same room/seat.
- On timeout (408): timedOut:true, no reply; the gateway itself already
  removed the wait server-side, so nothing to clean up on the adapter side.
- On seat_unverified (404) or an auth failure (401/403), this is treated as
  non-transient — re-verify the seat or the apiKey rather than retrying.
- On an active-loop conflict (409), this is also non-transient: the target
  room already has an active loop-lite loop and will not accept a bridge
  wake until that loop ends.

Security guidance:
- Prefer HTTPS or a private overlay network for non-loopback gateway hosts.
- Do not put the gateway apiKey in prompts, comments, logs, or result JSON —
  execute() redacts it via createTextRedactor() before any onLog/resultJson.
- Keep the default issue-scoped session strategy unless shared agent memory
  across tasks is intentional.

No-remote-git contract: not applicable. This is a stateless HTTP bridge with
no execution-workspace cwd — there is no local worktree for this adapter to
persist across runs, so the no-remote-git contract's invariants (never
git push, never assume a remote exists, surface restore failures) have
nothing to attach to here.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: false,
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
