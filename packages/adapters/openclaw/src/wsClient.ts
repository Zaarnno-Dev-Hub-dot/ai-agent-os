/**
 * Thin WebSocket client for the OpenClaw Gateway protocol. Owns the socket,
 * request/response correlation (by `id`), and dispatch of `event` frames to
 * a subscriber. No filesystem access here — nonce-file reads happen inside
 * the OpenClaw agent's own tools, dispatched as a chat.send turn (see index.ts).
 */
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { AdapterError } from '@agent-os/shared';
import {
  ConnectChallengePayload,
  ConnectParams,
  EventFrame,
  HelloOkPayload,
  InboundFrame,
  OPENCLAW_CLIENT_ID,
  OPENCLAW_CLIENT_MODE,
  OpenClawTransportConfig,
  ReqFrame,
  ResFrame,
  isConnectChallengeEvent,
  isEventFrame,
  isResFrame,
  resolveEndpoint,
} from './protocol.js';

const CLIENT_VERSION = '0.0.0';
const MIN_PROTOCOL = 3;
const MAX_PROTOCOL = 4;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Pre-connect challenge timeout: the gateway's own default budget for this
 * wait is 15s (`src/gateway/handshake-timeouts.ts` in the openclaw package).
 * We use a shorter default since this is purely local-loopback wait time
 * before we even send `connect`; DEFAULT_HANDSHAKE_TIMEOUT_MS still governs
 * the overall connect round-trip once `connect` is sent.
 */
const CHALLENGE_WAIT_TIMEOUT_MS = 10_000;

export type EventListener = (frame: EventFrame) => void;

export class OpenClawWsClient {
  private ws: WebSocket | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (r: ResFrame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<EventListener>();
  private closed = false;
  private hello: HelloOkPayload | undefined;
  private lastFrameAt = Date.now();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private challenge: ConnectChallengePayload | undefined;
  private challengeWaiters: Array<(c: ConnectChallengePayload) => void> = [];

  private constructor(private readonly endpoint: string) {}

  get connectionId(): string | undefined {
    return this.hello?.server.connId;
  }

  get negotiatedProtocol(): number | undefined {
    return this.hello?.protocol;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  static async connect(transport: OpenClawTransportConfig): Promise<OpenClawWsClient> {
    const endpoint = resolveEndpoint(transport);
    const token = typeof transport.token === 'string' ? transport.token.trim() : '';
    if (!token) {
      throw new AdapterError(
        'auth-missing',
        'OpenClaw operator token required',
        'Paste the operator token from your OpenClaw gateway config into transport.token in the Add Agent wizard.'
      );
    }

    const client = new OpenClawWsClient(endpoint);
    await client.openSocket();
    await client.handshake(transport, token);
    return client;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.endpoint);
      } catch (e) {
        reject(
          new AdapterError(
            'endpoint-down',
            `Could not open WebSocket to ${this.endpoint}: ${e instanceof Error ? e.message : String(e)}`,
            'Confirm the OpenClaw gateway is running and reachable at the configured endpoint (default ws://127.0.0.1:18789).'
          )
        );
        return;
      }

      const onOpenError = (err: Error) => {
        reject(
          new AdapterError(
            'endpoint-down',
            `OpenClaw gateway not reachable at ${this.endpoint}: ${err.message}`,
            'Start the OpenClaw gateway (it listens on port 18789 by default) or check transport.endpoint, then retry connect.'
          )
        );
      };

      ws.once('error', onOpenError);
      ws.once('open', () => {
        ws.removeListener('error', onOpenError);
        this.ws = ws;
        this.wireSocket(ws);
        resolve();
      });
    });
  }

  private wireSocket(ws: WebSocket): void {
    ws.on('message', (data) => {
      this.lastFrameAt = Date.now();
      let frame: InboundFrame;
      try {
        frame = JSON.parse(data.toString()) as InboundFrame;
      } catch {
        return; // malformed frame — ignore, do not crash the session
      }

      if (isResFrame(frame)) {
        const waiter = this.pending.get(frame.id);
        if (waiter) {
          this.pending.delete(frame.id);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
        return;
      }

      if (isEventFrame(frame)) {
        // Gateway pushes this unsolicited, pre-handshake, immediately on
        // socket open — must be captured before/independent of `connect`
        // being sent. See protocol.ts ConnectChallengePayload doc.
        if (isConnectChallengeEvent(frame) && frame.payload) {
          this.challenge = frame.payload;
          const waiters = this.challengeWaiters.splice(0);
          for (const w of waiters) w(frame.payload);
          return;
        }
        if (frame.event === 'tick' || frame.event === 'health') {
          // Keepalive/health frames also count as liveness for our own timeout below.
          return;
        }
        for (const l of this.listeners) l(frame);
      }
    });

    ws.on('close', () => {
      this.closed = true;
      if (this.tickTimer) clearInterval(this.tickTimer);
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('OpenClaw WebSocket closed'));
      }
      this.pending.clear();
      this.challengeWaiters.splice(0);
    });

    ws.on('error', () => {
      // Surfaced via close/pending rejection paths; avoid unhandled 'error' throws.
    });
  }

  /**
   * Wait for the gateway's unsolicited pre-connect `connect.challenge` event.
   * The gateway sends this immediately on socket open (before any request),
   * so by the time openSocket()'s 'open' listener fires the challenge may
   * already have arrived (captured synchronously in wireSocket's message
   * handler) or may still be in flight — this covers both orderings.
   */
  private waitForChallenge(timeoutMs: number): Promise<ConnectChallengePayload> {
    if (this.challenge) return Promise.resolve(this.challenge);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.challengeWaiters.indexOf(onChallenge);
        if (idx >= 0) this.challengeWaiters.splice(idx, 1);
        reject(new Error('Timed out waiting for OpenClaw connect.challenge'));
      }, timeoutMs);
      const onChallenge = (c: ConnectChallengePayload) => {
        clearTimeout(timer);
        resolve(c);
      };
      this.challengeWaiters.push(onChallenge);
    });
  }

  private async handshake(transport: OpenClawTransportConfig, token: string): Promise<void> {
    const ws = this.ws;
    if (!ws) throw new AdapterError('handshake-failed', 'Socket not open before handshake');

    const timeoutMs = transport.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    // The gateway requires clients to wait for its pre-connect challenge
    // before sending `connect` — live-confirmed against 127.0.0.1:18789
    // (2026-07-06). This adapter does not sign/echo the nonce (device
    // signing is not required for a `probe` connect — see protocol.ts), it
    // only waits for the event so handshake sequencing matches the gateway's
    // expectation.
    try {
      await this.waitForChallenge(Math.min(CHALLENGE_WAIT_TIMEOUT_MS, timeoutMs));
    } catch (e) {
      throw new AdapterError(
        'handshake-failed',
        `OpenClaw gateway did not send connect.challenge: ${e instanceof Error ? e.message : String(e)}`,
        'Confirm the OpenClaw gateway version supports the documented connect.challenge handshake, then retry.'
      );
    }

    const clientId = transport.clientId?.trim() || OPENCLAW_CLIENT_ID;
    const clientMode = transport.clientMode?.trim() || OPENCLAW_CLIENT_MODE;
    const params: ConnectParams = {
      minProtocol: MIN_PROTOCOL,
      maxProtocol: MAX_PROTOCOL,
      client: { id: clientId, version: CLIENT_VERSION, platform: process.platform, mode: clientMode },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token },
    };

    let res: ResFrame<HelloOkPayload>;
    try {
      res = await this.request<ConnectParams, HelloOkPayload>('connect', params, timeoutMs);
    } catch (e) {
      throw new AdapterError(
        'handshake-failed',
        `OpenClaw handshake did not complete: ${e instanceof Error ? e.message : String(e)}`,
        'Confirm the operator token is current and the gateway is on a compatible protocol version, then retry.'
      );
    }

    if (!res.ok) {
      // Live-confirmed (2026-07-06, ws://127.0.0.1:18789): the gateway
      // reports the specific auth/pairing reason under
      // `error.details.code` (e.g. AUTH_TOKEN_MISMATCH), while the
      // top-level `error.code` is the generic `INVALID_REQUEST`. Check
      // details.code first so these map to 'auth-missing' instead of
      // falling through to the generic 'handshake-failed' branch below.
      const detailsCode =
        res.error?.details && typeof res.error.details.code === 'string' ? res.error.details.code : undefined;
      const code = detailsCode ?? res.error?.code ?? 'handshake-failed';
      if (code === 'AUTH_TOKEN_MISMATCH' || code === 'AUTH_SCOPE_MISMATCH') {
        throw new AdapterError(
          'auth-missing',
          `OpenClaw rejected the operator token: ${res.error?.message ?? code}`,
          'Re-mint an operator token in your OpenClaw gateway config and paste it into the Add Agent wizard.'
        );
      }
      if (code === 'PAIRING_REQUIRED') {
        throw new AdapterError(
          'auth-missing',
          'OpenClaw requires device pairing before this client can connect',
          'Approve this device from the OpenClaw gateway UI/CLI, then retry connect.'
        );
      }
      throw new AdapterError(
        'handshake-failed',
        `OpenClaw handshake failed: ${res.error?.message ?? code}`,
        res.error?.details ? JSON.stringify(res.error.details) : undefined
      );
    }

    this.hello = res.payload;
    const tickIntervalMs = res.payload?.policy.tickIntervalMs ?? 15_000;
    this.lastFrameAt = Date.now();
    this.tickTimer = setInterval(() => {
      // Protocol: close 4000 if no frames within tickIntervalMs * 2 (docs.openclaw.ai).
      if (Date.now() - this.lastFrameAt > tickIntervalMs * 2) {
        this.ws?.close(4000, 'tick timeout');
      }
    }, tickIntervalMs);
  }

  request<P, R>(method: string, params?: P, timeoutMs = 30_000): Promise<ResFrame<R>> {
    const ws = this.ws;
    if (!ws || this.closed) {
      return Promise.reject(new Error('OpenClaw WebSocket is not connected'));
    }
    const id = randomUUID();
    const frame: ReqFrame<P> = { type: 'req', id, method, params };

    return new Promise<ResFrame<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => resolve(r as ResFrame<R>),
        reject,
        timer,
      });
      ws.send(JSON.stringify(frame), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Clean close: give in-flight frames ~1s to flush, then terminate (reference client behavior per docs). */
  async close(): Promise<void> {
    if (this.closed || !this.ws) {
      this.closed = true;
      return;
    }
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    const ws = this.ws;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const t = setTimeout(() => {
        ws.terminate();
        done();
      }, 1000);
      ws.once('close', () => {
        clearTimeout(t);
        done();
      });
      try {
        ws.close(1000, 'client disconnect');
      } catch {
        clearTimeout(t);
        ws.terminate();
        done();
      }
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }
}
