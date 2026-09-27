import type { AdapterConfig } from '@agent-os/shared';

export interface HermesTransportConfig {
  endpoint?: string;
  /** Bearer token — optional when keyFile is set (local Hermes .env). */
  apiKey?: string;
  /** Path to Hermes .env; gateway reads API_SERVER_KEY at connect time. */
  keyFile?: string;
  sessionId?: string;
  sessionKey?: string;
}

export type HermesRunSseEvent = {
  event: string;
  run_id?: string;
  timestamp?: number;
  delta?: string;
  tool?: string;
  preview?: string;
  duration?: number;
  error?: boolean | string;
  output?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  text?: string;
};

export function baseUrl(config: AdapterConfig): string {
  const t = config.transport as HermesTransportConfig;
  return (t.endpoint ?? 'http://127.0.0.1:8642').replace(/\/$/, '');
}

export function authHeaders(config: AdapterConfig): Record<string, string> {
  const t = config.transport as HermesTransportConfig;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (t.apiKey) headers.Authorization = `Bearer ${t.apiKey}`;
  if (t.sessionId) headers['X-Hermes-Session-Id'] = t.sessionId;
  if (t.sessionKey) headers['X-Hermes-Session-Key'] = t.sessionKey;
  return headers;
}

export async function startRun(
  config: AdapterConfig,
  body: { input: string; instructions?: string; session_id?: string }
): Promise<string> {
  const res = await fetch(`${baseUrl(config)}/v1/runs`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hermes run failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { run_id?: string };
  if (!json.run_id) throw new Error('Hermes run response missing run_id');
  return json.run_id;
}

export async function stopRun(config: AdapterConfig, runId: string): Promise<void> {
  await fetch(`${baseUrl(config)}/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    headers: authHeaders(config),
  }).catch(() => undefined);
}

/** Parse Hermes GET /v1/runs/{id}/events SSE (data: JSON lines). */
export async function* streamRunEvents(
  config: AdapterConfig,
  runId: string,
  signal?: AbortSignal
): AsyncGenerator<HermesRunSseEvent> {
  const res = await fetch(`${baseUrl(config)}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: { ...authHeaders(config), Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Hermes run events failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of block.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as HermesRunSseEvent;
          } catch {
            /* ignore malformed SSE chunk */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface RunTerminalResult {
  output: string;
  usage?: { tokensIn: number; tokensOut: number };
  failed: boolean;
  error?: string;
}

/** Consume SSE until run.completed, run.failed, run.cancelled, or timeout. */
export async function waitForRunTerminal(
  config: AdapterConfig,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RunTerminalResult> {
  const deadline = Date.now() + timeoutMs;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);

  const timeout = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));

  try {
    for await (const ev of streamRunEvents(config, runId, ac.signal)) {
      if (Date.now() > deadline) {
        return { output: '', failed: true, error: 'timeout waiting for Hermes run' };
      }
      const name = ev.event;
      if (name === 'run.completed') {
        const usage = ev.usage;
        return {
          output: (ev.output ?? '').trim(),
          usage: usage
            ? {
                tokensIn: usage.input_tokens ?? 0,
                tokensOut: usage.output_tokens ?? 0,
              }
            : undefined,
          failed: false,
        };
      }
      if (name === 'run.failed') {
        const err = typeof ev.error === 'string' ? ev.error : 'Hermes run failed';
        return { output: '', failed: true, error: err };
      }
      if (name === 'run.cancelled') {
        return { output: '', failed: true, error: 'Hermes run cancelled' };
      }
    }
    return { output: '', failed: true, error: 'Hermes event stream ended without terminal event' };
  } catch (e) {
    if (ac.signal.aborted && Date.now() >= deadline - 50) {
      return { output: '', failed: true, error: 'timeout waiting for Hermes run' };
    }
    return {
      output: '',
      failed: true,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}