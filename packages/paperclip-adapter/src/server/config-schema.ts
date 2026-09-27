import type { AdapterConfigSchema } from "../vendor-types.js";
import { DEFAULT_GATEWAY_URL, DEFAULT_SESSION_KEY_STRATEGY, DEFAULT_TIMEOUT_MS } from "./constants.js";
import { INSECURE_REMOTE_HTTP_ESCAPE_HATCH } from "./transport-security.js";

/** Mirrors hermes_gateway/config-schema.ts's shape (design §6). */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "gatewayUrl",
        label: "Gateway URL",
        type: "text",
        required: true,
        default: DEFAULT_GATEWAY_URL,
        hint: "Agent OS gateway base URL, such as http://127.0.0.1:4110. Loopback HTTP is allowed; remote hosts should use HTTPS.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        required: true,
        hint: "The Agent OS gateway's own API key — distinct from any Paperclip-side agent key. Stored as a Paperclip secret reference.",
        meta: { secret: true },
      },
      {
        key: "seatId",
        label: "Seat ID",
        type: "text",
        required: true,
        hint: "The nonce-verified Agent OS gateway seat this Paperclip employee bridges to (e.g. hermes, grok-build). The seat must already be AgentStatus VERIFIED on the gateway.",
      },
      {
        key: "roomId",
        label: "Room ID (optional)",
        type: "text",
        hint: "Pin the bridge to an existing room. The room must exist, not be archived, and already have seatId as a member. Leave blank to find-or-create the default 'Paperclip — <seatId>' room.",
      },
      {
        key: INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
        label: "Dangerously allow remote HTTP",
        type: "toggle",
        default: false,
        hint: "Unsafe dev-only escape hatch. Remote gateways should use HTTPS; loopback HTTP remains allowed.",
      },
      {
        key: "sessionKeyStrategy",
        label: "Session key strategy",
        type: "select",
        default: DEFAULT_SESSION_KEY_STRATEGY,
        options: [
          { value: "issue", label: "Issue scoped" },
          { value: "agent", label: "Agent scoped" },
          { value: "run", label: "Run scoped" },
          { value: "none", label: "None" },
        ],
        hint: "Controls the sessionParams key used to resume the same gateway seat/instance. Issue scoped prevents cross-task memory bleed by default.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: Math.round(DEFAULT_TIMEOUT_MS / 1000),
        hint: "Hard-capped at 600s by the gateway's own bridge wake endpoint regardless of what is configured here.",
      },
      {
        key: "pollIntervalMs",
        label: "Poll interval ms",
        type: "number",
        default: 1_000,
        hint: "Only used for local bookkeeping/backoff around the long-poll call; the wake itself is a single long-held HTTP request, not a poll loop.",
      },
    ],
  };
}
