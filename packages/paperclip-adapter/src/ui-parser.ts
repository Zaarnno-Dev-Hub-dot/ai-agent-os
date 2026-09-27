/**
 * Self-contained UI transcript parser (design §3). ZERO imports — this file
 * must not import anything (not even types) because it runs in Paperclip's
 * browser sandbox and is dynamically loaded from the API as external-adapter
 * UI parsers are (see docs/adapters/adapter-ui-parser.md in the Paperclip
 * clone: "zero runtime imports, no side effects"). Local structural types are
 * declared inline below instead of imported from vendor-types.ts so this file
 * has no dependency edge at all, matching hermes_gateway's gateway-ui-parser.cjs
 * contract 1:1 (just authored in .ts instead of .cjs, per this package's
 * "everything is one TS project" layout — the build step still emits plain JS
 * with no external module specifiers).
 */

interface TranscriptEntry {
  kind: "assistant" | "stderr" | "system" | "thinking" | "stdout";
  ts: string;
  text: string;
  delta?: boolean;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_PATTERN = new RegExp(ESC + "\\][^" + BEL + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g");
const CSI_PATTERN = new RegExp(ESC + "(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])", "g");

function stripAnsi(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parses one stdout line emitted by execute()'s onLog calls. Mirrors the
 * `[agentos-gateway] ...` line prefixes execute.ts actually writes (see
 * server/execute.ts's ctx.onLog calls) — analogous to hermes_gateway's
 * `[hermes-gateway:event]` line contract, but this adapter's single wake
 * call only ever emits two kinds of line: the pre-request "waking seat=..."
 * line and the post-response "response status=..." line, since there is no
 * SSE/event stream to relay (design §4 note: the gateway's long-poll IS the
 * wait, so there's nothing to stream).
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const cleaned = stripAnsi(line);
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  const responseMatch = trimmed.match(/^\[agentos-gateway\]\s+response\s+status=(\d+)\s+body=(.*)$/s);
  if (responseMatch) {
    const status = Number(responseMatch[1]);
    const data = asRecord(safeJsonParse(responseMatch[2]));
    if (status >= 200 && status < 300) {
      const replyText = asString(asRecord(data?.reply)?.text);
      return replyText
        ? [{ kind: "assistant", ts, text: replyText }]
        : [{ kind: "system", ts, text: "Agent OS gateway replied." }];
    }
    if (status === 408) {
      return [{ kind: "system", ts, text: "Agent OS gateway wake timed out waiting for the seat's reply." }];
    }
    if (status === 404) {
      return [{ kind: "stderr", ts, text: "Agent OS gateway: seat not found or not verified." }];
    }
    if (status === 409) {
      return [{ kind: "stderr", ts, text: "Agent OS gateway: target room has an active loop." }];
    }
    if (status >= 400) {
      const message = asString(data?.error) || `Agent OS gateway HTTP ${status}`;
      return [{ kind: "stderr", ts, text: message }];
    }
    return [{ kind: "system", ts, text: `Agent OS gateway responded with HTTP ${status}.` }];
  }

  if (trimmed.startsWith("[agentos-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[agentos-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: cleaned }];
}
