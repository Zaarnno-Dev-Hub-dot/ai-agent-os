import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "./ui-parser.js";

describe("ui-parser on a sample reply", () => {
  it("parses a successful 200 response line into an assistant entry", () => {
    const line = `[agentos-gateway] response status=200 body=${JSON.stringify({
      roomId: "room-abc",
      reply: { messageId: "m1", text: "Task complete.", senderId: "hermes", ts: 1 },
    })}`;
    const entries = parseStdoutLine(line, "2026-07-07T00:00:00.000Z");

    expect(entries).toEqual([
      { kind: "assistant", ts: "2026-07-07T00:00:00.000Z", text: "Task complete." },
    ]);
  });

  it("parses a 408 timeout response line into a system entry", () => {
    const line = `[agentos-gateway] response status=408 body=${JSON.stringify({ timedOut: true, roomId: "room-abc" })}`;
    const entries = parseStdoutLine(line, "ts");

    expect(entries[0]!.kind).toBe("system");
    expect(entries[0]!.text).toMatch(/timed out/i);
  });

  it("parses a 404 seat_unverified response line into a stderr entry", () => {
    const line = `[agentos-gateway] response status=404 body=${JSON.stringify({ error: "seat_unverified" })}`;
    const entries = parseStdoutLine(line, "ts");

    expect(entries[0]!.kind).toBe("stderr");
    expect(entries[0]!.text).toMatch(/not found or not verified/i);
  });

  it("parses a 409 active-loop response line into a stderr entry", () => {
    const line = `[agentos-gateway] response status=409 body=${JSON.stringify({ error: "Room has an active loop." })}`;
    const entries = parseStdoutLine(line, "ts");

    expect(entries[0]!.kind).toBe("stderr");
    expect(entries[0]!.text).toMatch(/active loop/i);
  });

  it("parses a plain [agentos-gateway] pre-request line into a system entry", () => {
    const entries = parseStdoutLine("[agentos-gateway] waking seat=hermes room=(default) timeoutMs=570000 idempotencyKey=run-1", "ts");
    expect(entries[0]).toEqual({ kind: "system", ts: "ts", text: "waking seat=hermes room=(default) timeoutMs=570000 idempotencyKey=run-1" });
  });

  it("passes through unrelated lines as stdout", () => {
    const entries = parseStdoutLine("some unrelated line", "ts");
    expect(entries).toEqual([{ kind: "stdout", ts: "ts", text: "some unrelated line" }]);
  });

  it("returns an empty array for blank lines", () => {
    expect(parseStdoutLine("   ", "ts")).toEqual([]);
    expect(parseStdoutLine("", "ts")).toEqual([]);
  });

  it("strips ANSI escape codes before parsing", () => {
    const esc = String.fromCharCode(27);
    const line = `${esc}[32m[agentos-gateway] waking seat=hermes${esc}[0m`;
    const entries = parseStdoutLine(line, "ts");
    expect(entries[0]!.text).toBe("waking seat=hermes");
  });

  it("handles a malformed JSON body gracefully (no throw)", () => {
    const line = "[agentos-gateway] response status=500 body=not-json-at-all";
    expect(() => parseStdoutLine(line, "ts")).not.toThrow();
    const entries = parseStdoutLine(line, "ts");
    expect(entries[0]!.kind).toBe("stderr");
  });
});
