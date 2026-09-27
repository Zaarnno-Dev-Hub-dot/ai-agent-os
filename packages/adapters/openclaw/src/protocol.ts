/**
 * OpenClaw Gateway WebSocket protocol — types for the wire shapes documented
 * at docs.openclaw.ai/gateway/protocol and cross-checked against the
 * installed `openclaw` package source (2026.6.11,
 * the global npm install of openclaw) plus a live
 * read-only handshake probe against ws://127.0.0.1:18789 (2026-07-06).
 *
 * HANDSHAKE FIX (2026-07-06): the gateway sends an unsolicited
 * `{type:'event',event:'connect.challenge',payload:{nonce,ts}}` immediately
 * on socket open, and `connect.params.client` requires a `mode` field plus a
 * `client.id` from a closed enum (see CLIENT_ID / CLIENT_MODE below, sourced
 * from `packages/gateway-protocol/src/client-info.ts` in the openclaw
 * package). The previous default `client.id: 'agent-os-gateway'` and the
 * missing `client.mode` both failed with INVALID_REQUEST. Confirmed live:
 * a corrected connect (`client.id: 'openclaw-probe'`, `client.mode: 'probe'`)
 * passes request validation and proceeds straight to AUTH_TOKEN_MISMATCH
 * (i.e. only the token was rejected, not the shape) — see wsClient.ts
 * handshake() for the live-verified request/response cycle.
 *
 * Device identity/signature (v2/v3 payload signing over the challenge nonce)
 * is required for full node/device-paired clients but is NOT required for a
 * `probe`-mode operator connect on loopback with a valid shared gateway
 * token — confirmed live (the rejection was AUTH_TOKEN_MISMATCH, not any
 * DEVICE_AUTH_* code). This adapter intentionally stays in `probe` mode and
 * does not implement device pairing/signing.
 */

/**
 * Canonical client ids accepted in gateway connect payloads (closed enum —
 * see `packages/gateway-protocol/src/client-info.ts` in the openclaw
 * package). Only the ids relevant to a headless automation client are
 * listed; the gateway also accepts several UI/device product ids this
 * adapter will never send.
 */
export const OPENCLAW_CLIENT_ID = 'openclaw-probe';

/**
 * Coarse client mode accepted in gateway connect payloads (closed enum, same
 * source as above: webchat | cli | ui | backend | node | probe | test).
 * `probe` is the correct mode for a read/write automation client that is
 * not a paired device and not the gateway's own in-process backend client.
 */
export const OPENCLAW_CLIENT_MODE = 'probe';

export interface OpenClawTransportConfig {
  /** ws endpoint, default ws://127.0.0.1:18789 */
  endpoint?: string;
  /** Operator token used at handshake. NEVER logged or persisted unredacted — see redactConfig. */
  token?: string;
  /** Named OpenClaw agent workspace this session targets. Omitted = gateway's default agent. */
  agentId?: string;
  /**
   * Client identity declared at handshake. Must be one of the gateway's
   * closed client-id enum (default: 'openclaw-probe'); an arbitrary id is
   * rejected with INVALID_REQUEST. Override only if a future gateway
   * version adds a more specific automation id.
   */
  clientId?: string;
  /**
   * Coarse client mode declared at handshake (required by the gateway;
   * closed enum). Default: 'probe'.
   */
  clientMode?: string;
  /** Override for the identity-echo modelPattern — see manifest.ts comment. Set by onboarding wizard. */
  modelPattern?: string;
  /** Connect/handshake timeout override (ms). */
  handshakeTimeoutMs?: number;
  [key: string]: unknown;
}

export function resolveEndpoint(t: OpenClawTransportConfig): string {
  return t.endpoint?.trim() || 'ws://127.0.0.1:18789';
}

// ---------------------------------------------------------------------------
// Frame envelopes
// ---------------------------------------------------------------------------

export interface ReqFrame<P = unknown> {
  type: 'req';
  id: string;
  method: string;
  params?: P;
}

export interface ResFrame<P = unknown> {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: P;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface EventFrame<P = unknown> {
  type: 'event';
  event: string;
  payload?: P;
  seq?: number;
  stateVersion?: string;
}

export type InboundFrame = ResFrame | EventFrame;

export function isResFrame(f: unknown): f is ResFrame {
  return !!f && typeof f === 'object' && (f as { type?: string }).type === 'res';
}

export function isEventFrame(f: unknown): f is EventFrame {
  return !!f && typeof f === 'object' && (f as { type?: string }).type === 'event';
}

export function isConnectChallengeEvent(
  f: unknown
): f is EventFrame<ConnectChallengePayload> & { event: 'connect.challenge' } {
  return isEventFrame(f) && f.event === 'connect.challenge';
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * Pre-connect challenge the gateway pushes unsolicited immediately on socket
 * open, before any request has been sent: `{type:'event',
 * event:'connect.challenge', payload:{nonce, ts}}`. Live-confirmed against
 * ws://127.0.0.1:18789 (2026-07-06). This adapter does not sign the nonce
 * (see protocol.ts header — device signing is not required for a `probe`
 * connect); the challenge is only captured so handshake() can wait for it
 * before sending `connect`, matching the gateway's expected sequencing.
 */
export interface ConnectChallengePayload {
  nonce: string;
  ts: number;
}

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: { id: string; version: string; platform: string; mode: string };
  role: 'operator';
  scopes: string[];
  auth: { token: string };
}

/**
 * `server`, `features`, and `policy` are required by the gateway's
 * `hello-ok` schema (docs.openclaw.ai/gateway/protocol); `snapshot` is also
 * required by the schema but its shape is deployment-defined and unused by
 * this adapter, so it is typed loosely rather than modeled field-by-field.
 * `auth.deviceToken` and `pluginSurfaceUrls` are optional per the same docs.
 */
export interface HelloOkPayload {
  type: 'hello-ok';
  protocol: number;
  server: { version: string; connId: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: Record<string, unknown>;
  auth: { role: string; scopes: string[]; deviceToken?: string };
  policy: { maxPayload: number; maxBufferedBytes: number; tickIntervalMs: number };
  pluginSurfaceUrls?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Chat / session events (best-effort from docs — see file header)
// ---------------------------------------------------------------------------

export interface ChatEventPayload {
  sessionKey?: string;
  agentId?: string;
  message?: string;
  deltaText?: string;
  messageId?: string;
}

export interface SessionToolEventPayload {
  sessionKey?: string;
  tool?: string;
  toolId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: 'started' | 'completed' | 'failed';
}

export interface SessionMessagePayload {
  sessionKey?: string;
  messageId?: string;
  role?: string;
  content?: string;
  final?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ErrorEventPayload {
  code?: string;
  message?: string;
  recoverable?: boolean;
}
