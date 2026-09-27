import { describe, expect, it } from 'vitest';
import type { AdapterConfig } from '@agent-os/shared';
import { buildArgs, finalMessageOf, turnErrorOf, usageOf, type OpencodeJsonEvent } from './cliProcess.js';
import { OPENCODE_MODEL_IDS, opencodeManifest } from './manifest.js';
import { isAuthFailure } from './index.js';

function cfg(transport: Record<string, unknown>): AdapterConfig {
  return { transport, workspace: process.cwd() } as unknown as AdapterConfig;
}

describe('buildArgs', () => {
  it('builds a fresh run with json + auto (headless tool use)', () => {
    const args = buildArgs(cfg({}), { prompt: 'hi' });
    expect(args[0]).toBe('run');
    expect(args).toContain('--format');
    expect(args[args.indexOf('--format') + 1]).toBe('json');
    expect(args).toContain('--auto');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('passes a verified provider/model id with -m', () => {
    const args = buildArgs(cfg({ model: 'opencode/ling-3.0-tiny-free' }), { prompt: 'hi' });
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('opencode/ling-3.0-tiny-free');
  });

  it('resumes with -s <sessionID> on the SAME run subcommand (not a resume subcommand)', () => {
    const args = buildArgs(cfg({}), {
      prompt: 'hi',
      resumeSessionId: 'ses_00898e58dffeiwEMD2dWo4nu1k',
    });
    expect(args[0]).toBe('run');
    expect(args).not.toContain('resume');
    expect(args).toContain('-s');
    expect(args[args.indexOf('-s') + 1]).toBe('ses_00898e58dffeiwEMD2dWo4nu1k');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('uses the same flags on a resumed turn as on a fresh one (Codex -s trap inverted)', () => {
    const fresh = buildArgs(cfg({ model: 'opencode/ling-3.0-tiny-free' }), { prompt: 'hi' });
    const resumed = buildArgs(cfg({ model: 'opencode/ling-3.0-tiny-free' }), {
      prompt: 'hi',
      resumeSessionId: 'ses_abc',
    });
    expect(fresh.filter((a) => a !== '-s' && a !== 'ses_abc')).toEqual(
      resumed.filter((a) => a !== '-s' && a !== 'ses_abc')
    );
    expect(resumed).toContain('-s');
    expect(fresh).not.toContain('-s');
  });

  it('drops a model string carrying shell/flag metacharacters (arg-injection defense)', () => {
    const args = buildArgs(cfg({ model: '--dangerously-bypass-approvals-and-sandbox' }), {
      prompt: 'hi',
    });
    expect(args).not.toContain('-m');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('drops a session id carrying spaces/quotes', () => {
    const args = buildArgs(cfg({}), { prompt: 'hi', resumeSessionId: 'ses evil" --foo' });
    expect(args).not.toContain('-s');
    expect(args.join(' ')).not.toContain('evil');
  });
});

describe('event readers', () => {
  const events: OpencodeJsonEvent[] = [
    { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
    {
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', output: 'NONCE-123' },
      },
    },
    { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'NONCE-123' } },
    {
      type: 'step_finish',
      sessionID: 'ses_1',
      part: { type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 2 } },
    },
  ];

  it('finds the final assistant text', () => {
    expect(finalMessageOf(events)).toBe('NONCE-123');
  });

  it('returns undefined when the turn produced no message', () => {
    expect(finalMessageOf([{ type: 'step_start' }])).toBeUndefined();
  });

  it('reads usage from the last step_finish', () => {
    expect(usageOf(events)).toEqual({ input: 10, output: 2 });
  });

  it('surfaces a typed error event as the turn error', () => {
    expect(
      turnErrorOf([
        {
          type: 'error',
          error: { name: 'UnknownError', data: { message: 'Unexpected server error' } },
        },
      ])
    ).toBe('Unexpected server error');
  });

  it('reports no error for a clean turn', () => {
    expect(turnErrorOf(events)).toBeUndefined();
  });
});

describe('isAuthFailure', () => {
  it('ignores an MCP transport 401 — it says nothing about opencode login state', () => {
    const stderr = [
      'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when',
      'UnexpectedServerResponse("HTTP 401: {\\"title\\": \\"Unauthorized\\", \\"status\\": 401}")',
    ].join('\n');
    expect(isAuthFailure(stderr)).toBe(false);
  });

  it('still catches a genuinely signed-out CLI', () => {
    expect(isAuthFailure('Error: not logged in. Run `opencode providers login`.')).toBe(true);
    expect(isAuthFailure('no credentials found')).toBe(true);
  });

  it('is false for empty/undefined input', () => {
    expect(isAuthFailure(undefined)).toBe(false);
    expect(isAuthFailure('')).toBe(false);
  });
});

describe('manifest', () => {
  it('declares tools, which keeps it OUT of the attested tier by design', () => {
    expect(opencodeManifest.capabilities).toContain('file-tools');
    expect((opencodeManifest as { verification?: string }).verification).toBeUndefined();
  });

  it('has a fail-closed model pattern that rejects a foreign model id', () => {
    const re = new RegExp(opencodeManifest.identity.modelPattern);
    for (const id of OPENCODE_MODEL_IDS) expect(re.test(id)).toBe(true);
    expect(re.test('opencode/longcat-2.0-free')).toBe(true);
    expect(re.test('anthropic/claude-sonnet-5')).toBe(true);
    expect(re.test('claude-opus-5')).toBe(false);
    expect(re.test('gpt-5.6-luna')).toBe(false);
    expect(re.test('opencode/ling-3.0-tiny-free; rm -rf /')).toBe(false);
  });

  it('does not invent an effort composite — only bare verified ids', () => {
    const re = new RegExp(opencodeManifest.identity.modelPattern);
    expect(re.test('opencode/ling-3.0-tiny-free:high')).toBe(false);
  });
});
