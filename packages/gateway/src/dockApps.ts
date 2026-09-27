/**
 * Studio Dock registry (docs/DESIGN-studio-dock.md §2) — `data/dock-apps.json`
 * is the interface (no editor UI in v1; a settings panel is a later app).
 * Read-only over the wire: loaded once at boot, served as an additive
 * `state.sync` field (`dockApps`, cast at endpoints — index.ts/gatewayStore.ts
 * — same idiom as the polls/projects fields, packages/shared stays frozen).
 *
 * Hard rule from the design doc (drive-by lesson from 7/4): every `iframe`
 * entry's `url` MUST resolve to host 127.0.0.1/localhost/::1. Anything else
 * is dropped at load, loudly, rather than ever reaching a client.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type DockAppKind = 'route' | 'iframe';

export interface DockAppEntry {
  id: string;
  label: string;
  icon: string;
  kind: DockAppKind;
  /** Required (and loopback-validated) for kind 'iframe'; absent for 'route'. */
  url?: string;
  /** Registry-level manual disable (design doc: "Disabled entries render greyed with a tooltip"). Defaults to true when absent. */
  enabled?: boolean;
}

const REGISTRY_FILENAME = 'dock-apps.json';

/** host is 127.0.0.1, localhost, or ::1 — the loopback allowlist (design doc §2/§3). */
export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function isDockAppEntry(v: unknown): v is DockAppEntry {
  if (typeof v !== 'object' || v == null) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.trim().length === 0) return false;
  if (typeof e.label !== 'string' || e.label.trim().length === 0) return false;
  if (typeof e.icon !== 'string') return false;
  if (e.kind !== 'route' && e.kind !== 'iframe') return false;
  if (e.enabled != null && typeof e.enabled !== 'boolean') return false;
  if (e.kind === 'iframe') {
    if (typeof e.url !== 'string' || !isLoopbackUrl(e.url)) return false;
  } else if (e.url != null && typeof e.url !== 'string') {
    return false;
  }
  return true;
}

/**
 * Load + validate `data/dock-apps.json`. Never throws: a missing file yields
 * an empty registry, a malformed file yields an empty registry (logged), and
 * a malformed OR non-loopback individual entry is dropped (logged) while its
 * siblings still load — same fail-soft-per-item posture as polls.ts/
 * projects.ts's isPollOption/isProjectRecord guards.
 */
export function loadDockApps(dataDir: string): DockAppEntry[] {
  const path = join(dataDir, REGISTRY_FILENAME);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.error(`[dockApps] failed to parse ${path} — serving empty registry`, e);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(`[dockApps] ${path} is not a JSON array — serving empty registry`);
    return [];
  }
  const out: DockAppEntry[] = [];
  for (const entry of parsed) {
    if (!isDockAppEntry(entry)) {
      console.error('[dockApps] dropping invalid or non-loopback entry', entry);
      continue;
    }
    out.push(entry);
  }
  return out;
}
