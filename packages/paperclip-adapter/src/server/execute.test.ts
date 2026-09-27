import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../vendor-types.js";
import { execute, resolveSessionKey } from "./execute.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Employee",
      adapterType: "agentos_gateway",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      gatewayUrl: "http://127.0.0.1:4110",
      apiKey: "test-gateway-key",
      seatId: "hermes",
    },
    context: {
      paperclipWake: { text: "Please pick up the next task." },
    },
    onLog: vi.fn(async () => undefined),
    ...overrides,
  } as AdapterExecutionContext;
}

describe("execute() against a mocked gateway", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("happy path: 200 maps reply to summary/resultJson and sessionParams", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      text: async () =>
        JSON.stringify({
          reply: { messageId: "msg-1", text: "Done. Shipped the fix.", senderId: "hermes", ts: 1_700_000_000_000 },
          roomId: "room-abc",
        }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.provider).toBe("agentos_gateway");
    expect(result.summary).toBe("Done. Shipped the fix.");
    expect(result.resultJson).toMatchObject({ roomId: "room-abc" });
    expect(result.sessionParams).toMatchObject({
      gatewaySeatId: "hermes",
      gatewayInstanceId: "room-abc",
      strategy: "issue",
    });

    // Verify the actual request shape sent to the gateway.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4110/api/bridge/wake");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toMatchObject({
      seatId: "hermes",
      idempotencyKey: "run-123",
    });
    expect(typeof sentBody.prompt).toBe("string");
    expect(sentBody.prompt.length).toBeGreaterThan(0);
  });

  it("timeout: 408 maps to timedOut:true with no reply", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 408,
      text: async () => JSON.stringify({ timedOut: true, roomId: "room-abc" }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("gateway_turn_timeout");
    expect(result.exitCode).toBe(1);
    expect(result.sessionParams).toMatchObject({ gatewaySeatId: "hermes", gatewayInstanceId: "room-abc" });
  });

  it("404 seat_unverified: non-transient error, no errorFamily", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 404,
      text: async () => JSON.stringify({ error: "seat_unverified" }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_seat_unverified");
    expect(result.errorFamily).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toContain("seat");
  });

  it("409 active loop: non-transient room policy rejection", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 409,
      text: async () => JSON.stringify({ error: "Room has an active loop." }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_room_loop_active");
    expect(result.errorFamily).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it("400 missing-field / malformed request: protocol error, no errorFamily", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 400,
      text: async () => JSON.stringify({ error: "seatId, prompt, and idempotencyKey are required." }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_protocol_error");
    expect(result.errorFamily).toBeNull();
  });

  it("malformed (non-JSON) response body does not throw and is treated as an error", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 500,
      text: async () => "<html>not json</html>",
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_upstream_error");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("401 auth failure maps to gateway_auth_failed with a hint message", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 401,
      text: async () => JSON.stringify({ error: "unauthorized" }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_auth_failed");
    expect(result.errorMessage).toContain("apiKey");
  });

  it("429 rate limited is transient_upstream", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 429,
      text: async () => JSON.stringify({ error: "rate limited" }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_rate_limited");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("network failure (fetch rejects) maps to gateway_connect_failed / transient_upstream", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_connect_failed");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("redacts the apiKey from resultJson/errorMeta even on failure", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 500,
      text: async () => JSON.stringify({ error: "boom", apiKey: "test-gateway-key" }),
    });

    const ctx = makeCtx();
    const result = await execute(ctx);

    const serialized = JSON.stringify(result.errorMeta ?? {});
    expect(serialized).not.toContain("test-gateway-key");
  });

  it("missing required config (seatId) short-circuits without calling fetch", async () => {
    const ctx = makeCtx({ config: { gatewayUrl: "http://127.0.0.1:4110", apiKey: "k" } });
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_seat_id_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects remote plain HTTP without the escape hatch", async () => {
    const ctx = makeCtx({
      config: { gatewayUrl: "http://example.com:4110", apiKey: "k", seatId: "hermes" },
    });
    const result = await execute(ctx);

    expect(result.errorCode).toBe("gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP with the escape hatch set", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      text: async () =>
        JSON.stringify({ reply: { messageId: "m", text: "ok", senderId: "hermes", ts: 1 }, roomId: "r" }),
    });
    const ctx = makeCtx({
      config: {
        gatewayUrl: "http://example.com:4110",
        apiKey: "k",
        seatId: "hermes",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });
    const result = await execute(ctx);

    expect(result.errorCode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes roomId through to the request body when configured", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      text: async () =>
        JSON.stringify({ reply: { messageId: "m", text: "ok", senderId: "hermes", ts: 1 }, roomId: "room-xyz" }),
    });
    const ctx = makeCtx({
      config: { gatewayUrl: "http://127.0.0.1:4110", apiKey: "k", seatId: "hermes", roomId: "room-xyz" },
    });
    await execute(ctx);

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.roomId).toBe("room-xyz");
  });
});

describe("resolveSessionKey", () => {
  it("issue strategy scopes by company+agent+issue", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      issueId: "i1",
    });
    expect(key).toBe("paperclip:company:c1:agent:a1:issue:i1");
  });

  it("issue strategy falls back to run id when no issueId", () => {
    const key = resolveSessionKey({
      strategy: "issue",
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      issueId: null,
    });
    expect(key).toBe("paperclip:company:c1:agent:a1:run:r1");
  });

  it("agent strategy scopes by company+agent only", () => {
    const key = resolveSessionKey({
      strategy: "agent",
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      issueId: "i1",
    });
    expect(key).toBe("paperclip:company:c1:agent:a1");
  });

  it("run strategy scopes by run id only", () => {
    const key = resolveSessionKey({
      strategy: "run",
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      issueId: "i1",
    });
    expect(key).toBe("paperclip:run:r1");
  });

  it("none strategy returns null", () => {
    const key = resolveSessionKey({
      strategy: "none",
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      issueId: "i1",
    });
    expect(key).toBeNull();
  });
});
