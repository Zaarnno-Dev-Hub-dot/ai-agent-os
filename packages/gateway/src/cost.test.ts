import { describe, expect, it } from 'vitest';
import { grokBuildManifest } from '@agent-os/adapters-grok-build';
import { estimateCostUsd, modelTierFromBilling } from './cost.js';

// ============================================================================
// grok-build cost mapping (Wave 5 — two permanent Grok seats)
//
// Both seats (`grok-build` pinned to grok-composer-2.5-fast, `grok-build#fast`
// pinned to grok-4.5) share the ONE adapter manifest — agents.ts connectAgent
// only overrides displayName per seat, never billing — so cost.ts needs no
// per-model-id branching: whichever model is pinned, the seat's manifest.
// billing is still grokBuildManifest.billing, and these two functions only
// ever look at billing.kind. This suite pins that behavior directly against
// the real manifest object (not a hand-rolled fixture) so a future change to
// grok-build's billing kind fails this test instead of silently drifting.
// ============================================================================

describe('grok-build billing — shared across both permanent Grok seats', () => {
  it('is a SuperGrok subscription (no marginal per-token dollars) — the fact both seats key off', () => {
    expect(grokBuildManifest.billing).toEqual({ kind: 'subscription' });
  });

  it('estimateCostUsd is $0 for grok-build regardless of token volume — same whether the seat is pinned to grok-composer-2.5-fast or grok-4.5, since only billing.kind is consulted', () => {
    expect(estimateCostUsd(0, 0, grokBuildManifest.billing)).toBe(0);
    expect(estimateCostUsd(500_000, 200_000, grokBuildManifest.billing)).toBe(0);
  });

  it('modelTierFromBilling maps grok-build to the "high" display tier for both seats', () => {
    expect(modelTierFromBilling(grokBuildManifest.billing)).toBe('high');
  });
});

// ============================================================================
// estimateCostUsd — general billing.kind behavior (regression coverage)
// ============================================================================

describe('estimateCostUsd', () => {
  it("charges only 'api'-kind billing, using its per-Mtok rates", () => {
    const billing = { kind: 'api' as const, usdPerMTokIn: 3, usdPerMTokOut: 15 };
    expect(estimateCostUsd(1_000_000, 1_000_000, billing)).toBe(18);
  });

  it('returns 0 for a missing rate on an api manifest rather than throwing', () => {
    const billing = { kind: 'api' as const };
    expect(estimateCostUsd(1_000_000, 1_000_000, billing)).toBe(0);
  });

  it('returns 0 for subscription, local, and undefined billing', () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { kind: 'subscription' })).toBe(0);
    expect(estimateCostUsd(1_000_000, 1_000_000, { kind: 'local' })).toBe(0);
    expect(estimateCostUsd(1_000_000, 1_000_000, undefined)).toBe(0);
  });
});

describe('modelTierFromBilling', () => {
  it('maps every billing.kind to its tier shim value', () => {
    expect(modelTierFromBilling({ kind: 'local' })).toBe('local');
    expect(modelTierFromBilling({ kind: 'api' })).toBe('mid');
    expect(modelTierFromBilling({ kind: 'subscription' })).toBe('high');
    expect(modelTierFromBilling(undefined)).toBe('high');
  });
});
