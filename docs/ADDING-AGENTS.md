# Adding your own agent

There are three ways to get an agent into AI Agent OS, from easiest to most work.

## 1. It speaks the OpenAI chat API: no code

Ollama, LM Studio, vLLM, llama.cpp server, OpenAI, OpenRouter, Groq, Together,
Mistral, DeepSeek and most hosted model APIs expose `POST /v1/chat/completions`.

Click **+ Add agent**, choose **Model API**, and fill in:

- **Endpoint**: the base URL up to and including `/v1`
- **Model**: the model id the server expects
- **API key**: only for hosted services

The agent verifies at the **ATTESTED** tier: it has to echo a live nonce and
answer a fresh probe correctly, and the model id the server reports has to start
with the model you typed. It can chat, but it cannot read or write files.

## 2. It is one of the built-in CLIs: install and sign in

ChatGPT (Codex CLI), Claude (Claude Code), Grok (Grok Build), Cursor (Cursor
Agent), OpenCode, Hermes and OpenClaw have adapters already. Install the CLI,
sign in once in a terminal, then pick it in **+ Add agent**. These verify at the
**VERIFIED** tier: the gateway writes a random nonce into the agent's workspace
and the agent has to read it back with its own file tools.

## 3. Something else: write an adapter

An adapter is a small package that turns "send this chat message" into whatever
your agent understands. Copy the closest existing one:

| Your agent is... | Start from |
|---|---|
| a CLI that runs one prompt per process | `packages/adapters/codex` or `packages/adapters/claude-code` |
| a long-running HTTP server | `packages/adapters/hermes` |
| a chat-completions style API | `packages/adapters/ollama` |
| a WebSocket gateway | `packages/adapters/openclaw` |

### The contract

Defined in `packages/shared/src/types.ts`:

```ts
interface AgentAdapter {
  readonly manifest: AdapterManifest;              // id, name, avatar, identity pattern, trust, billing
  connect(config: AdapterConfig): Promise<AgentSession>;
}

interface AgentSession {
  send(msg: OutboundMessage): Promise<void>;       // a chat turn addressed to the agent
  events(): AsyncIterable<AgentEvent>;             // tokens, final messages, tool use, errors
  prove(challenge: Challenge): Promise<ChallengeResponse>; // proof-of-life
  health(): Promise<HealthReport>;                 // cheap liveness + self-reported model id
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
```

`connect()` must fail loudly (throw an `AdapterError` with `auth-missing`,
`binary-not-found`, `endpoint-down` or `handshake-failed`) rather than hand back
a session that cannot do real work. The message is shown to the user in the
Add agent panel, so make it say what to fix.

### Proof of life

- **Full tier (default)**: `prove()` receives an `identity-echo` challenge (report
  the model id; it must match `manifest.identity.modelPattern`), a `nonce-file`
  challenge (read a file the gateway wrote into `config.workspace` and return
  its contents) and a `capability-probe`. Agents with real file tools use this.
- **Attested tier**: set `verification: 'attested'` on the manifest for
  tool-less agents. See `packages/adapters/ollama` for the challenge handling.

Never put the nonce in a prompt yourself. The verifier owns it; the adapter only
relays what the agent actually produced.

### Wiring it in

1. Create `packages/adapters/<name>/` (copy `package.json` and `tsconfig.json`
   from a sibling) and export `<name>Adapter` plus a
   `getIdentityFrom<Name>Session(session)` helper.
2. Add it as a dependency of `packages/gateway/package.json`.
3. Register it in `packages/gateway/src/agents.ts` in `adaptersByManifestId`.
4. Add a preset in `packages/ui/src/lib/agentPresets.ts` with the fields your
   adapter reads from `config.transport`. Fields marked `secret` are masked in
   the UI and redacted before anything is synced to the browser.
5. `npm run build && npm run verify && npx vitest run`, then connect it from the
   dashboard.

Pull requests with new adapters are welcome - see [CONTRIBUTING](../CONTRIBUTING.md)
if present, or open an issue first to talk it through.
