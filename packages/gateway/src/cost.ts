import type { AdapterManifest, CostEvent } from '@agent-os/shared';

/**
 * USD estimate for dashboard metering (not billing-grade) — see
 * docs/DESIGN-token-budgets.md. Dollars are only real for API-billed agents:
 * returns 0 for 'subscription' and 'local' (and for undefined billing, which
 * is treated as 'subscription' per the manifest doc comment). A missing rate
 * on an 'api' manifest counts as $0/Mtok for that side, not an error — the
 * adapter simply under-declares until its manifest is completed.
 *
 * Both permanent Grok seats (Wave 5) — `grok-build` pinned to
 * grok-composer-2.5-fast and `grok-build#fast` pinned to grok-4.5 — share the
 * SAME adapter manifest (agents.ts connectAgent only overrides displayName
 * per-seat; billing is untouched), so both correctly cost $0 here regardless
 * of which model is pinned: SuperGrok is a subscription with no marginal
 * per-token dollars, and that is a harness-level (billing.kind), not a
 * per-model, fact. See modelTierFromBilling below for the same point applied
 * to the tier shim. This is deliberately NOT a per-model-id rate table — see
 * docs/TECH-DEBT.md for the Fable-owned tier-system cleanup this intentionally
 * stays out of.
 */
export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  billing: AdapterManifest['billing']
): number {
  if (billing?.kind !== 'api') return 0;
  const inRate = billing.usdPerMTokIn ?? 0;
  const outRate = billing.usdPerMTokOut ?? 0;
  return (tokensIn * inRate + tokensOut * outRate) / 1_000_000;
}

/**
 * CostEvent.modelTier is vestigial display metadata: it predates per-manifest
 * billing and cannot be dropped here because the shared CostEvent field and
 * the cost_events.model_tier DB column are both NOT NULL / required (shared
 * types are frozen for this builder — see docs/BLOCKED-*.md convention and
 * docs/TECH-DEBT.md for the Fable-owned cleanup to drop it from shared types).
 * This shim maps the new billing kind onto the old tier vocabulary purely so
 * that required field keeps getting a value; nothing reads it for budgeting
 * or display anymore — cost.ts and the UI both key off billing.kind directly.
 */
export function modelTierFromBilling(billing: AdapterManifest['billing']): CostEvent['modelTier'] {
  switch (billing?.kind) {
    case 'local':
      return 'local';
    case 'api':
      return 'mid';
    case 'subscription':
      return 'high';
    default:
      return 'high';
  }
}
