/**
 * Server-side model vocabulary allowlist for `agent.set-model`. The UI dropdown is NOT a security boundary (adversarial-review finding,
 * 7/7): a raw WS frame could otherwise inject arbitrary CLI args via the model
 * string, e.g. '--dangerous-flag' becoming a literal child-process flag —
 * index.ts's `agent.set-model` handler checks every requested model against
 * this table before mutating a live seat's transport.model.
 *
 * Extracted to its own module (matches the router.ts / cost.ts pattern of
 * pulling pure lookups out of the untested index.ts entrypoint) so it has its
 * own test coverage — see modelVocab.test.ts.
 *
 * grok-build entries verified live 2026-07-08 via `grok models` (laptop grok
 * CLI 0.2.91): grok-4.5 (account default) and grok-composer-2.5-fast are the
 * two real model ids. Backs the two permanent Grok seats (Wave 5): the
 * `grok-build` seat (main, pinned to grok-composer-2.5-fast, displayed "Grok
 * Composer") and `grok-build#fast` (pinned to grok-4.5, displayed "Grok 4.5")
 * — see scripts/connect-agent.mjs for the connect-time pins and
 * packages/ui/src/components/AgentCard.tsx for the mirrored picker options.
 * The allowlist is keyed by MANIFEST id, not seat id: every seat of a harness
 * (main or #instance) may be pinned to any model in that harness's list.
 */
export const MODEL_VOCAB: Record<string, readonly string[]> = {
  // 'claude-fable-5' added 2026-07-11 for the claude-code#advisor advisor
  // seat — CLI
  // help text (2.1.205) confirms 'claude-fable-5' is a legal --model value
  // (alias 'fable' also works). Listed for every claude-code seat per this
  // table's manifest-keyed contract, not just advisor.
  // Bare ids keep every existing seat's connect-time pin selectable exactly as
  // before. The 'claude-opus-5:<effort>' composites were added 2026-08-08
  // — the
  // claude-code adapter's parseModelSpec splits them into --model + --effort,
  // so one picker drives both without a new client event. Effort values are
  // the CLI's own (--effort low|medium|high|xhigh|max, verified live against
  // 2.1.205's --help on 2026-07-11).
  'claude-code': [
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-5:low',
    'claude-opus-5:medium',
    'claude-opus-5:high',
    'claude-opus-5:xhigh',
    'claude-opus-5:max',
  ],
  'grok-build': ['grok-composer-2.5-fast', 'grok-4.5'],
  // Codex (2026-08-08). Every entry is a COMPOSITE '<model>:<effort>' token,
  // not a bare model id — the codex adapter splits it back apart in
  // cliProcess.ts's parseModelSpec (see its doc comment for why). the operator asked
  // to switch BOTH tier and reasoning effort from the dash; `agent.set-model`
  // is the only per-seat mutation verb the gateway has, so both ride this one
  // allowlist and the existing server-side vocabulary check covers effort for
  // free. Nothing here reaches argv unvalidated.
  //
  // The three model ids were VERIFIED LIVE against the operator's ChatGPT-plan auth
  // on 2026-08-08 (`codex exec -m <id> --json -s read-only "Reply with ONLY:
  // OK"` returned a real agent_message for each). An unprovisioned id fails
  // loudly at the CLI ("...not supported when using Codex with a ChatGPT
  // account"), so re-verify the same way before adding a fourth.
  codex: [
    'gpt-5.6-sol:low',
    'gpt-5.6-sol:medium',
    'gpt-5.6-sol:high',
    'gpt-5.6-luna:low',
    'gpt-5.6-luna:medium',
    'gpt-5.6-luna:high',
    'gpt-5.6-terra:low',
    'gpt-5.6-terra:medium',
    'gpt-5.6-terra:high',
  ],
  // OpenCode (2026-08-12). Bare ids only — `--variant` exists on the CLI
  // (`high` answered live) but max/minimal/low/medium were not proven, so
  // there is no invented effort suffix. Every id below returned a real
  // `text` event with cost: 0 on 2026-08-12. `opencode/longcat-2.0-free`
  // is on `opencode models` but failed twice (Unexpected server error)
  // and is deliberately absent.
  opencode: [
    'opencode/big-pickle',
    'opencode/deepseek-v4-flash-free',
    'opencode/laguna-s-2.1-free',
    'opencode/ling-3.0-tiny-free',
    'opencode/mimo-v2.5-free',
    'opencode/nemotron-3-ultra-free',
  ],
  // Cursor Agent CLI (2026-08-26). Bare ids; `auto` is the connect-time pin.
  // Catalog names from Paperclip cursor-local fallback — re-verify with
  // `agent --list-models` once CURSOR_API_KEY auth works on this box.
  cursor: [
    'auto',
    'composer-1.5',
    'composer-1',
    'gpt-5.1-codex-mini',
    'sonnet-4.5',
    'sonnet-4.5-thinking',
    'opus-4.5',
    'opus-4.5-thinking',
    'grok',
  ],
};

/**
 * True when `model` is a legal `agent.set-model` value for `manifestId`. A
 * leading '-' is rejected outright (the CLI-arg-injection defense this
 * allowlist exists for) even on the off chance it collided with a real id.
 * An unknown manifestId (no configurable model — hermes, openclaw) always
 * returns false, same as an empty vocab.
 */
export function isAllowedModel(manifestId: string, model: string): boolean {
  if (model.startsWith('-')) return false;
  const vocab = MODEL_VOCAB[manifestId];
  return !!vocab && vocab.includes(model);
}
