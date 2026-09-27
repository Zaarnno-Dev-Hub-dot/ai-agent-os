import { getHumanToken } from './reviewPolicy';

/**
 * Poll withdraw client (owner-directed, : the "remove decision"
 * button). Same GATEWAY_ORIGIN convention as lib/attachments.ts's uploadFile
 * and lib/reviewPolicy.ts's setReviewPolicyMode.
 */
import { gatewayHttpOrigin } from './gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

export type WithdrawPollResult = { ok: true } | { ok: false; error: string };

/**
 * POST /api/polls/:id/withdraw — humanToken-gated (pollsRoutes.ts's
 * handlePollWithdraw), same gate as poll.decide/poll.defer. A plain REST
 * fetch rather than a new WS ClientEvent type: withdraw is a one-shot
 * retraction with no live round-trip payload beyond the resulting
 * poll.updated broadcast the gateway already sends on success, same shape
 * as reviewPolicy.ts's setReviewPolicyMode.
 */
export async function withdrawPoll(pollId: string, note?: string): Promise<WithdrawPollResult> {
  try {
    const res = await fetch(`${GATEWAY_ORIGIN}/api/polls/${encodeURIComponent(pollId)}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, humanToken: getHumanToken() }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
