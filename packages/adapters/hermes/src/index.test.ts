import { describe, expect, it } from 'vitest';
import { mapSseToAgentEvents } from './index.js';
import type { HermesRunSseEvent } from './hermesRuns.js';

/**
 * Regression test for the 2026-07-06 usage-order bug: the relay's AgentRelayWorker.handleEvent
 * stashes a 'usage' AgentEvent into pendingUsage and only reads it when
 * 'message-complete' fires commitAgentReply — and runOne's finally clears
 * this.current right after settling, so a 'usage' event emitted AFTER
 * 'message-complete' is silently dropped. hermes previously returned
 * [message-complete, usage] on run.completed; this asserts usage now comes
 * first, matching claude-code and grok-build.
 */
describe('mapSseToAgentEvents', () => {
  it('orders usage before message-complete on run.completed with usage', () => {
    const ev: HermesRunSseEvent = {
      event: 'run.completed',
      usage: { input_tokens: 123, output_tokens: 45 },
    };
    const out = mapSseToAgentEvents(ev, 'msg-1');

    expect(out.map((e) => e.type)).toEqual(['usage', 'message-complete']);
    const usageEvent = out.find((e) => e.type === 'usage');
    expect(usageEvent).toMatchObject({ type: 'usage', tokensIn: 123, tokensOut: 45 });
  });

  it('emits only message-complete when run.completed carries no usage', () => {
    const ev: HermesRunSseEvent = { event: 'run.completed' };
    const out = mapSseToAgentEvents(ev, 'msg-2');

    expect(out.map((e) => e.type)).toEqual(['message-complete']);
  });
});
