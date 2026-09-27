import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-os/shared';
import {
  WS_OPEN,
  roomError,
  sendEnvelope,
  sendSerializedEnvelope,
  serializeEnvelope,
  type EnvelopeTarget,
} from './wsEnvelope.js';

/** Fake WS target: records every frame sent to it, no real socket/network involved. */
function fakeTarget(readyState: number = WS_OPEN): EnvelopeTarget & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
}

describe('sendEnvelope', () => {
  it('sends the JSON-serialized envelope to an OPEN socket', () => {
    const ws = fakeTarget();
    const event: ServerEvent = { type: 'error', payload: { code: 'x', message: 'y', recoverable: true } };
    sendEnvelope(ws, event);

    expect(ws.sent).toHaveLength(1);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.type).toBe('error');
    expect(parsed.payload).toEqual({ code: 'x', message: 'y', recoverable: true });
    expect(parsed.v).toBe(1);
    expect(typeof parsed.timestamp).toBe('number');
  });

  it('does not send to a socket that is not OPEN', () => {
    const CLOSED = 3; // ws.WebSocket.CLOSED
    const ws = fakeTarget(CLOSED);
    sendEnvelope(ws, { type: 'error', payload: { code: 'x', message: 'y', recoverable: true } });
    expect(ws.sent).toHaveLength(0);
  });
});

// ============================================================================
// Serialize-once fan-out (review 2026-08-04 §4.3). broadcast() used to call
// sendEnvelope per client, and each call did its own JSON.stringify of the
// full payload — O(clients x payload) serialization instead of O(clients)
// socket writes. These pin the split that lets index.ts's broadcast()
// stringify once and hand the same string to every socket.
// ============================================================================

describe('serializeEnvelope / sendSerializedEnvelope (serialize-once broadcast)', () => {
  const event: ServerEvent = { type: 'error', payload: { code: 'x', message: 'y', recoverable: true } };

  it('produces the SAME wire bytes sendEnvelope would have produced', () => {
    const direct = fakeTarget();
    sendEnvelope(direct, event);

    const viaSplit = fakeTarget();
    sendSerializedEnvelope(viaSplit, serializeEnvelope(event));

    // Timestamps are generated independently; everything else must match
    // exactly, or clients would observe a different frame after this change.
    const a = JSON.parse(direct.sent[0]);
    const b = JSON.parse(viaSplit.sent[0]);
    delete a.timestamp;
    delete b.timestamp;
    expect(b).toEqual(a);
  });

  it('every client in a fan-out receives the identical string — one serialization, N writes', () => {
    const clients = [fakeTarget(), fakeTarget(), fakeTarget()];

    // Exactly what index.ts's broadcast() now does.
    const serialized = serializeEnvelope(event);
    for (const ws of clients) sendSerializedEnvelope(ws, serialized);

    for (const ws of clients) expect(ws.sent).toEqual([serialized]);
    // One broadcast timestamp shared by all recipients, not one per client.
    const stamps = clients.map((ws) => JSON.parse(ws.sent[0]).timestamp);
    expect(new Set(stamps).size).toBe(1);
  });

  it('skips non-OPEN sockets in a fan-out without disturbing the others', () => {
    const CLOSED = 3;
    const open1 = fakeTarget();
    const closed = fakeTarget(CLOSED);
    const open2 = fakeTarget();

    const serialized = serializeEnvelope(event);
    for (const ws of [open1, closed, open2]) sendSerializedEnvelope(ws, serialized);

    expect(open1.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(open2.sent).toHaveLength(1);
  });
});

// ============================================================================
// roomError targeting (docs/TECH-DEBT.md "roomError currently BROADCASTS
// rejection notices to all clients instead of the offender") — the fix under
// test: roomError must reach ONLY the socket passed to it, never any other
// connected client. Message SHAPE must stay identical to the pre-fix
// broadcast version (same 'error' ServerEvent payload).
// ============================================================================

describe('roomError', () => {
  it('sends the error ONLY to the offending client, not to any other socket', () => {
    const offender = fakeTarget();
    const bystanderA = fakeTarget();
    const bystanderB = fakeTarget();

    roomError(offender, 'room.rename', 'Room not found.');

    expect(offender.sent).toHaveLength(1);
    expect(bystanderA.sent).toHaveLength(0);
    expect(bystanderB.sent).toHaveLength(0);
  });

  it('keeps the error payload shape identical to a plain error ServerEvent', () => {
    const ws = fakeTarget();
    roomError(ws, 'agent.set-model', 'Model must be a non-empty string.');

    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed).toMatchObject({
      v: 1,
      type: 'error',
      payload: {
        code: 'agent.set-model',
        message: 'Model must be a non-empty string.',
        recoverable: true,
      },
    });
  });

  it('does nothing observable when the offending socket is not OPEN (no crash, no send)', () => {
    const CONNECTING = 0;
    const ws = fakeTarget(CONNECTING);
    expect(() => roomError(ws, 'room.create', 'Room name must be 1–60 characters after trimming.')).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });
});
