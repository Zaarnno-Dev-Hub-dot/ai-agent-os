import type { AdapterConfig } from '@agent-os/shared';

/**
 * http-openai transport flavor (PRD §adapter-contract, DESIGN doc
 * "Adapter shape"): OpenAI-compatible POST /chat/completions against
 * `transport.endpoint`, per-seat `transport.model`. One adapter backs two
 * seats via multi-instance (ollama#qwen, ollama#tiny) — the endpoint is
 * shared, the model differs per seat's AdapterConfig.
 */
export interface OllamaTransportConfig {
  /** Base URL up to and including /v1, e.g. http://<mini-tailscale-ip>:11434/v1 (no trailing slash required). */
  endpoint?: string;
  /** Model tag for this seat, e.g. 'qwen2.5:7b' or 'llama3.2:3b'. */
  model?: string;
  /** Per-seat timeout override (ms). Falls back to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Optional bearer token for hosted OpenAI-compatible APIs (OpenAI, OpenRouter, Groq...). Local servers need none. */
  apiKey?: string;
}

/**
 * Generous default (design doc "Timeouts generous (Mini under load)"): a
 * loaded Mini running a 7B model over a tunnel can take tens of seconds for
 * a single completion. 90s covers that with room, without hanging forever on
 * a genuinely dead endpoint.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;

export function transportOf(config: AdapterConfig): OllamaTransportConfig {
  return (config.transport ?? {}) as OllamaTransportConfig;
}

export function endpointOf(config: AdapterConfig): string {
  const raw = transportOf(config).endpoint?.trim();
  if (!raw) {
    throw new Error('transport.endpoint is required (e.g. http://127.0.0.1:11434/v1)');
  }
  return raw.replace(/\/+$/, '');
}

export function modelOf(config: AdapterConfig): string {
  const model = transportOf(config).model?.trim();
  if (!model) {
    throw new Error('transport.model is required (e.g. qwen3:8b or gpt-4o-mini)');
  }
  return model;
}

export function timeoutMsOf(config: AdapterConfig): number {
  return transportOf(config).timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  text: string;
  /** Model id self-reported by the endpoint's own response body — the identity-echo signal (never trust the requested tag). */
  reportedModel?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * One non-streaming POST /chat/completions round trip. v1 ships
 * non-streaming only — Ollama supports SSE, but the relay's AgentEvent
 * stream doesn't need it for a first gate (design doc: "Streaming optional
 * in v1 ... non-streaming acceptable for first gate — note which shipped."
 * This is that note: NON-STREAMING SHIPPED. A follow-up can add `stream:
 * true` + incremental `token` events without touching this function's
 * contract for prove()/health(), only send()).
 */
export async function chatCompletion(
  config: AdapterConfig,
  messages: ChatMessage[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ChatCompletionResult> {
  const endpoint = endpointOf(config);
  const model = modelOf(config);
  const timeoutMs = opts.timeoutMs ?? timeoutMsOf(config);
  // Combine the hard timeout with an optional caller-supplied abort (wired
  // from OllamaSession.interrupt() — a relay-issued stop must actually cancel
  // the in-flight request, not just stop waiting on it).
  const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal]) : AbortSignal.timeout(timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(transportOf(config).apiKey?.trim() ? { authorization: `Bearer ${transportOf(config).apiKey!.trim()}` } : {}),
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    });
  } catch (e) {
    throw new Error(
      `Endpoint unreachable at ${endpoint} (Ollama/OpenAI-compatible): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Endpoint returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  let json: {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(
      `Endpoint returned a non-JSON body: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const text = json.choices?.[0]?.message?.content ?? '';
  return {
    text,
    reportedModel: json.model,
    usage: json.usage
      ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
      : undefined,
  };
}
