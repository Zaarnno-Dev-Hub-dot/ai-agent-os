/**
 * Per-connection WS envelope send + roomError. Pulled out of index.ts into their own module so this narrow,
 * easily-regressed targeting behavior — a validation error for client A's
 * request must reach ONLY client A's socket, not every open tab — is unit
 * testable without importing index.ts (which binds the live gateway's port
 * and touches the real data dir as a side effect of module load).
 *
 * No behavior change from the pre-extraction inline versions: same envelope
 * shape, same OPEN-state guard, same 'error' payload shape.
 */

import type { ServerEnvelope, ServerEvent } from '@agent-os/shared';

/** Minimal shape this module needs from a `ws` WebSocket — just enough to unit-test with a fake. */
export interface EnvelopeTarget {
  readyState: number;
  send(data: string): void;
}

/** Mirrors the `ws` package's WebSocket.OPEN numeric value (1) without importing the real class. */
export const WS_OPEN = 1;

/**
 * Build the wire string for an event exactly once (review 2026-08-04 §4.3).
 *
 * ROOT CAUSE: broadcast() looped over every connected client calling
 * sendEnvelope, and sendEnvelope did its own JSON.stringify each time — so a
 * broadcast cost O(clients x full payload) of serialization rather than
 * O(clients) of socket writes. With state.sync measured at 330 KB and the
 * growth axis being "10+ tiles and a phone", that is the multiplier that turns
 * a large payload into a stalled event loop.
 *
 * Splitting serialization from sending also makes the envelope's `timestamp`
 * one broadcast-time stamp shared by every recipient, instead of a slightly
 * different Date.now() per client — which is what a broadcast timestamp should
 * have meant all along.
 */
export function serializeEnvelope(event: ServerEvent): string {
  const envelope: ServerEnvelope = { v: 1, timestamp: Date.now(), ...event };
  return JSON.stringify(envelope);
}

/**
 * Send an already-serialized envelope (from serializeEnvelope) to one socket.
 * The OPEN guard stays here so every send path keeps exactly one definition of
 * "this socket is writable".
 */
export function sendSerializedEnvelope(ws: EnvelopeTarget, serialized: string): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(serialized);
  }
}

export function sendEnvelope(ws: EnvelopeTarget, event: ServerEvent): void {
  // Guard BEFORE serializing, preserving the pre-split behavior exactly: a
  // closed socket never paid for a JSON.stringify and still must not.
  if (ws.readyState !== WS_OPEN) return;
  ws.send(serializeEnvelope(event));
}

/**
 * Send a room/validation error to the OFFENDING client's socket only — never
 * broadcast. Multi-client correctness: a rejection notice for one tab's
 * request is not information every other connected tab should see.
 */
export function roomError(ws: EnvelopeTarget, code: string, message: string): void {
  sendEnvelope(ws, { type: 'error', payload: { code, message, recoverable: true } });
}
