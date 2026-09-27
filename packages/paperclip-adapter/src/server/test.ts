import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../vendor-types.js";
import { HEALTH_PATH } from "./constants.js";
import {
  allowsInsecureRemoteHttp,
  isLoopbackHostname,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
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

function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;
  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

/** testEnvironment(): probes the gateway's /health endpoint (design §3/§8). */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const gatewayUrl = asString(ctx.config.gatewayUrl).trim();
  const apiKey = asString(ctx.config.apiKey).trim();
  const seatId = asString(ctx.config.seatId).trim();

  if (!gatewayUrl) {
    checks.push({
      code: "agentos_gateway_url_missing",
      level: "error",
      message: "Agent OS gateway adapter requires gatewayUrl.",
      hint: "Set gatewayUrl, for example http://127.0.0.1:4110.",
    });
  }

  const parsed = gatewayUrl ? normalizeGatewayUrl(gatewayUrl) : null;
  if (gatewayUrl && !parsed) {
    checks.push({
      code: "agentos_gateway_url_invalid",
      level: "error",
      message: "gatewayUrl must be an http:// or https:// URL.",
    });
  }

  if (!apiKey) {
    checks.push({
      code: "agentos_gateway_api_key_missing",
      level: "error",
      message: "Agent OS gateway adapter requires apiKey.",
      hint: "Set the gateway's own API key into adapterConfig.apiKey.",
    });
  }

  if (!seatId) {
    checks.push({
      code: "agentos_gateway_seat_id_missing",
      level: "error",
      message: "Agent OS gateway adapter requires seatId.",
      hint: "Set seatId to a nonce-verified gateway seat (e.g. hermes, grok-build).",
    });
  }

  if (parsed && isRemotePlainHttp(parsed) && !allowsInsecureRemoteHttp(ctx.config)) {
    checks.push({
      code: "agentos_gateway_plain_http_remote_denied",
      level: "error",
      message: remotePlainHttpDeniedMessage(parsed.hostname),
      hint: "Use https:// for remote gateways. Loopback http://localhost and http://127.0.0.1 remain allowed.",
    });
  } else if (parsed && isRemotePlainHttp(parsed)) {
    checks.push({
      code: "agentos_gateway_plain_http_remote_unsafe_allowed",
      level: "warn",
      message: "Unsafe dev escape hatch enabled for non-loopback HTTP gateway traffic.",
      hint: "Remove the escape hatch and use HTTPS before pointing this adapter at a real gateway.",
    });
  } else if (parsed?.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    checks.push({
      code: "agentos_gateway_loopback_http_allowed",
      level: "info",
      message: "Loopback HTTP gateway URL is allowed.",
    });
  }

  if (checks.some((check) => check.level === "error") || !parsed || !apiKey) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const healthUrl = apiUrl(parsed, HEALTH_PATH);
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(2_000),
    });
    checks.push({
      code: response.ok ? "agentos_gateway_health_ok" : "agentos_gateway_health_failed",
      level: response.ok ? "info" : "error",
      message: response.ok
        ? "Agent OS gateway health endpoint is reachable."
        : `Agent OS gateway health endpoint returned HTTP ${response.status}.`,
      hint: response.ok
        ? undefined
        : "Check gatewayUrl, apiKey, and that the gateway is reachable from Paperclip.",
    });
  } catch (err) {
    checks.push({
      code: "agentos_gateway_health_unreachable",
      level: "error",
      message: "Could not reach the Agent OS gateway health endpoint.",
      detail: errorDetail(err),
      hint: "Check gatewayUrl and make sure the gateway is running where Paperclip can reach it.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
