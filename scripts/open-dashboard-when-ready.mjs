/**
 * Waits for gateway /health then opens the dashboard in the default browser (Windows).
 * Usage: node scripts/open-dashboard-when-ready.mjs
 */
const HEALTH = 'http://127.0.0.1:4110/health';
const DASH = 'http://127.0.0.1:4110';
const DEADLINE_MS = 45_000;

async function main() {
  const start = Date.now();
  while (Date.now() - start < DEADLINE_MS) {
    try {
      const res = await fetch(HEALTH);
      if (res.ok) {
        const { execFile } = await import('node:child_process');
        execFile('cmd', ['/c', 'start', '', DASH], { windowsHide: true }, () => {});
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.error('[open-dashboard] Timed out waiting for', HEALTH);
  process.exit(1);
}

main();