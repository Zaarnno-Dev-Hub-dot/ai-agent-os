import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentState } from '@agent-os/shared';
import {
  DEFAULT_ROUTER_CONFIG,
  appendRouterLog,
  classify,
  ensureRouterConfig,
  flushRouterLog,
  hasRouterMention,
  isSeatEligible,
  pick,
  activePresetOf,
  type RouterPreset,
} from './router.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'router-test-'));
}

function makeAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    manifest: {
      id: 'test',
      displayName: 'Test',
      harness: 'claude-code',
      flavor: 'cli-stream',
      avatar: '✦',
      color: '#000',
      capabilities: [],
      identity: { modelPattern: '^test' },
      trust: 'full',
      manifestVersion: 1,
    },
    config: { transport: {} },
    status: 'VERIFIED',
    lastHeartbeat: Date.now(),
    assignedRooms: [],
    challengeHistory: [],
    session: {} as AgentState['session'],
    ...overrides,
  };
}

describe('classify', () => {
  it('classifies a code-fenced message as code', () => {
    expect(classify('```ts\nconst x = 1;\n```')).toBe('code');
  });

  it('classifies build|fix|implement-shaped requests as code', () => {
    expect(classify('please fix the README typo')).toBe('code');
    expect(classify('build a login form')).toBe('code');
    expect(classify('implement the retry logic')).toBe('code');
  });

  it('classifies design|architect|why-shaped requests as hard', () => {
    expect(classify('why did we choose this architecture')).toBe('hard');
    expect(classify('design the new auth flow')).toBe('hard');
  });

  it('classifies a long message (>240 chars) as hard even without keywords', () => {
    const long = 'a'.repeat(241);
    expect(classify(long)).toBe('hard');
  });

  it('classifies a short everyday message as everyday', () => {
    expect(classify('write a haiku')).toBe('everyday');
    expect(classify('good morning')).toBe('everyday');
  });

  it('prefers code over hard when both signals are present', () => {
    // Contains a code fence AND is over 240 chars — code fence wins per the
    // documented order (code fences/build|fix|implement checked first).
    const msg = '```\n' + 'x'.repeat(250) + '\n```';
    expect(classify(msg)).toBe('code');
  });
});

describe('hasRouterMention', () => {
  it('is true for @router at the start of a message', () => {
    expect(hasRouterMention('@router write a haiku')).toBe(true);
  });

  it('is true for @router preceded by other text', () => {
    expect(hasRouterMention('hey @router can you help')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasRouterMention('@ROUTER write a haiku')).toBe(true);
    expect(hasRouterMention('@Router write a haiku')).toBe(true);
  });

  it('is false for a message with no mentions at all', () => {
    expect(hasRouterMention('just a plain message')).toBe(false);
  });

  it('is false for a message mentioning a different agent', () => {
    expect(hasRouterMention('@grok-build fix this')).toBe(false);
  });

  it('does NOT match a different agent id that merely starts with "router" as a substring', () => {
    // Regression: a naive word-boundary check (`/@router\b/`) also fires on
    // "@router-build" because \b sits between "r" and "-" too. The real
    // tokenizer (matching relay.ts's own /@([a-z0-9_-]+)/gi capture) must
    // treat "router-build" as ONE token, distinct from "router".
    expect(hasRouterMention('@router-build fix this')).toBe(false);
  });

  it('is true when @router co-occurs with other mentions in the same message', () => {
    expect(hasRouterMention('@router @grok-build hello')).toBe(true);
  });
});

describe('isSeatEligible', () => {
  const agents = new Map<string, AgentState>();

  beforeEach(() => {
    agents.clear();
  });

  it('is true for a VERIFIED, connected, room-member, non-busy seat', () => {
    agents.set('hermes', makeAgentState());
    expect(isSeatEligible('hermes', agents, ['human', 'hermes'], new Set())).toBe(true);
  });

  it('is false when the seat is not a room member', () => {
    agents.set('hermes', makeAgentState());
    expect(isSeatEligible('hermes', agents, ['human'], new Set())).toBe(false);
  });

  it('is false when the seat is unknown to the gateway', () => {
    expect(isSeatEligible('nope', agents, ['human', 'nope'], new Set())).toBe(false);
  });

  it('is false when the seat is not VERIFIED', () => {
    agents.set('hermes', makeAgentState({ status: 'CHALLENGED' }));
    expect(isSeatEligible('hermes', agents, ['human', 'hermes'], new Set())).toBe(false);
  });

  it('is false when the seat has no live session', () => {
    agents.set('hermes', makeAgentState({ session: undefined }));
    expect(isSeatEligible('hermes', agents, ['human', 'hermes'], new Set())).toBe(false);
  });

  it('is false when the seat is busy', () => {
    agents.set('hermes', makeAgentState());
    expect(isSeatEligible('hermes', agents, ['human', 'hermes'], new Set(['hermes']))).toBe(false);
  });
});

describe('pick', () => {
  const preset: RouterPreset = DEFAULT_ROUTER_CONFIG.presets.default;
  let agents: Map<string, AgentState>;

  beforeEach(() => {
    agents = new Map();
  });

  it('picks the first eligible candidate in order', () => {
    agents.set('hermes', makeAgentState());
    agents.set('grok-build', makeAgentState());
    const result = pick('everyday', preset, agents, ['human', 'hermes', 'grok-build'], new Set());
    expect(result.chosen).toBe('hermes');
    expect(result.tried).toEqual(['hermes']);
  });

  it('skips a candidate that is unverified and tries the next candidate', () => {
    agents.set('hermes', makeAgentState({ status: 'STALE' }));
    agents.set('grok-build', makeAgentState());
    const result = pick('everyday', preset, agents, ['human', 'hermes', 'grok-build'], new Set());
    expect(result.chosen).toBe('grok-build');
    expect(result.tried).toEqual(['hermes', 'grok-build']);
  });

  it('skips a candidate that is busy and tries the next candidate', () => {
    agents.set('hermes', makeAgentState());
    agents.set('grok-build', makeAgentState());
    const result = pick('everyday', preset, agents, ['human', 'hermes', 'grok-build'], new Set(['hermes']));
    expect(result.chosen).toBe('grok-build');
    expect(result.tried).toEqual(['hermes', 'grok-build']);
  });

  it('skips a candidate that is not a room member', () => {
    agents.set('hermes', makeAgentState());
    agents.set('grok-build', makeAgentState());
    // hermes connected but not IN this room
    const result = pick('everyday', preset, agents, ['human', 'grok-build'], new Set());
    expect(result.chosen).toBe('grok-build');
    expect(result.tried).toEqual(['hermes', 'grok-build']);
  });

  it('falls back to the class fallback when every candidate is unavailable', () => {
    agents.set('claude-code', makeAgentState());
    // Neither hermes nor grok-build (the 'everyday' candidates) are connected.
    const result = pick('everyday', preset, agents, ['human', 'claude-code'], new Set());
    expect(result.chosen).toBe('claude-code');
    expect(result.tried).toEqual(['hermes', 'grok-build', 'claude-code']);
  });

  it('the code class has one candidate (grok-build) and falls back to claude-code', () => {
    agents.set('claude-code', makeAgentState());
    const result = pick('code', preset, agents, ['human', 'claude-code'], new Set());
    expect(result.chosen).toBe('claude-code');
    expect(result.tried).toEqual(['grok-build', 'claude-code']);
  });

  it('fails loud (chosen: null) when candidates AND fallback are all unavailable', () => {
    // Nobody connected at all.
    const result = pick('everyday', preset, agents, ['human'], new Set());
    expect(result.chosen).toBeNull();
    expect(result.tried).toEqual(['hermes', 'grok-build', 'claude-code']);
  });

  it('fails loud (chosen: null) for the hard class with no fallback configured, when its sole candidate is unavailable', () => {
    const result = pick('hard', preset, agents, ['human'], new Set());
    expect(result.chosen).toBeNull();
    // hard has fallback: null — only the one candidate is tried, no fallback appended.
    expect(result.tried).toEqual(['claude-code']);
  });

  it('never picks a seat outside the room even if it is the only connected agent', () => {
    // grok-build is VERIFIED and free, but not a member of this room.
    agents.set('grok-build', makeAgentState());
    const result = pick('code', preset, agents, ['human'], new Set());
    expect(result.chosen).toBeNull();
    expect(result.tried).toEqual(['grok-build', 'claude-code']);
  });
});

describe('ensureRouterConfig', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = freshDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes the default config to disk when router.json is absent', () => {
    const config = ensureRouterConfig(dataDir);
    expect(config).toEqual(DEFAULT_ROUTER_CONFIG);
    const path = join(dataDir, 'router.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(DEFAULT_ROUTER_CONFIG);
  });

  it('loads an existing router.json unchanged', () => {
    ensureRouterConfig(dataDir); // creates the default file
    const first = ensureRouterConfig(dataDir);
    expect(first).toEqual(DEFAULT_ROUTER_CONFIG);
  });

  it('falls back to the in-memory default when router.json is corrupt, without throwing', () => {
    const path = join(dataDir, 'router.json');
    writeFileSync(path, '{ not valid json', 'utf8');
    expect(() => ensureRouterConfig(dataDir)).not.toThrow();
    expect(ensureRouterConfig(dataDir)).toEqual(DEFAULT_ROUTER_CONFIG);
  });
});

describe('activePresetOf', () => {
  it('returns the preset named by activePreset', () => {
    expect(activePresetOf(DEFAULT_ROUTER_CONFIG)).toBe(DEFAULT_ROUTER_CONFIG.presets.default);
  });

  it('falls back to the default preset when activePreset names an unknown preset', () => {
    const config = { ...DEFAULT_ROUTER_CONFIG, activePreset: 'nonexistent' };
    expect(activePresetOf(config)).toBe(DEFAULT_ROUTER_CONFIG.presets.default);
  });
});

describe('appendRouterLog', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = freshDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('appends one JSON line per call to data/router-log.jsonl (async write chain — awaits flushRouterLog)', async () => {
    appendRouterLog(dataDir, { ts: 1, roomId: 'room-1', cls: 'everyday', chosen: 'hermes', candidatesTried: ['hermes'] });
    appendRouterLog(dataDir, { ts: 2, roomId: 'room-1', cls: 'code', chosen: null, candidatesTried: ['grok-build', 'claude-code'] });
    await flushRouterLog();

    const path = join(dataDir, 'router-log.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: 1, roomId: 'room-1', cls: 'everyday', chosen: 'hermes', candidatesTried: ['hermes'] });
    expect(JSON.parse(lines[1])).toEqual({ ts: 2, roomId: 'room-1', cls: 'code', chosen: null, candidatesTried: ['grok-build', 'claude-code'] });
  });

  // Non-blocking hot path: calling
  // appendRouterLog must return synchronously (fire-and-forget) rather than
  // block the caller on disk I/O — the whole point of the fix. A cheap smoke
  // assertion: the call itself returns `undefined` immediately (not a
  // Promise), i.e. the routing path is never made to `await` a log write.
  it('returns synchronously (non-blocking) — does not return a Promise to the caller', async () => {
    const result = appendRouterLog(dataDir, {
      ts: 3,
      roomId: 'room-1',
      cls: 'everyday',
      chosen: 'hermes',
      candidatesTried: ['hermes'],
    });
    expect(result).toBeUndefined();
    await flushRouterLog();
  });

  it('preserves write ORDER across many rapid-fire calls despite the async chain', async () => {
    const total = 25;
    for (let i = 0; i < total; i++) {
      appendRouterLog(dataDir, { ts: i, roomId: 'room-1', cls: 'everyday', chosen: 'hermes', candidatesTried: ['hermes'] });
    }
    await flushRouterLog();

    const path = join(dataDir, 'router-log.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(total);
    lines.forEach((line, i) => {
      expect(JSON.parse(line).ts).toBe(i);
    });
  });
});
