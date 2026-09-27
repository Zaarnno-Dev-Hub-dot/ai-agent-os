export const ADAPTER_TYPE = "agentos_gateway";
export const ADAPTER_LABEL = "Agent OS Gateway";

/** Mirrors the gateway's own default (bridge.ts DEFAULT_TIMEOUT_MS) so a client
 * that omits timeoutMs gets the same effective timeout the server would apply
 * anyway; we still send it explicitly so testEnvironment/execute agree with
 * what the request actually said. */
export const DEFAULT_TIMEOUT_MS = 570_000;
/** Mirrors the gateway's hard cap (bridge.ts MAX_TIMEOUT_MS). */
export const MAX_TIMEOUT_MS = 600_000;

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4110";

export const DEFAULT_SESSION_KEY_STRATEGY = "issue";

/** Best-effort grace window used only for local bookkeeping around a timeout;
 * the bridge itself already removed the wait server-side on 408. */
export const STOP_GRACE_MS = 10_000;

export const BRIDGE_WAKE_PATH = "/api/bridge/wake";
export const HEALTH_PATH = "/health";
