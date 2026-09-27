import { describe, expect, it } from 'vitest';
import type { AdapterConfig } from '@agent-os/shared';
import { buildArgs, toWslPath, isAuthFailure } from './index.js';
import { CURSOR_MODEL_IDS, CURSOR_MODEL_PATTERN, cursorManifest } from './manifest.js';

function cfg(transport: Record<string, unknown>): AdapterConfig {
  return { transport, workspace: 'C:\\Users\\dev\\ws' } as unknown as AdapterConfig;
}

describe('toWslPath', () => {
  it('maps drive letters to /mnt/<letter>/...', () => {
    expect(toWslPath('C:\\Users\\dev\\data\\workspaces\\cursor')).toBe(
      '/mnt/c/Users/dev/data/workspaces/cursor'
    );
  });
});

describe('buildArgs', () => {
  it('fresh turn: -p stream-json yolo trust, no --resume', () => {
    const args = buildArgs(cfg({ model: 'auto' }), {
      prompt: 'hi',
      workspace: '/mnt/c/ws',
    });
    expect(args[0]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--yolo');
    expect(args).toContain('--trust');
    expect(args).toContain('--workspace');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('auto');
    expect(args).not.toContain('--resume');
    expect(args[args.length - 1]).toBe('hi');
  });

  it('resume uses --resume <id> on the same -p path (not agent resume subcommand)', () => {
    const args = buildArgs(cfg({}), {
      prompt: 'hi',
      resumeSessionId: 'chat_abc-123',
      workspace: '/mnt/c/ws',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('chat_abc-123');
    expect(args[0]).toBe('-p');
  });

  it('drops model strings that look like CLI flags (arg-injection)', () => {
    const args = buildArgs(cfg({ model: '--dangerously-bypass' }), { prompt: 'hi' });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--dangerously-bypass');
  });

  it('drops unsafe session ids', () => {
    const args = buildArgs(cfg({}), {
      prompt: 'hi',
      resumeSessionId: 'evil id; rm -rf /',
    });
    expect(args).not.toContain('--resume');
  });
});

describe('manifest', () => {
  it('uses homebrew harness and full-tier capabilities', () => {
    expect(cursorManifest.harness).toBe('homebrew');
    expect(cursorManifest.flavor).toBe('cli-stream');
    expect(cursorManifest.capabilities).toContain('file-tools');
    expect(cursorManifest.id).toBe('cursor');
  });

  it('modelPattern is fail-closed and matches allowlist ids', () => {
    const re = new RegExp(CURSOR_MODEL_PATTERN, 'i');
    for (const id of CURSOR_MODEL_IDS) {
      expect(re.test(id)).toBe(true);
    }
    expect(re.test('evil;rm')).toBe(false);
    expect(re.test('--flag')).toBe(false);
  });
});

describe('isAuthFailure', () => {
  it('detects permission_denied and authentication required', () => {
    expect(isAuthFailure('Error: Authentication required. Run agent login')).toBe(true);
    expect(isAuthFailure('permission_denied — Origin-scoped')).toBe(true);
    expect(isAuthFailure('ok result')).toBe(false);
  });
});
