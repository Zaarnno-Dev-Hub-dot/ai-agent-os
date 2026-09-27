import { describe, expect, it } from 'vitest';
import { mapStreamEventToAgentEvents } from './index.js';
import type { GrokStreamJsonEvent } from './cliProcess.js';

/**
 * REGRESSION (2026-08-08, found live in the 8/8 Grok burn-down room):
 * the Grok CLI changed this string's casing between versions — 0.2.82 emitted
 * `EndTurn`, the installed 0.2.118 emits `end_turn`. The old exact-match
 * comparison classified every NORMAL, SUCCESSFUL turn as a failure, so both
 * Grok seats sat VERIFIED in a room, burned their turn, and produced nothing.
 * From the outside it looked exactly like the models ignoring the user.
 */
const end = (stopReason?: string): GrokStreamJsonEvent =>
  ({ type: 'end', ...(stopReason === undefined ? {} : { stopReason }) }) as GrokStreamJsonEvent;

const kinds = (evs: ReturnType<typeof mapStreamEventToAgentEvents>) => evs.map((e) => e.type);

describe('end-event stopReason handling', () => {
  it('treats the CURRENT CLI spelling (end_turn) as a clean finish', () => {
    expect(kinds(mapStreamEventToAgentEvents(end('end_turn'), 'm1'))).toEqual(['message-complete']);
  });

  it('still treats the OLD spelling (EndTurn) as a clean finish', () => {
    expect(kinds(mapStreamEventToAgentEvents(end('EndTurn'), 'm1'))).toEqual(['message-complete']);
  });

  it('accepts other separator/casing variants rather than breaking again', () => {
    for (const v of ['end-turn', 'END_TURN', 'endturn', 'End Turn']) {
      expect(kinds(mapStreamEventToAgentEvents(end(v), 'm1'))).toEqual(['message-complete']);
    }
  });

  it('keeps completing silently when the CLI sends no stopReason at all', () => {
    expect(kinds(mapStreamEventToAgentEvents(end(), 'm1'))).toEqual(['message-complete']);
  });

  it('STILL surfaces a genuine cancellation as an error (the case this guard exists for)', () => {
    const evs = mapStreamEventToAgentEvents(end('Cancelled'), 'm1');
    expect(kinds(evs)).toEqual(['error', 'message-complete']);
    expect((evs[0] as { message: string }).message).toContain('Cancelled');
  });

  it('surfaces any other unexpected stop reason as an error', () => {
    expect(kinds(mapStreamEventToAgentEvents(end('MaxTokens'), 'm1'))).toEqual([
      'error',
      'message-complete',
    ]);
  });
});
