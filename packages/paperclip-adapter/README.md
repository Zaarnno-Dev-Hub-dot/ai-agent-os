# paperclip-agentos-adapter

External Paperclip adapter plugin (`type: "agentos_gateway"`) that bridges a
Paperclip employee to an Agent OS gateway seat (hermes, grok-build, openclaw,
...) without Paperclip spawning its own copy of that agent. Paperclip owns
org/tickets/budgets; Agent OS owns the verified conversation.

Design doc: `docs/DESIGN-paperclip-agentos-adapter.md` in the Agent OS repo
(this package implements its §3–§8). Reference implementation cribbed from:
`packages/adapters/hermes/src/gateway/*` in the Paperclip clone.

Ships **inert** on its branch pending owner sign-off — it is not installed
into any running Paperclip instance by this change.

## §9.1 — version convention note (read before assuming CalVer)

This package uses **semver** (`0.1.0`), not CalVer. That matches every real
`package.json` in the Paperclip clone (`hermes` adapter reads `0.3.1`) — the
CalVer example (`^2026.325.0`) only appears in
`docs/adapters/external-adapters.md`'s illustrative snippet and does not
reflect what any shipping package, or the clone's own dependency graph,
actually declares. The running Paperclip server reporting `2026.626.0`
elsewhere is a *product* version string, unrelated to individual package
versions in the monorepo. Confirm the authoritative convention again before
publishing if the upstream docs are updated.

## Install runbook (Windows, local-path — design §8)

No WSL, no npm publish. Steps:

1. **Build.** From the Agent OS repo root:
   ```
   npm run build --workspace=packages/paperclip-adapter
   ```
   This must run before Paperclip picks up `dist/` — Paperclip loads the
   built package, not `src/`.

2. **Install into Paperclip (local path).**
   ```
   POST /api/adapters
   { "localPath": "C:\\Users\\dev\\Workspace\\Projects\\agent-os\\packages\\paperclip-adapter" }
   ```
   or via the Paperclip UI: Settings → Adapters → Install from local directory.

   **Caveat — verify, don't assume (design §8):** `server/src/routes/
   adapters.ts` in the Paperclip clone runs `normalizeLocalPath()`, which
   calls `wslpath -u` in some code paths. This only matters if the Paperclip
   server itself runs under WSL. On the operator's box the Paperclip server runs
   native Windows, so this should be bypassed — but smoke-test the install
   (confirm the path Paperclip logs matches the Windows path verbatim, not a
   mangled `/mnt/c/...` form) rather than assuming.

3. **Reload after any `dist/` change in dev.**
   ```
   POST /api/adapters/agentos_gateway/reload
   ```

4. **Verify it loaded as external.**
   ```
   paperclipai adapter list
   ```
   Expect `agentos_gateway` with `loaded: true, source: "external"`.

5. **Test the environment before wiring a live agent.**
   ```
   paperclipai adapter test-environment agentos_gateway --company-id <id>
   paperclipai adapter get agentos_gateway
   ```
   `testEnvironment()` probes the configured `gatewayUrl`'s `/health` endpoint
   with the configured `apiKey`. All of `gatewayUrl`, `apiKey`, and `seatId`
   are required or the check fails with an `error`-level diagnostic before it
   ever attempts the network call.

6. **Onboard the employee** exactly like a `hermes_gateway` agent: create
   invite → join request with `adapterType: "agentos_gateway"` +
   `agentDefaultsPayload { gatewayUrl, apiKey, seatId, roomId? }` → board
   approve → values land in the agent's `adapterConfig`.

## Config fields

See `src/server/config-schema.ts` for the authoritative list. Summary:

| Field | Required | Default | Notes |
|---|---|---|---|
| `gatewayUrl` | yes | `http://127.0.0.1:4110` | Loopback HTTP allowed; remote hosts need HTTPS or the escape hatch. |
| `apiKey` | yes | — | The **gateway's own** API key, distinct from any Paperclip agent key. Secret ref. |
| `seatId` | yes | — | Must already be `AgentStatus VERIFIED` on the gateway. |
| `roomId` | no | — | Pins to an existing room (must exist, not archived, seatId must be a member). Otherwise find-or-create `"Paperclip — <seatId>"`. |
| `dangerouslyAllowInsecureRemoteHttp` | no | `false` | Dev-only escape hatch for non-loopback plain HTTP. |
| `sessionKeyStrategy` | no | `issue` | `issue \| agent \| run \| none` — local correlation key only, not sent to the gateway. |
| `timeoutSec` | no | `570` | Gateway hard-caps the actual wait at 600s regardless of this value. |
| `pollIntervalMs` | no | `1000` | Local bookkeeping only; the wake call is one long-held HTTP request, not a client poll loop. |

## §9.4 — key rotation

Rotation is a normal `PATCH` to the agent's `adapterConfig` (e.g.
`{"apiKey": "<new-key>"}`), **not** the join-only `agentDefaultsPayload` —
`agentDefaultsPayload` only seeds values at join-request time and is not
re-read afterward. To rotate the gateway API key for an already-hired
employee:

```
PATCH /api/agents/<agentId>
{ "adapterConfig": { "apiKey": "<new-gateway-key>" } }
```

Use the same masked-input pattern as `Rotate Hermes Model API Key.cmd` for
any interactive rotation tooling — never paste the key into chat or a plain
`.cmd` argument.

## §9.5 — seat policy (no `claude_local`-style hires)

Policy carryover from `DESIGN-PAPERCLIP-ADOPTION.md`: **no Claude hires**
through this bridge (quota). Only bridge `hermes`, `grok-build`, and
`openclaw` seats. Claude stays conversational in Agent OS, not hired as a
Paperclip employee via `agentos_gateway`. `testEnvironment()` and `execute()`
do not themselves special-case `seatId` against this policy — enforcement is
an onboarding-time / board-approval-time human policy, not a runtime check,
same as the adoption doc specifies. Do not add a runtime allowlist here
without a design update; this package's job is the bridge, not policy
enforcement.

## No-remote-git contract

Not applicable. This is a stateless HTTP bridge — `execute()` makes one
`POST /api/bridge/wake` call and returns; there is no execution-workspace cwd
for this adapter to persist across runs, so the no-remote-git contract's
invariants (never `git push`, never assume a remote exists, surface restore
failures) have no local worktree to attach to.

## Testing

```
npm run test --workspace=packages/paperclip-adapter
npm run verify --workspace=packages/paperclip-adapter
```

Covers: `execute()` against a mocked gateway (happy path, 408 timeout, 404
seat_unverified, 409 active-loop, 400 malformed/missing-field, malformed
non-JSON body, 401 auth, 429 rate-limited, network failure, secret redaction,
missing-config short-circuit, transport-security remote-HTTP denial/escape
hatch, roomId pass-through), `sessionCodec` round-trip (including a
JSON-stringify boundary simulating DB persistence), and `ui-parser` against
sample stdout lines for each response shape `execute()` actually emits.
