/**
 * execute() bridge — the heart of the adapter (design §4).
 *
 * Follows hermes_gateway/execute.ts's control-flow shape (config read ->
 * transport security -> session key -> POST -> await turn -> map result ->
 * redact), substituting our room/message semantics for hermes's /v1/runs:
 * a single POST /api/bridge/wake call IS the "post as seat + await that
 * seat's next turn" step — the gateway's bridge.ts long-polls internally,
 * so there is no separate SSE/event-stream consumption loop here (design §4
 * step 5's "(a) WS observer" recommendation was implemented gateway-side in
 * F2a as the long-poll itself; the adapter just makes one HTTP call and
 * waits for the response).
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../vendor-types.js";
import {
  BRIDGE_WAKE_PATH,
  DEFAULT_GATEWAY_URL,
  DEFAULT_SESSION_KEY_STRATEGY,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "./constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type BridgeHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
};

type BridgeWakeSuccessBody = {
  reply: { messageId: string; text: string; senderId: string; ts: number };
  roomId: string;
};

type BridgeWakeTimeoutBody = {
  timedOut: true;
  roomId: string;
};

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;

type TextRedactor = (value: string) => string;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : DEFAULT_SESSION_KEY_STRATEGY;
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function normalizeGatewayUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

/**
 * Session/seat key (design §5, mirrors hermes_gateway's resolveSessionKey):
 * derived from ctx.agent.companyId + ctx.agent.id + ctx.runId + issueId.
 * This is a LOCAL correlation key for our own sessionParams bookkeeping —
 * it is not sent to the gateway (the gateway keys rooms by seatId + exact
 * room name, per bridge.ts's find-or-create-by-name contract).
 */
export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function sanitizeSensitiveText(value: string): string {
  return value.replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** createTextRedactor() — provider-agnostic secret redaction (design §4.8), mirrors hermes_gateway's. */
export function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [
    ...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4)),
  ]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({ secret, regex: new RegExp(escapeRegExp(secret), "g") }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(
  value: unknown,
  keyPath: string[] = [],
  depth = 0,
  redactText: TextRedactor = sanitizeSensitiveText,
): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500 ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]` : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

/**
 * classifyHttpError() (design §7 table): maps bridge HTTP responses to
 * errorCode/errorFamily. Distinct from hermes_gateway's classifyHttpError —
 * our bridge uses 400/404/409/408, not hermes's REST run-CRUD codes.
 */
function classifyHttpError(status: number, body: unknown): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "gateway_auth_failed", family: null };
  if (status === 404) {
    const record = asRecord(body);
    if (nonEmpty(record?.error) === "seat_unverified") return { code: "gateway_seat_unverified", family: null };
    return { code: "gateway_seat_unverified", family: null };
  }
  if (status === 409) return { code: "gateway_room_loop_active", family: null };
  if (status === 400) return { code: "gateway_protocol_error", family: null };
  if (status === 429) return { code: "gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "gateway_upstream_error", family: "transient_upstream" };
  return { code: "gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;
  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * POST /api/bridge/wake and await its response. The gateway itself holds the
 * HTTP response open (long-polls) until the seat's next message.new fires in
 * the room, or until its own timeoutMs elapses (408). There is no separate
 * client-side polling loop: this fetch's AbortSignal is our only timeout
 * enforcement on top of whatever the gateway does server-side.
 */
async function postBridgeWake(input: {
  baseUrl: URL;
  apiKey: string;
  seatId: string;
  prompt: string;
  roomId: string | null;
  idempotencyKey: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<{ status: number; body: unknown }> {
  const url = apiUrl(input.baseUrl, BRIDGE_WAKE_PATH);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        seatId: input.seatId,
        prompt: input.prompt,
        ...(input.roomId ? { roomId: input.roomId } : {}),
        idempotencyKey: input.idempotencyKey,
        timeoutMs: input.timeoutMs,
      }),
      signal: input.signal,
    });
  } catch (err) {
    const fetchErr = new Error(`Agent OS gateway request failed: ${fetchFailureMessage(err)}`) as BridgeHttpError;
    fetchErr.code = "gateway_connect_failed";
    throw fetchErr;
  }
  const body = await readResponseJson(response);
  return { status: response.status, body };
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  const wake = asRecord(ctx.context.paperclipWake);
  const wakeText =
    nonEmpty(wake?.text) ??
    nonEmpty(wake?.prompt) ??
    nonEmpty(ctx.context.paperclipTaskMarkdown) ??
    "Continue your work.";
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company, bridged to Agent OS gateway seat via the agentos_gateway adapter.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    "",
    "Execution contract:",
    "- Take concrete action in this turn when the task is actionable.",
    "- Do not stop at a plan unless the task asks for planning only.",
    "- Leave durable progress and reply with a clear final disposition.",
    "",
    wakeText,
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

function errorResult(err: unknown, redactText: TextRedactor = sanitizeSensitiveText, seatId?: string): AdapterExecutionResult {
  const bridgeError = err as BridgeHttpError;
  const code = bridgeError.code ?? "gateway_protocol_error";
  const classified = bridgeError.status ? classifyHttpError(bridgeError.status, bridgeError.body) : null;
  const baseMessage = bridgeError.message ? redactText(bridgeError.message) : "Agent OS gateway bridge request failed.";
  // The gateway's 404 body is just { error: 'seat_unverified' } — the seat id
  // never comes back in the body, so name the seat we ASKED for instead.
  const errorMessage =
    code === "gateway_auth_failed"
      ? `${baseMessage}. Check adapterConfig.apiKey matches the Agent OS gateway's own API key.`
      : code === "gateway_seat_unverified"
        ? `${baseMessage}. Re-run onboarding / re-verify seat${seatId ? ` "${seatId}"` : ""}.`
        : baseMessage;
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorFamily: classified?.family ?? (code === "gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: bridgeError.retryNotBefore ?? null,
    errorMessage,
    errorMeta: {
      ...(bridgeError.status ? { status: bridgeError.status } : {}),
      ...(bridgeError.body ? { body: redactForLog(bridgeError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
    provider: "agentos_gateway",
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const gatewayUrlValue = nonEmpty(ctx.config.gatewayUrl) ?? DEFAULT_GATEWAY_URL;
  const baseUrl = normalizeGatewayUrl(gatewayUrlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "gateway_url_invalid",
      errorMessage: `Invalid Agent OS gatewayUrl: ${gatewayUrlValue}`,
      provider: "agentos_gateway",
    };
  }

  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
      provider: "agentos_gateway",
    };
  }

  const apiKey = nonEmpty(ctx.config.apiKey);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "gateway_api_key_missing",
      errorMessage: "Agent OS gateway adapter requires apiKey.",
      provider: "agentos_gateway",
    };
  }

  const seatId = nonEmpty(ctx.config.seatId);
  if (!seatId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "gateway_seat_id_missing",
      errorMessage: "Agent OS gateway adapter requires seatId.",
      provider: "agentos_gateway",
    };
  }

  const roomId = nonEmpty(ctx.config.roomId);
  const strategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: issueIdFromContext(ctx),
  });

  const timeoutSecConfig = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_MS / 1000);
  const requestedTimeoutMs = timeoutSecConfig > 0 ? Math.ceil(timeoutSecConfig * 1000) : DEFAULT_TIMEOUT_MS;
  // Mirror the gateway's own clamp (bridge.ts resolveTimeoutMs) so local
  // bookkeeping and the value we send agree with what the server will do:
  // non-finite/<=0 falls back to default, otherwise capped at MAX_TIMEOUT_MS.
  const timeoutMs = Math.min(requestedTimeoutMs, MAX_TIMEOUT_MS);

  const idempotencyKey = ctx.runId;
  const prompt = buildPrompt(ctx);
  const redactText = createTextRedactor([apiKey, sessionKey]);

  await ctx.onMeta?.({
    adapterType: "agentos_gateway",
    command: "POST /api/bridge/wake",
    commandArgs: [apiUrl(baseUrl, BRIDGE_WAKE_PATH)],
    context: {
      runId: ctx.runId,
      seatId,
      roomId: roomId ?? null,
      timeoutMs,
      sessionKeyStrategy: strategy,
    },
  });
  await ctx.onLog(
    "stdout",
    `[agentos-gateway] waking seat=${seatId} room=${roomId ?? "(default)"} timeoutMs=${timeoutMs} idempotencyKey=${idempotencyKey}\n`,
  );

  // Race the fetch itself against a local timer slightly beyond timeoutMs so
  // a hung TCP connection can't wedge the run past the gateway's own budget
  // (the gateway is expected to answer with 408 at timeoutMs; this is a
  // belt-and-suspenders client-side ceiling, not the primary timeout signal).
  const controller = new AbortController();
  const localCeilingMs = timeoutMs + 15_000;
  const localTimer = setTimeout(() => controller.abort(), localCeilingMs);

  try {
    const { status, body } = await postBridgeWake({
      baseUrl,
      apiKey,
      seatId,
      prompt,
      roomId,
      idempotencyKey,
      timeoutMs,
      signal: controller.signal,
    });
    clearTimeout(localTimer);

    await ctx.onLog(
      "stdout",
      `[agentos-gateway] response status=${status} body=${stringifyForLog(redactForLog(body, [], 0, redactText), 4_000)}\n`,
    );

    if (status === 408) {
      const timeoutBody = asRecord(body) as BridgeWakeTimeoutBody | null;
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorCode: "gateway_turn_timeout",
        errorMessage: `Agent OS gateway seat "${seatId}" did not reply within ${timeoutMs}ms.`,
        provider: "agentos_gateway",
        resultJson: {
          roomId: timeoutBody?.roomId ?? roomId ?? null,
          timedOut: true,
        },
        sessionParams: {
          gatewaySeatId: seatId,
          gatewayInstanceId: timeoutBody?.roomId ?? roomId ?? null,
          strategy,
        },
        sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
      };
    }

    if (status < 200 || status >= 300) {
      const classified = classifyHttpError(status, body);
      const httpErr = new Error(`Agent OS gateway HTTP ${status}`) as BridgeHttpError;
      httpErr.status = status;
      httpErr.code = classified.code;
      httpErr.body = body;
      throw httpErr;
    }

    const successBody = body as BridgeWakeSuccessBody;
    const replyText = nonEmpty(successBody?.reply?.text) ?? "";
    const redactedReply = redactText(replyText);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "agentos_gateway",
      summary: redactedReply.slice(0, 2_000) || null,
      resultJson: {
        roomId: successBody.roomId,
        reply: {
          messageId: successBody.reply?.messageId ?? null,
          text: redactedReply,
          senderId: successBody.reply?.senderId ?? null,
          ts: successBody.reply?.ts ?? null,
        },
      },
      sessionId: sessionKey ? redactText(sessionKey) : null,
      sessionParams: {
        gatewaySeatId: seatId,
        gatewayInstanceId: successBody.roomId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : (successBody.roomId ?? null),
    };
  } catch (err) {
    clearTimeout(localTimer);
    if (controller.signal.aborted && !(err as BridgeHttpError)?.status) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorCode: "gateway_turn_timeout",
        errorMessage: `Agent OS gateway seat "${seatId}" did not respond (client-side ceiling of ${localCeilingMs}ms exceeded).`,
        provider: "agentos_gateway",
        sessionParams: {
          gatewaySeatId: seatId,
          gatewayInstanceId: roomId ?? null,
          strategy,
        },
      };
    }
    return errorResult(err, redactText, seatId);
  }
}
