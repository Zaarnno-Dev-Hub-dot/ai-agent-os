import { describe, expect, it } from 'vitest';
import type { AdapterConfig } from '@agent-os/shared';
import { buildArgs, finalMessageOf, parseModelSpec, turnErrorOf, type CodexJsonEvent } from './cliProcess.js';
import { CODEX_EFFORTS, CODEX_MODEL_IDS, codexManifest } from './manifest.js';
import { isAuthFailure } from './index.js';

function cfg(transport: Record<string, unknown>): AdapterConfig {
  return { transport, workspace: process.cwd() } as unknown as AdapterConfig;
}

describe('parseModelSpec', () => {
  it('splits the composite model:effort form the dash picker sends', () => {
    expect(parseModelSpec('gpt-5.6-terra:high')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'high',
    });
  });

  it('leaves a bare model id alone', () => {
    expect(parseModelSpec('gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol' });
  });

  it('does NOT treat an unknown suffix as effort (a future family:tag id stays intact)', () => {
    expect(parseModelSpec('some-model:2026-08')).toEqual({ model: 'some-model:2026-08' });
  });

  it('returns empty for undefined/blank', () => {
    expect(parseModelSpec(undefined)).toEqual({});
    expect(parseModelSpec('   ')).toEqual({});
  });
});

describe('buildArgs', () => {
  it('builds a fresh exec turn with json + skip-git-repo-check', () => {
    const args = buildArgs(cfg({}), { prompt: 'hi' });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('passes model and effort split out of the composite string', () => {
    const args = buildArgs(cfg({ model: 'gpt-5.6-luna:low' }), { prompt: 'hi' });
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-luna');
    expect(args).toContain('model_reasoning_effort="low"');
  });

  it('lets a composite effort win over a separate transport.effort field', () => {
    const args = buildArgs(cfg({ model: 'gpt-5.6-sol:high', effort: 'low' }), { prompt: 'hi' });
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('model_reasoning_effort="low"');
  });

  it('defaults the sandbox to workspace-write and honors an override', () => {
    expect(buildArgs(cfg({}), { prompt: 'hi' })).toContain('sandbox_mode="workspace-write"');
    expect(buildArgs(cfg({}), { prompt: 'hi', sandboxOverride: 'read-only' })).toContain(
      'sandbox_mode="read-only"'
    );
  });

  // REGRESSION (2026-08-08, caught on the second live connect attempt):
  // `codex exec resume` rejects the `-s/--sandbox` FLAG outright
  // ("unexpected argument '-s' found"), so a resumed turn built with it
  // produced zero output and the nonce challenge failed with an empty answer.
  // Sandbox must ride `-c sandbox_mode=`, which BOTH subcommands accept.
  it('never passes the -s flag on either path', () => {
    expect(buildArgs(cfg({}), { prompt: 'hi' })).not.toContain('-s');
    expect(buildArgs(cfg({}), { prompt: 'hi', resumeSessionId: 'abc-123' })).not.toContain('-s');
  });

  it('sets the sandbox the same way on a resumed turn as on a fresh one', () => {
    const fresh = buildArgs(cfg({}), { prompt: 'hi', sandboxOverride: 'read-only' });
    const resumed = buildArgs(cfg({}), {
      prompt: 'hi',
      resumeSessionId: 'abc-123',
      sandboxOverride: 'read-only',
    });
    expect(fresh).toContain('sandbox_mode="read-only"');
    expect(resumed).toContain('sandbox_mode="read-only"');
  });

  it('resumes by thread id with options before the positionals', () => {
    const args = buildArgs(cfg({}), { prompt: 'hi', resumeSessionId: 'abc-123' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args[args.length - 2]).toBe('abc-123');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('drops a model string carrying shell/flag metacharacters (arg-injection defense)', () => {
    const args = buildArgs(cfg({ model: '--dangerously-bypass-approvals-and-sandbox' }), {
      prompt: 'hi',
    });
    expect(args).not.toContain('-m');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('drops an effort string carrying quotes (no TOML escape into -c)', () => {
    const args = buildArgs(cfg({ model: 'gpt-5.6-sol', effort: 'high" evil="1' }), { prompt: 'hi' });
    expect(args.some((a) => a.startsWith('model_reasoning_effort='))).toBe(false);
    expect(args.join(' ')).not.toContain('evil');
  });
});

describe('event readers', () => {
  const events: CodexJsonEvent[] = [
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'command_execution', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'NONCE-123' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  ];

  it('finds the final agent message', () => {
    expect(finalMessageOf(events)).toBe('NONCE-123');
  });

  it('returns undefined when the turn produced no message', () => {
    expect(finalMessageOf([{ type: 'turn.started' }])).toBeUndefined();
  });

  it('surfaces turn.failed as the turn error', () => {
    expect(turnErrorOf([{ type: 'turn.failed', error: { message: 'model not supported' } }])).toBe(
      'model not supported'
    );
  });

  it('reports no error for a clean turn', () => {
    expect(turnErrorOf(events)).toBeUndefined();
  });
});

describe('isAuthFailure', () => {
  // REGRESSION (2026-08-08, caught on the first live connect): Codex writes
  // MCP-server diagnostics to stderr on every run, including a literal
  // "HTTP 401: Unauthorized" from a configured MCP transport. A broad
  // stderr scan reported the (perfectly authenticated) seat as auth-missing
  // and the connect FAILED.
  it('ignores an MCP transport 401 — it says nothing about Codex login state', () => {
    const stderr = [
      'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when',
      'UnexpectedServerResponse("HTTP 401: {\\"title\\": \\"Unauthorized\\", \\"status\\": 401}")',
    ].join('\n');
    expect(isAuthFailure(stderr)).toBe(false);
  });

  it('ignores unrelated skill-parse noise', () => {
    expect(isAuthFailure('ERROR codex_core::session: failed to load skill X: missing YAML')).toBe(false);
  });

  it('still catches a genuinely signed-out CLI', () => {
    expect(isAuthFailure('Error: not logged in. Run `codex login` to authenticate.')).toBe(true);
    expect(isAuthFailure('no credentials found')).toBe(true);
  });

  it('is false for empty/undefined input', () => {
    expect(isAuthFailure(undefined)).toBe(false);
    expect(isAuthFailure('')).toBe(false);
  });
});

describe('manifest', () => {
  it('declares tools, which keeps it OUT of the attested tier by design', () => {
    expect(codexManifest.capabilities).toContain('file-tools');
    expect((codexManifest as { verification?: string }).verification).toBeUndefined();
  });

  it('has a fail-closed model pattern that rejects a foreign model id', () => {
    const re = new RegExp(codexManifest.identity.modelPattern);
    for (const id of CODEX_MODEL_IDS) expect(re.test(id)).toBe(true);
    expect(re.test('claude-opus-5')).toBe(false);
    expect(re.test('qwen2.5:7b')).toBe(false);
  });

  it('every advertised effort round-trips through parseModelSpec', () => {
    for (const effort of CODEX_EFFORTS) {
      expect(parseModelSpec(`gpt-5.6-terra:${effort}`)).toEqual({
        model: 'gpt-5.6-terra',
        effort,
      });
    }
  });
});
