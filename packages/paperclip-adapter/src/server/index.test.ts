import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("sessionCodec round-trip", () => {
  it("serializes then deserializes back to the same params", () => {
    const params = { gatewaySeatId: "hermes", gatewayInstanceId: "room-abc", strategy: "issue" };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);

    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual(params);
  });

  it("getDisplayId prefers gatewayInstanceId (the resolved roomId) over gatewaySeatId", () => {
    const displayId = sessionCodec.getDisplayId!({
      gatewaySeatId: "hermes",
      gatewayInstanceId: "room-abc",
      strategy: "issue",
    });
    expect(displayId).toBe("room-abc");
  });

  it("getDisplayId falls back to gatewaySeatId when gatewayInstanceId is absent", () => {
    const displayId = sessionCodec.getDisplayId!({ gatewaySeatId: "hermes", strategy: "issue" });
    expect(displayId).toBe("hermes");
  });

  it("serialize returns null for empty/null params", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.serialize({})).toBeNull();
  });

  it("deserialize returns null for non-object raw input", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("not an object")).toBeNull();
    expect(sessionCodec.deserialize([1, 2, 3])).toBeNull();
  });

  it("deserialize ignores unknown/empty raw records", () => {
    expect(sessionCodec.deserialize({ unrelated: "field" })).toBeNull();
  });

  it("round-trips through a JSON-stringify boundary (simulating DB persistence)", () => {
    const params = { gatewaySeatId: "grok-build", gatewayInstanceId: "room-xyz", strategy: "agent" };
    const persisted = JSON.parse(JSON.stringify(sessionCodec.serialize(params)));
    const restored = sessionCodec.deserialize(persisted);
    expect(restored).toEqual(params);
  });
});
