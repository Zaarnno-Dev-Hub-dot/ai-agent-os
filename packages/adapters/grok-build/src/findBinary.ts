import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { isExistingFile } from '@agent-os/shared';

export { isExistingFile };

/**
 * The Grok Build installer does NOT put `grok` on PATH — it lands at
 * ~/.grok/bin/grok(.exe) (verified live on this machine, grok 0.2.82,
 * 2026-07-04). Used as the fallback when no transport override is set and
 * `grok` isn't on PATH.
 */
export function defaultGrokInstallPath(): string {
  const bin = process.platform === 'win32' ? 'grok.exe' : 'grok';
  return join(homedir(), '.grok', 'bin', bin);
}

/**
 * Verify a command exists on PATH by asking the shell to resolve it
 * (`where` on Windows, `which` elsewhere) rather than guessing directories.
 * Mirrors packages/adapters/claude-code/src/findBinary.ts exactly — same
 * detection strategy, different CLI name.
 */
export function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [command], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
