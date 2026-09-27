/**
 * Resolve the Agent OS gateway HTTP origin and WS URL for the current page.
 *
 * - Gateway-served UI (port 4110) and reverse tunnels (HTTPS / trycloudflare):
 *   same-origin so mobile tunnels work without hardcoding :4110.
 * - Vite dev (5173/5174): UI and gateway are split → always hit :4110 on the
 *   same hostname (local loopback dev only).
 */
export function gatewayHttpOrigin(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:4110';
  const { hostname, port, origin } = window.location;
  if (port === '5173' || port === '5174') {
    return `http://${hostname}:4110`;
  }
  return origin;
}

export function gatewayWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:4110/ws';
  const { hostname, port, protocol, host } = window.location;
  if (port === '5173' || port === '5174') {
    return `ws://${hostname}:4110/ws`;
  }
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}/ws`;
}
