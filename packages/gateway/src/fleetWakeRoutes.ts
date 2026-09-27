/**
 * POST /api/fleet/wake — the TopBar "Wake fleet" button.
 *
 * Reconnects every agent saved from the "Add agent" panel
 * (data/saved-agents.json) that is not already VERIFIED, one at a time, and
 * posts a one-line summary into the default room. Loopback trust.
 * Single-flight: a second click while one is running gets a 409.
 */
import type { FastifyInstance } from 'fastify';
import type { AgentState } from '@agent-os/shared';

export interface WakeOutcome {
  id: string;
  status: string;
  reason?: string;
}

export interface FleetWakeRouteContext {
  agents: Map<string, AgentState>;
  defaultRoomId: () => string | null | undefined;
  postSystemLine: (roomId: string, content: string) => void;
  reconnectSaved: () => Promise<WakeOutcome[]>;
}

export interface FleetWakeResponse {
  ok: boolean;
  saved: number;
  agentsTotal: number;
  verified: number;
  failed: Array<{ id: string; reason: string }>;
}

let inFlight: Promise<FleetWakeResponse> | null = null;

export function failedOutcomes(outcomes: WakeOutcome[]): Array<{ id: string; reason: string }> {
  return outcomes
    .filter((o) => o.status !== 'VERIFIED')
    .map((o) => ({ id: o.id, reason: (o.reason || o.status).slice(0, 200) }));
}

export function wakeSummaryLine(outcomes: WakeOutcome[], verified: number, total: number): string {
  if (outcomes.length === 0) {
    return '⚡ Wake fleet: no saved agents yet — add one with “+ Add agent” in the sidebar and tick Remember.';
  }
  const failed = failedOutcomes(outcomes);
  return (
    `⚡ Wake fleet finished — ${verified}/${total} verified` +
    (failed.length ? ` · not verified: ${failed.map((f) => `${f.id} (${f.reason})`).join(', ')}` : '')
  );
}

async function runFleetWake(ctx: FleetWakeRouteContext): Promise<FleetWakeResponse> {
  const roomId = ctx.defaultRoomId();
  if (roomId) ctx.postSystemLine(roomId, '⚡ Wake fleet: reconnecting saved agents…');
  const outcomes = await ctx.reconnectSaved();
  const failed = failedOutcomes(outcomes);
  const verified = Array.from(ctx.agents.values()).filter((a) => a.status === 'VERIFIED').length;
  if (roomId) ctx.postSystemLine(roomId, wakeSummaryLine(outcomes, verified, ctx.agents.size));
  return { ok: failed.length === 0, saved: outcomes.length, agentsTotal: ctx.agents.size, verified, failed };
}

export function registerFleetWakeRoute(fastify: FastifyInstance, ctx: FleetWakeRouteContext): void {
  fastify.post('/api/fleet/wake', async (_req, reply) => {
    if (inFlight) {
      return reply.code(409).send({
        ok: false,
        error: 'wake_in_flight',
        message: 'A fleet wake is already running — wait for it to finish.',
      });
    }
    inFlight = runFleetWake(ctx).finally(() => {
      inFlight = null;
    });
    try {
      return reply.code(200).send(await inFlight);
    } catch (e) {
      return reply.code(500).send({
        ok: false,
        error: 'wake_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  fastify.get('/api/fleet/wake', async (_req, reply) => reply.code(200).send({ inFlight: inFlight != null }));
}

/** Test helper — clear single-flight latch between tests. */
export function __resetFleetWakeInFlightForTests(): void {
  inFlight = null;
}
