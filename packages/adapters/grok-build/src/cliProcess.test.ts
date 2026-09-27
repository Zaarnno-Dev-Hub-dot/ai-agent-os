import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterConfig } from '@agent-os/shared';
import {
  challengeEffortFor,
  chatTurnOptionsFor,
  FULL_AUTO_ROOMS_ENV_VAR,
  fullAutoRoomsFor,
  RESTRICTED_CHAT_TOOLS,
} from './cliProcess.js';

function configWith(transport: Record<string, unknown> = {}): AdapterConfig {
  return { transport };
}

// Wave 7 M0 (2026-07-09): root-cause coverage for grok-build#fast failing
// nonce-file/capability-probe verification after a gateway restart while
// the primary grok-build seat (composer) verified fine. See
// challengeEffortFor's doc comment in cliProcess.ts for the full history —
// this test just pins the observable contract so the allowlist can't drift
// silently back to "no override for anyone" (Wave 5's regression) or
// "override for composer too" (the original 2026-07-04 400 error).
describe('challengeEffortFor', () => {
  it('returns "low" for grok-4.5 — a reasoning model that defaults to high effort', () => {
    expect(challengeEffortFor('grok-4.5')).toBe('low');
  });

  it('returns undefined for grok-composer-2.5-fast — errors when passed --effort at all', () => {
    expect(challengeEffortFor('grok-composer-2.5-fast')).toBeUndefined();
  });

  it('returns undefined when no model is configured (account default = composer today)', () => {
    expect(challengeEffortFor(undefined)).toBeUndefined();
  });

  it('returns undefined for an unrecognized model id (explicit allowlist, not a heuristic)', () => {
    expect(challengeEffortFor('some-future-grok-model')).toBeUndefined();
  });
});

// Fable ruling M-WM-1/B4-M3 (2026-07-21 triage): grok-build's alwaysApprove
// on every chat turn was NOT approved as-is (the 2026-07-18 "go" covered
// unattended BUILDING, not unrestricted Shell/Write on every room a seat
// sits in). fullAutoRoomsFor/chatTurnOptionsFor are the fix — pin the
// observable contract so a future edit can't silently widen this back to
// "always approve everywhere" without a test failing.
describe('fullAutoRoomsFor', () => {
  const ORIGINAL_ENV = process.env[FULL_AUTO_ROOMS_ENV_VAR];

  beforeEach(() => {
    delete process.env[FULL_AUTO_ROOMS_ENV_VAR];
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env[FULL_AUTO_ROOMS_ENV_VAR];
    else process.env[FULL_AUTO_ROOMS_ENV_VAR] = ORIGINAL_ENV;
  });

  it('is empty when neither the transport field nor the env var is set (fail-closed default)', () => {
    expect(fullAutoRoomsFor(configWith())).toEqual(new Set());
  });

  it('reads the transport config field when set', () => {
    const config = configWith({ fullAutoRoomIds: ['room-a', 'room-b'] });
    expect(fullAutoRoomsFor(config)).toEqual(new Set(['room-a', 'room-b']));
  });

  it('falls back to the env var (comma-separated, trimmed) when the transport field is absent', () => {
    process.env[FULL_AUTO_ROOMS_ENV_VAR] = ' room-x, room-y ,room-z';
    expect(fullAutoRoomsFor(configWith())).toEqual(new Set(['room-x', 'room-y', 'room-z']));
  });

  it('prefers the transport config field over the env var when both are set', () => {
    process.env[FULL_AUTO_ROOMS_ENV_VAR] = 'room-from-env';
    const config = configWith({ fullAutoRoomIds: ['room-from-config'] });
    expect(fullAutoRoomsFor(config)).toEqual(new Set(['room-from-config']));
  });

  // B4 regression (2026-07-21 review-panel finding): the guard used to key
  // on `.length > 0`, so an explicit `fullAutoRoomIds: []` — the MOST
  // security-conscious config, "full-auto in NO room" — was treated as
  // "unconfigured" and fell through to the process-global env var, silently
  // re-granting full-auto in rooms the operator zeroed out. Presence
  // (`!== undefined`), not length, must gate this.
  it('B4: an explicit empty array means NO room gets full-auto, even with the env var set (presence gates, not length)', () => {
    process.env[FULL_AUTO_ROOMS_ENV_VAR] = 'room-from-env';
    const config = configWith({ fullAutoRoomIds: [] });
    expect(fullAutoRoomsFor(config)).toEqual(new Set());
  });
});

describe('chatTurnOptionsFor', () => {
  it('returns alwaysApprove for a room in the config allowlist', () => {
    const config = configWith({ fullAutoRoomIds: ['build-room'] });
    expect(chatTurnOptionsFor(config, 'build-room')).toEqual({ alwaysApprove: true });
  });

  it('returns the restricted read-only tool set for a room NOT in the allowlist', () => {
    const config = configWith({ fullAutoRoomIds: ['build-room'] });
    expect(chatTurnOptionsFor(config, 'some-other-room')).toEqual({ allowedTools: RESTRICTED_CHAT_TOOLS });
  });

  it('restricts when no allowlist is configured at all, even for a plausible room id', () => {
    expect(chatTurnOptionsFor(configWith(), 'build-room')).toEqual({ allowedTools: RESTRICTED_CHAT_TOOLS });
  });

  it('restricts when roomId is undefined (a send() that bypassed the relay stamp) — fail closed', () => {
    const config = configWith({ fullAutoRoomIds: ['build-room'] });
    expect(chatTurnOptionsFor(config, undefined)).toEqual({ allowedTools: RESTRICTED_CHAT_TOOLS });
  });

  it('the restricted tool set never includes Shell or Write', () => {
    expect(RESTRICTED_CHAT_TOOLS).not.toContain('Shell');
    expect(RESTRICTED_CHAT_TOOLS).not.toContain('Write');
  });

  // B4 regression (2026-07-21 review-panel finding): config [] + env set
  // must still restrict — this is the exact scenario the length-based guard
  // got wrong (see fullAutoRoomsFor's B4 test above for the underlying set;
  // this pins the observable chat-turn-options contract on top of it).
  it('B4: fullAutoRoomIds: [] restricts every room, never falling through to the env var', () => {
    const ORIGINAL_ENV = process.env[FULL_AUTO_ROOMS_ENV_VAR];
    process.env[FULL_AUTO_ROOMS_ENV_VAR] = 'build-room';
    try {
      const config = configWith({ fullAutoRoomIds: [] });
      expect(chatTurnOptionsFor(config, 'build-room')).toEqual({ allowedTools: RESTRICTED_CHAT_TOOLS });
    } finally {
      if (ORIGINAL_ENV === undefined) delete process.env[FULL_AUTO_ROOMS_ENV_VAR];
      else process.env[FULL_AUTO_ROOMS_ENV_VAR] = ORIGINAL_ENV;
    }
  });
});

// M10 (2026-07-21 review-panel finding): grok 0.2.82 has no verified flag to
// scope Read/Grep/Glob to a directory (see RESTRICTED_CHAT_TOOLS's doc
// comment in cliProcess.ts) — the restricted posture is read-ONLY, not
// read-SCOPED, and a prompt-injected turn can still Read/Grep/Glob any
// absolute path the seat's OS user can reach. This test documents that
// residual gap so it can't be silently forgotten: it pins that the
// restricted branch returns ONLY an allowedTools list (no path-scoping
// field exists to assert on, because none exists). If grok ever ships a
// verified path-scoping flag, wire it into chatTurnOptionsFor and update
// this test to assert the new, narrower contract — don't just delete it.
describe('RESTRICTED_CHAT_TOOLS (M10 residual exfil channel)', () => {
  it('the restricted posture is READ-ONLY, not READ-SCOPED — no path-scoping flag backs it today', () => {
    const config = configWith();
    const opts = chatTurnOptionsFor(config, 'some-room');
    expect(Object.keys(opts)).toEqual(['allowedTools']);
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });
});
