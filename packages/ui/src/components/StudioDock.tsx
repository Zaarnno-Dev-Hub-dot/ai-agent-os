import { useEffect, useState } from 'react';
import { useStore } from '../store/gatewayStore';

const ICONS: Record<string, string> = {
  sparkle: '✦',
  clip: '📎',
  chat: '💬',
  check: '✓',
};

const PING_INTERVAL_MS = 30_000;
// 5s, not 1s: dev-mode apps (Next) can take seconds on GET / — a slow answer
// is "alive", and the timeout only delays the grey verdict for dead ports.
const PING_TIMEOUT_MS = 5_000;

/**
 * Ping an iframe dock app's own loopback URL to auto-grey it when it's not
 * running (: "the sidebar may ping the app's
 * url (HEAD, 1s timeout) to auto-grey dead apps"). `mode: 'no-cors'` is
 * deliberate — most of these local apps won't send us CORS headers, and we
 * don't need to read the response, only whether the port answered at all.
 *
 * Method is GET, NOT the original design's HEAD: Next.js dev servers (e.g.
 * Videxa on:3847) never answer HEAD — the request hangs, the app greys
 * out despite being alive, and every 30s ping parks another wedged socket
 * on the dev server until IT stops answering too (observed 2026-07-11).
 * GET of a page every 30s on loopback is cheap; HEAD is the hazard here.
 */
async function pingAlive(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    // no-store: a cached copy of the page must not count as "alive" — observed
    // a hung app reported alive because Chrome answered the ping from cache.
    await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * STUDIO section in the left sidebar:
 * registry-driven list of dock apps below the seated agents. Clicking an
 * entry mounts it in the main pane via DockView (App.tsx swaps ChatView for
 * DockView when activeDockAppId is set); clicking a room returns to chat
 * (gatewayStore.setActiveRoom clears activeDockAppId).
 */
export function StudioDock() {
  const dockApps = useStore((s) => s.dockApps);
  const activeDockAppId = useStore((s) => s.activeDockAppId);
  const setActiveDockAppId = useStore((s) => s.setActiveDockAppId);

  const [alive, setAlive] = useState<Record<string, boolean>>({});

  const iframeUrls = dockApps.filter((a) => a.kind === 'iframe' && a.url).map((a) => [a.id, a.url as string] as const);

  useEffect(() => {
    if (iframeUrls.length === 0) return;
    let cancelled = false;
    async function pingAll() {
      const results = await Promise.all(
        iframeUrls.map(async ([id, url]) => [id, await pingAlive(url)] as const)
      );
      if (cancelled) return;
      setAlive(Object.fromEntries(results));
    }
    pingAll();
    const t = setInterval(pingAll, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // iframeUrls is derived fresh each render from dockApps (a stable
    // per-boot registry) — re-running only when the SET of urls actually
    // changes, via this join-string dep, avoids re-pinging every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeUrls.map(([id, url]) => `${id}:${url}`).join('|')]);

  if (dockApps.length === 0) return null;

  return (
    <div className="studio-dock">
      <div className="sect">STUDIO</div>
      {dockApps.map((app) => {
        const active = activeDockAppId === app.id;
        const isDisabledByRegistry = app.enabled === false;
        const isDeadIframe = app.kind === 'iframe' && alive[app.id] === false;
        const disabled = isDisabledByRegistry || isDeadIframe;
        const title = isDisabledByRegistry
          ? `${app.label} — disabled`
          : isDeadIframe
            ? `${app.label} — not running`
            : app.label;
        return (
          <button
            key={app.id}
            type="button"
            className={`studio-dock-entry ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
            onClick={() => !disabled && setActiveDockAppId(active ? null : app.id)}
            disabled={disabled}
            title={title}
          >
            <span className="studio-dock-icon">{ICONS[app.icon] ?? '•'}</span>
            <span className="studio-dock-label">{app.label}</span>
          </button>
        );
      })}
    </div>
  );
}
