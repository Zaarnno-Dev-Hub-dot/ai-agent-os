import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { isExistingFile } from '@agent-os/shared';

export { isExistingFile };

/** Pick the newest `<root>/<version>/claude.exe` dir, or undefined if none resolve. */
function newestClaudeExeUnder(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  try {
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, 'claude.exe')))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      );
    const newest = versions[versions.length - 1];
    return newest ? join(root, newest, 'claude.exe') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Claude desktop app bundles the CLI at
 * %APPDATA%\Claude\claude-code\<version>\claude.exe and does NOT put it on
 * PATH (verified live 2026-07-04: `where claude` fails while the desktop
 * bundle runs sessions). Pick the newest version dir if present.
 *
 * That %APPDATA%\Claude path is itself a reparse point into the desktop
 * app's MSIX package storage (%LOCALAPPDATA%\Packages\Claude_*\LocalCache\...).
 * Traversing it only works from a process running inside the same
 * interactive desktop session as the app (verified live 2026-07-08: readable
 * from an interactive shell, ENOENT from a Task Scheduler-launched process
 * running as the identical OS user — the gateway's "AgentOS Gateway" task
 * hit exactly this and failed claude-code's binary-not-found check even
 * though APPDATA resolved correctly). The underlying LocalCache directory
 * has no such restriction, so fall back to it directly when the %APPDATA%
 * junction doesn't resolve.
 */
export function defaultClaudeInstallPath(): string | undefined {
  if (process.platform !== 'win32' || !process.env.APPDATA) return undefined;

  const viaAppData = newestClaudeExeUnder(join(process.env.APPDATA, 'Claude', 'claude-code'));
  if (viaAppData) return viaAppData;

  if (!process.env.LOCALAPPDATA) return undefined;
  const packagesRoot = join(process.env.LOCALAPPDATA, 'Packages');
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(packagesRoot).filter((d) => d.startsWith('Claude_'));
  } catch {
    return undefined;
  }
  for (const pkgDir of packageDirs) {
    const viaLocalCache = newestClaudeExeUnder(
      join(packagesRoot, pkgDir, 'LocalCache', 'Roaming', 'Claude', 'claude-code')
    );
    if (viaLocalCache) return viaLocalCache;
  }
  return undefined;
}

/**
 * Verify a command exists on PATH by asking the shell to resolve it
 * (`where` on Windows, `which` elsewhere) rather than guessing directories.
 */
export function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [command], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
