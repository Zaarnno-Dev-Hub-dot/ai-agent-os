/**
 * Shared core of "connect (and nonce-verify) a set of seats on the running
 * gateway over its WebSocket, wait for each to reach a terminal status."
 *
 * Extracted out of scripts/connect-agent.mjs so scripts/connect-seats-on-boot.mjs
 * (the "AgentOS Seats" scheduled task's entry point, Wave 5) reuses the exact
 * same connect/parse/wait logic instead of copy-pasting it — this repo
 * already has a named tech-debt item for copy-pasted adapter/connect logic
 * drifting apart (docs/TECH-DEBT.md "Adapter duplication"), so a second
 * instance of it was worth avoiding here.
 *
 * Behavior is byte-identical to connect-agent.mjs's original inline version:
 * same seat-arg parsing, same seatId derivation, same per-seat transport
 * overrides, same terminal-status/timeout handling. The only difference is
 * this module resolves a Promise<exitCode> instead of calling process.exit()
 * itself, so callers (the CLI script and the boot script) each decide when
 * to actually exit the process.
 *
 */

export const INSTANCE_ID_PATTERN = /^[a-z0-9-]{1,16}$/;

/** Parse one seat token into { manifestId, instanceId? }. instanceId is omitted (not 'main') when absent. */
export function parseSeatArg(token) {
  const hashIdx = token.indexOf('#');
  if (hashIdx < 0) return { manifestId: token };
  const manifestId = token.slice(0, hashIdx);
  const instanceId = token.slice(hashIdx + 1);
  if (!manifestId) {
    throw new Error(`invalid seat arg "${token}": empty manifestId before '#'`);
  }
  if (!instanceId || (instanceId !== 'main' && !INSTANCE_ID_PATTERN.test(instanceId))) {
    throw new Error(`invalid seat arg "${token}": instanceId must match [a-z0-9-]{1,16} (no '#')`);
  }
  return { manifestId, instanceId };
}

/** Same derivation as gateway/src/agents.ts deriveSeatId — kept in sync manually (these scripts can't import gateway internals over the WS boundary). */
export function deriveSeatId(manifestId, instanceId) {
  if (!instanceId || instanceId === 'main') return manifestId;
  return `${manifestId}#${instanceId}`;
}

/**
 * Connects every seat token (manifestId or manifestId#instanceId) on the
 * gateway at gatewayUrl and waits for each to reach VERIFIED, FAILED or
 * OFFLINE (or for timeoutMs to pass).
 *
 * opts.transportOverride: plain object used as config.transport for every
 * token (endpoint/model for HTTP adapters, model for CLI ones).
 * opts.label: display name. opts.remember: ask the gateway to save the seat.
 *
 * Resolves 0 if every seat verified, 1 if any FAILED or the timeout hit,
 * 2 on a malformed token. Never rejects.
 */
export function connectSeats(tokens, opts = {}) {
  const gatewayUrl = opts.gatewayUrl ?? 'ws://127.0.0.1:4110/ws';
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const transportOverride = opts.transportOverride ?? {};

  return new Promise((resolve) => {
    let seats;
    try {
      seats = tokens.map(parseSeatArg).map((s) => ({ ...s, seatId: deriveSeatId(s.manifestId, s.instanceId) }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      resolve(2);
      return;
    }

    const ws = new WebSocket(gatewayUrl);
    // Tracked by SEAT id (not the raw token) — the gateway's agent.status
    // events report agentId as the seat id, e.g. `claude-code#test`, not the
    // bare manifestId once an instanceId is in play.
    const pending = new Set(seats.map((s) => s.seatId));
    let started = false;
    let failed = false;
    let settled = false;

    const send = (type, payload) => ws.send(JSON.stringify({ v: 1, timestamp: Date.now(), type, payload }));

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* best-effort */
      }
      resolve(code);
    };

    ws.onmessage = (raw) => {
      const ev = JSON.parse(String(raw.data));
      if (ev.type === 'state.sync' && !started) {
        started = true;
        for (const { manifestId, instanceId, seatId } of seats) {
          console.log(`connecting ${seatId}...`);
          send('agent.connect', {
            manifestId,
            instanceId,
            instanceLabel: opts.label,
            config: { transport: { ...transportOverride } },
            remember: opts.remember === true,
          });
        }
      }
      if (ev.type === 'agent.status' && pending.has(ev.payload.agentId)) {
        console.log(`${ev.payload.agentId}: ${ev.payload.status}`);
        if (['VERIFIED', 'FAILED', 'OFFLINE'].includes(ev.payload.status)) {
          if (ev.payload.status === 'FAILED') failed = true;
          pending.delete(ev.payload.agentId);
          if (pending.size === 0) finish(failed ? 1 : 0);
        }
      }
      if (ev.type === 'error') console.error(`gateway error [${ev.payload.code}]: ${ev.payload.message}`);
    };
    ws.onerror = (err) => {
      console.error(`WebSocket error connecting to ${gatewayUrl}: ${err?.message ?? err}`);
    };

    const timer = setTimeout(() => {
      console.error(`timeout; still pending: ${[...pending].join(', ')}`);
      finish(1);
    }, timeoutMs);
  });
}

/**
 * Same contract as connectSeats, but connects each token in its own call, one
 * after another. Several CLI harnesses (grok in particular) lose the
 * nonce-file challenge when two of their processes run at once, so seats are
 * never connected concurrently. Resolves 0 only if every seat verified.
 */
export async function connectSeatsOrdered(tokens, opts = {}) {
  let code = 0;
  for (const token of tokens) {
    code = Math.max(code, await connectSeats([token], opts));
  }
  return code;
}
