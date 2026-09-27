import { isExistingFile } from '@agent-os/shared';

export { isExistingFile };

/**
 * Well-known install location for the opencode CLI when it is not on PATH.
 * None is assumed today — `npm install -g opencode-ai` puts `opencode` on
 * PATH on every platform — so this returns undefined and callers fall back
 * to PATH lookup.
 */
export function defaultOpencodeInstallPath(): string | undefined {
  return undefined;
}

/** Verify a command exists on PATH (`where` / `which`). Same shape as Codex. */
export function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    import('child_process')
      .then(({ spawn }) => {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const child = spawn(finder, [command], { stdio: 'ignore', windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      })
      .catch(() => resolve(false));
  });
}
