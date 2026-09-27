import type { AdapterSessionCodec } from "../vendor-types.js";

export { execute, resolveSessionKey, createTextRedactor } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * sessionCodec (design §5): shaped like hermes_gateway's
 * (server/index.ts:11-45), over {gatewaySeatId, gatewayInstanceId, strategy}
 * instead of hermes's {hermesRunId, hermesSessionId, sessionKey, strategy}.
 * This lets the Paperclip employee resume the SAME room/seat/instance across
 * heartbeats, and lines up with DESIGN-multi-instance.md's seatId/instanceId
 * model (manifestId#instanceId) — gatewayInstanceId here carries the
 * resolved roomId, which is what "instance" means for this bridge (the
 * room IS the seat's conversational instance from Paperclip's point of view).
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const gatewaySeatId = readString(record.gatewaySeatId);
    const gatewayInstanceId = readString(record.gatewayInstanceId);
    const strategy = readString(record.strategy);
    if (!gatewaySeatId && !gatewayInstanceId) return null;
    return {
      ...(gatewaySeatId ? { gatewaySeatId } : {}),
      ...(gatewayInstanceId ? { gatewayInstanceId } : {}),
      ...(strategy ? { strategy } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const gatewaySeatId = readString(params.gatewaySeatId);
    const gatewayInstanceId = readString(params.gatewayInstanceId);
    const strategy = readString(params.strategy);
    if (!gatewaySeatId && !gatewayInstanceId) return null;
    return {
      ...(gatewaySeatId ? { gatewaySeatId } : {}),
      ...(gatewayInstanceId ? { gatewayInstanceId } : {}),
      ...(strategy ? { strategy } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return readString(params.gatewayInstanceId) ?? readString(params.gatewaySeatId);
  },
};
