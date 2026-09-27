import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultClaudeInstallPath } from './findBinary.js';

/**
 * Regression test for the 2026-07-08 "claude-code seat stuck CONNECTING"
 * incident: the gateway's scheduled task (Task Scheduler, InteractiveToken,
 * same OS user) saw process.env.APPDATA resolve correctly, but
 * %APPDATA%\Claude\claude-code was unreadable (ENOENT) because that path is
 * a reparse point into the desktop app's MSIX package storage, and only
 * traversable from inside the app's own interactive session. The real
 * LocalCache directory underneath has no such restriction. This asserts the
 * fallback kicks in when the %APPDATA% path doesn't resolve, using fake
 * platform dirs instead of the real (machine-specific) install.
 */
describe('defaultClaudeInstallPath', () => {
  let root: string;
  let appData: string;
  let localAppData: string;
  let origAppData: string | undefined;
  let origLocalAppData: string | undefined;
  let origPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-code-findbinary-'));
    appData = join(root, 'Roaming');
    localAppData = join(root, 'Local');
    mkdirSync(appData, { recursive: true });
    mkdirSync(localAppData, { recursive: true });
    origAppData = process.env.APPDATA;
    origLocalAppData = process.env.LOCALAPPDATA;
    process.env.APPDATA = appData;
    process.env.LOCALAPPDATA = localAppData;
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (origAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = origAppData;
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = origLocalAppData;
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
  });

  it('resolves via %APPDATA%\\Claude\\claude-code when that path is readable', () => {
    const dir = join(appData, 'Claude', 'claude-code', '2.1.202');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.exe'), '');

    expect(defaultClaudeInstallPath()).toBe(join(dir, 'claude.exe'));
  });

  it('falls back to the LOCALAPPDATA package LocalCache path when %APPDATA% does not resolve', () => {
    // No Claude dir under appData at all (mirrors the ENOENT seen from the
    // Task Scheduler context) — only the real package storage exists.
    const dir = join(
      localAppData,
      'Packages',
      'Claude_pzs8sxrjxfjjc',
      'LocalCache',
      'Roaming',
      'Claude',
      'claude-code',
      '2.1.202'
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.exe'), '');

    expect(defaultClaudeInstallPath()).toBe(join(dir, 'claude.exe'));
  });

  it('picks the newest version dir when the fallback has multiple versions', () => {
    const base = join(
      localAppData,
      'Packages',
      'Claude_pzs8sxrjxfjjc',
      'LocalCache',
      'Roaming',
      'Claude',
      'claude-code'
    );
    for (const v of ['1.9.0', '2.1.202', '2.10.0']) {
      const dir = join(base, v);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'claude.exe'), '');
    }

    expect(defaultClaudeInstallPath()).toBe(join(base, '2.10.0', 'claude.exe'));
  });

  it('returns undefined when neither path resolves', () => {
    expect(defaultClaudeInstallPath()).toBeUndefined();
  });
});
