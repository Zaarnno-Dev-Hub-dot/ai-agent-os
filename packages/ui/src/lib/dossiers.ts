/**
 * Agent Dossiers — dashboard surface v1.1 (Wave 7 stretch, M4,
 * docs/DESIGN-agent-dossiers-surface.md). REST GET, same fetch-helper
 * pattern as lib/memoryGraph.ts / lib/history.ts — no websocket event for
 * this (GET-only, no live-update need per the design doc's "acceptance
 * freezes it").
 */

import { gatewayHttpOrigin } from './gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

export interface DossierResponse {
  /** RAW markdown, unrendered — the gateway never renders (F9). Pass through lib/markdown.ts's renderDossierMarkdown before displaying. */
  markdown: string;
  mtime: number;
}

/**
 * Throws on any non-2xx (including 404 — "no dossier for this seat yet" and
 * "unknown seat" are the SAME shape, per the design doc's fail-closed
 * uniformity) so the caller renders one honest empty/error state rather than
 * silently showing stale or blank content.
 */
export async function fetchDossier(seatId: string): Promise<DossierResponse> {
  const res = await fetch(`${GATEWAY_ORIGIN}/api/dossiers/${encodeURIComponent(seatId)}`);
  if (!res.ok) throw new Error(`No dossier available (${res.status})`);
  return (await res.json()) as DossierResponse;
}
