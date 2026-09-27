import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { isExistingFile } from '@agent-os/shared';

export { isExistingFile };

/**
 * Newest `%LOCALAPPDATA%\\cursor-agent\\versions\\<ver>\\cursor-agent.exe`
 * (layout claimed by Cursor's own probe notes). Version dirs change on
 * update — never hardcode a version segment.
 */
function newestWindowsCursorAgent(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  if (!local || process.platform !== 'win32') return undefined;
  const root = join(local, 'cursor-agent', 'versions');
  if (!existsSync(root)) return undefined;
  try {
    const versions = readdirSync(root)
      .filter((v) => {
        const exe = join(root, v, 'cursor-agent.exe');
        const bare = join(root, v, 'agent.exe');
        return existsSync(exe) || existsSync(bare);
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const newest = versions[versions.length - 1];
    if (!newest) return undefined;
    const exe = join(root, newest, 'cursor-agent.exe');
    if (existsSync(exe)) return exe;
    const bare = join(root, newest, 'agent.exe');
    return existsSync(bare) ? bare : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prefer a real Windows binary when present; otherwise leave resolution to
 * the WSL launcher in cliProcess (official installer is linux/darwin only as
 * of 2026-08-26 — this laptop runs agent under Ubuntu WSL).
 */
export function defaultCursorInstallPath(): string | undefined {
  return newestWindowsCursorAgent();
}

export function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [command], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** True when `wsl` can resolve and `agent --version` exits 0 inside the default distro. */
export function wslAgentAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(false);
      return;
    }
    const child = spawn(
      'wsl.exe',
      ['-e', 'bash', '-lc', 'export PATH="$HOME/.local/bin:$PATH"; command -v agent >/dev/null && agent --version >/dev/null'],
      { stdio: 'ignore', windowsHide: true }
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
