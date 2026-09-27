import { describe, expect, it } from 'vitest';
import { __resetFleetWakeInFlightForTests, failedOutcomes, wakeSummaryLine } from './fleetWakeRoutes.js';

describe('failedOutcomes', () => {
  it('keeps only seats that did not verify, with a reason', () => {
    expect(
      failedOutcomes([
        { id: 'claude-code', status: 'VERIFIED' },
        { id: 'ollama#local', status: 'FAILED', reason: 'endpoint unreachable' },
        { id: 'codex', status: 'OFFLINE' },
      ])
    ).toEqual([
      { id: 'ollama#local', reason: 'endpoint unreachable' },
      { id: 'codex', reason: 'OFFLINE' },
    ]);
  });
});

describe('wakeSummaryLine', () => {
  it('points at the Add agent panel when nothing is saved', () => {
    expect(wakeSummaryLine([], 0, 0)).toMatch(/Add agent/);
  });

  it('reports verified count and failures', () => {
    const line = wakeSummaryLine([{ id: 'codex', status: 'FAILED', reason: 'not logged in' }], 1, 2);
    expect(line).toContain('1/2 verified');
    expect(line).toContain('codex (not logged in)');
  });
});

describe('in-flight reset helper', () => {
  it('exports reset for tests', () => {
    expect(() => __resetFleetWakeInFlightForTests()).not.toThrow();
  });
});
