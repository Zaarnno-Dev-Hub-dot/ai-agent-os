import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isExistingFile } from '@agent-os/shared';

export { isExistingFile };

/**
 * The Codex desktop app bundles its CLI at
 * %LOCALAPPDATA%\OpenAI\Codex\bin\<build-hash>\codex.exe and does NOT put it
 * on PATH (verified live 2026-08-08: `where codex` fails while the desktop
 * app runs sessions, and the bundled binary answers `codex --version` →
 * `codex-cli 0.147.0-alpha.6.5`).
 *
 * Unlike the Claude Code bundle, that directory segment is an opaque BUILD
 * HASH (`cfac6bda2d141e07`), not a version string — sorting it lexically or
 * numerically is meaningless and would pick an arbitrary stale build after an
 * update. Pick the most recently MODIFIED candidate directory instead, which
 * is the one the last `codex update` wrote. Hardcoding today's hash into a
 * transport config would silently break the seat on the next Codex update —
 * that is exactly the failure this resolver exists to prevent, so prefer it
 * over a pinned `cliCommand` path unless a specific build is being tested.
 */
function newestCodexExeUnder(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  try {
    const candidates = readdirSync(root)
      .map((dir) => join(root, dir, 'codex.exe'))
      .filter((exe) => existsSync(exe))
      .map((exe) => ({ exe, mtimeMs: statSync(exe).mtimeMs }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    return candidates[candidates.length - 1]?.exe;
  } catch {
    return undefined;
  }
}

/** Resolve the desktop-app-bundled Codex CLI, or undefined when absent. */
export function defaultCodexInstallPath(): string | undefined {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return undefined;
  return newestCodexExeUnder(join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'));
}

/**
 * Verify a command exists on PATH by asking the shell to resolve it
 * (`where` on Windows, `which` elsewhere) rather than guessing directories.
 * Same helper shape as the claude-code adapter's.
 */
export function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Imported lazily so this module stays cheap to load in tests that only
    // exercise the path resolver above.
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
