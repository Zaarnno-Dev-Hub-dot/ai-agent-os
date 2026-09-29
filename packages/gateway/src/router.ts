/**
 * The Router (D0) — free-first seat selection..
 *
 * The router picks SEATS, not models: a "model" in this system is a seat with
 * a pinned model, so routing is seat selection among already-connected agent
 * ids. v1 classifier is a cheap heuristic (NO LLM call) — the interface
 * (`classify(msg) -> class`) is kept stable so a bench-fed classifier can
 * replace the body in Wave 2 without touching callers.
 *
 * Config lives at `data/router.json` (gateway-local, created with defaults on
 * boot if absent — see ensureRouterConfig). No packages/shared changes: this
 * module is pure gateway-local state plus the two functions the original design
 * asks for, `classify()` and `pick()`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join } from 'path';
import type { AgentState } from '@agent-os/shared';

export type RouteClass = 'everyday' | 'code' | 'hard';

export interface RouterClassConfig {
  /** Seat ids tried in order. First VERIFIED + not-busy + room-member wins. */
  candidates: string[];
  /** Seat id tried if every candidate is unavailable. null = no fallback (fail loud). */
  fallback: string | null;
}

export interface RouterPreset {
  classes: Record<RouteClass, RouterClassConfig>;
  /** v1 is always 'heuristic' — no LLM call. Kept as a field so Wave 2 can add a bench-fed value. */
  classifier: 'heuristic';
}

export interface RouterConfig {
  presets: Record<string, RouterPreset>;
  activePreset: string;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  presets: {
    default: {
      classes: {
        everyday: { candidates: ['hermes', 'grok-build'], fallback: 'claude-code' },
        code: { candidates: ['grok-build'], fallback: 'claude-code' },
        hard: { candidates: ['claude-code'], fallback: null },
      },
      classifier: 'heuristic',
    },
  },
  activePreset: 'default',
};

function routerConfigPath(dataDir: string): string {
  return join(dataDir, 'router.json');
}

function routerLogPath(dataDir: string): string {
  return join(dataDir, 'router-log.jsonl');
}

/**
 * Load `data/router.json`, writing the default config to disk first if the
 * file is absent (spec: "created with defaults on boot if absent"). A
 * corrupt/unparsable file falls back to the in-memory default rather than
 * throwing — a malformed hand-edit must not take the whole gateway down.
 */
export function ensureRouterConfig(dataDir: string): RouterConfig {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = routerConfigPath(dataDir);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_ROUTER_CONFIG, null, 2), 'utf8');
    return structuredClone(DEFAULT_ROUTER_CONFIG);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RouterConfig;
    if (!parsed.presets || !parsed.activePreset) throw new Error('missing presets/activePreset');
    return parsed;
  } catch {
    return structuredClone(DEFAULT_ROUTER_CONFIG);
  }
}

/**
 * v1 heuristic classifier: code fences or
 * build|fix|implement-shaped requests -> 'code'; long or
 * design|architect|why-shaped requests -> 'hard'; else 'everyday'. Kept as a
 * pure function of the message text so Wave 2 can swap the body for a
 * bench-fed classifier behind the same signature.
 */
export function classify(message: string): RouteClass {
  const text = message.trim();
  const hasCodeFence = /```/.test(text);
  const codeVerbs = /\b(build|fix|implement|refactor|debug|write (a |the )?(function|test|script|code))\b/i;
  const hardWords = /\b(design|architect|why|tradeoff|trade-off|strategy|whether|should we)\b/i;

  if (hasCodeFence || codeVerbs.test(text)) return 'code';
  if (text.length > 240 || hardWords.test(text)) return 'hard';
  return 'everyday';
}

/**
 * True when `content` contains an `@router` mention as a WHOLE token — using
 * the EXACT same tokenization relay.ts's parseMentionsFromContent uses
 * (`/@([a-z0-9_-]+)/gi`, capturing the full run of id chars after `@`), not a
 * looser word-boundary check. A boundary-only check would also fire on some
 * future `@router-something` agent id that merely starts with "router";
 * matching relay.ts's own token capture keeps `@router` recognition and
 * relay.ts's mention resolution reading the same message identically.
 */
export function hasRouterMention(content: string): boolean {
  const pattern = /@([a-z0-9_-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match[1].toLowerCase() === 'router') return true;
  }
  return false;
}

export interface PickResult {
  /** Seat id chosen, or null when every candidate AND the fallback were unavailable (fail loud). */
  chosen: string | null;
  /** Every seat id considered, in the order tried — candidates then fallback (if reached). */
  tried: string[];
}

/**
 * A seat is eligible when it is a VERIFIED, connected, room member and not
 * currently mid-turn. "busy" is read the same way relay.ts's AgentRelayWorker
 * tracks it conceptually — from the outside, via AgentState — router.ts never
 * reaches into the relay's private worker queue; instead the caller in
 * index.ts passes down a `busyAgentIds` set sourced from the relay module, so
 * this function stays a pure, easily-testable decision over plain data.
 */
export function isSeatEligible(
  agentId: string,
  agents: Map<string, AgentState>,
  roomMemberIds: string[],
  busyAgentIds: ReadonlySet<string>
): boolean {
  if (!roomMemberIds.includes(agentId)) return false;
  const state = agents.get(agentId);
  if (!state || state.status !== 'VERIFIED' || !state.session) return false;
  if (busyAgentIds.has(agentId)) return false;
  return true;
}

/**
 * Pick a seat for `cls` under `preset`: try candidates in order (seat must be
 * VERIFIED + not-busy + room-member per isSeatEligible), else the class
 * fallback, else null (fail loud — the caller posts a visible room error,
 * never a silent drop).
 */
export function pick(
  cls: RouteClass,
  preset: RouterPreset,
  agents: Map<string, AgentState>,
  roomMemberIds: string[],
  busyAgentIds: ReadonlySet<string>
): PickResult {
  const classConfig = preset.classes[cls];
  const tried: string[] = [];
  if (!classConfig) return { chosen: null, tried };

  for (const candidate of classConfig.candidates) {
    tried.push(candidate);
    if (isSeatEligible(candidate, agents, roomMemberIds, busyAgentIds)) {
      return { chosen: candidate, tried };
    }
  }

  if (classConfig.fallback) {
    tried.push(classConfig.fallback);
    if (isSeatEligible(classConfig.fallback, agents, roomMemberIds, busyAgentIds)) {
      return { chosen: classConfig.fallback, tried };
    }
  }

  return { chosen: null, tried };
}

export interface RouterLogEntry {
  ts: number;
  roomId: string;
  cls: RouteClass;
  chosen: string | null;
  candidatesTried: string[];
}

// Router-log hot path: appendRouterLog used to call
// appendFileSync synchronously on every routed decision, blocking the whole
// gateway event loop per route. Now it queues an async fs/promises.appendFile
// per call and chains each write onto the previous one's promise — same
// ordering guarantee as the sync version (one write completes before the
// next starts) but without blocking the routing path on disk I/O.
//
// Once a write fails, further attempts THIS BOOT are disabled (a single
// console.error, not one per future call) — a persistently broken dataDir
// (e.g. disk full, permissions) must not spam the log or keep retrying I/O
// that's already proven broken; it must also never throw into the routing
// path (appendRouterLog's caller, routeAndRelay, is not itself wrapped in a
// try/catch).
let routerLogChain: Promise<void> = Promise.resolve();
let routerLogDisabled = false;

/** Append one line to `data/router-log.jsonl` (Wave-2 bench ingest reads this). Never throws — a log write must not break routing; enqueues the write and returns immediately. */
export function appendRouterLog(dataDir: string, entry: RouterLogEntry): void {
  if (routerLogDisabled) return;
  const line = JSON.stringify(entry) + '\n';
  routerLogChain = routerLogChain
    .then(async () => {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      await appendFile(routerLogPath(dataDir), line, 'utf8');
    })
    .catch((e) => {
      if (!routerLogDisabled) {
        routerLogDisabled = true;
        console.error('[router] failed to write router-log.jsonl — disabling further attempts this boot', e);
      }
    });
}

/**
 * Test/shutdown hook: resolves once every write enqueued so far has settled
 * (success or the one logged failure above). Production code never needs
 * this — appendRouterLog is fire-and-forget by design — but a test asserting
 * on router-log.jsonl's contents needs a deterministic point to read from,
 * since the write is no longer synchronous with the appendRouterLog call.
 */
export function flushRouterLog(): Promise<void> {
  return routerLogChain;
}

/** The currently active preset for a config, falling back to 'default' by name, else the first preset present. */
export function activePresetOf(config: RouterConfig): RouterPreset | undefined {
  return config.presets[config.activePreset] ?? config.presets['default'] ?? Object.values(config.presets)[0];
}
