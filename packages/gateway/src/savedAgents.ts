import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AdapterConfig } from '@agent-os/shared';

/**
 * Agents the human added from the dashboard's "Add agent" panel with
 * "Remember" ticked. Stored in <dataDir>/saved-agents.json, reconnected when
 * the gateway starts and whenever the Wake fleet button is pressed.
 *
 * The transport config is stored verbatim — including any API key typed into
 * the panel — so this file lives under data/ (git-ignored) and is NEVER sent to
 * the UI: state.sync only carries the saved seat ids.
 */
export interface SavedAgent {
  seatId: string;
  manifestId: string;
  instanceId?: string;
  instanceLabel?: string;
  config: AdapterConfig;
  savedAt: number;
}

const FILE_NAME = 'saved-agents.json';

function isSavedAgent(v: unknown): v is SavedAgent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seatId === 'string' &&
    typeof o.manifestId === 'string' &&
    !!o.config &&
    typeof o.config === 'object' &&
    typeof (o.config as Record<string, unknown>).transport === 'object'
  );
}

/** Never throws: a missing or corrupt file means "nothing saved yet". */
export function loadSavedAgents(dataDir: string): SavedAgent[] {
  const path = join(dataDir, FILE_NAME);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown })?.agents;
    return Array.isArray(list) ? list.filter(isSavedAgent) : [];
  } catch (e) {
    console.error(`[saved-agents] could not read ${path} — starting with none`, e);
    return [];
  }
}

/** Atomic write (temp file + rename) so a crash mid-write never truncates the list. */
export function saveSavedAgents(dataDir: string, list: SavedAgent[]): void {
  const path = join(dataDir, FILE_NAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ agents: list }, null, 2), 'utf-8');
  renameSync(tmp, path);
}

/** Insert or replace by seatId, keeping the original order for existing entries. */
export function upsertSavedAgent(list: SavedAgent[], entry: SavedAgent): SavedAgent[] {
  const idx = list.findIndex((s) => s.seatId === entry.seatId);
  if (idx < 0) return [...list, entry];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

export function removeSavedAgent(list: SavedAgent[], seatId: string): SavedAgent[] {
  return list.filter((s) => s.seatId !== seatId);
}
