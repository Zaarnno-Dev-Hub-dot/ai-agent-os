import { useEffect } from 'react';
import { ServerEnvelope, ServerEvent } from '@agent-os/shared';
import { gatewayWsUrl } from '../lib/gatewayOrigin';
import { sweepStaleTyping, useStore } from './gatewayStore';

const SERVER_EVENT_PREFIXES = [
  'state.',
  'agent.',
  'room.',
  'message.',
  'chat.',
  'cost.',
  'budget.',
  'proof.',
  'kanban.',
  // router.routed (docs/DESIGN-router.md #4) — server->client routing-decision
  // broadcast; without this prefix it is silently dropped by the filter above.
  'router.',
  // Vault memory layer v1 (docs/DESIGN-memory-read.md): memory.results / memory.note.
  'memory.',
];

export function useGatewayConnection() {
  const { setWs, setConnected, setConnecting, applyServerEvent } = useStore();

  useEffect(() => {
    // Reconnect forever with backoff: a gateway restart must never strand an
    // open tab on a dead socket (silently dropped sends, 2026-07-05 incident).
    // The gateway pushes a fresh state.sync on every connect, so state
    // self-heals after each reconnect.
    const RETRY_MS = [1000, 2000, 5000, 10000];
    let attempt = 0;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      setConnecting(true);
      ws = new WebSocket(gatewayWsUrl());

      ws.onopen = () => {
        attempt = 0;
        setWs(ws);
        setConnected(true);
      };

      ws.onmessage = (ev) => {
        try {
          const envelope = JSON.parse(ev.data) as ServerEnvelope;
          const t = envelope.type;
          if (SERVER_EVENT_PREFIXES.some((p) => t.startsWith(p)) || t === 'error') {
            applyServerEvent(envelope as ServerEnvelope & ServerEvent);
          }
        } catch (e) {
          console.error('Failed to parse WS message:', e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setWs(null);
        if (disposed) return;
        const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => setConnected(false);
    }

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      setWs(null);
      setConnected(false);
    };
  }, [setWs, setConnected, setConnecting, applyServerEvent]);

  useEffect(() => {
    const id = setInterval(sweepStaleTyping, 4000);
    return () => clearInterval(id);
  }, []);
}
