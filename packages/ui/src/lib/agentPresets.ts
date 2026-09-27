/**
 * Presets behind the sidebar's "+ Add agent" panel. Each one maps a friendly
 * choice ("ChatGPT", "Claude", "Any model API"...) to a gateway adapter
 * (manifestId) plus the few transport fields that adapter actually reads.
 *
 * Adding a preset for a NEW adapter: register the adapter in
 * packages/gateway/src/agents.ts, then add an entry here. See
 * docs/ADDING-AGENTS.md.
 */

export interface PresetField {
  /** Key inside AdapterConfig.transport. */
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

export interface AgentPreset {
  id: string;
  manifestId: string;
  name: string;
  blurb: string;
  avatar: string;
  color: string;
  /** Shown above the form: what to install / sign in to first. Backticked spans render as code. */
  setup: string[];
  fields: PresetField[];
  /** Optional one-click fills for the fields (e.g. endpoint + model for LM Studio). */
  quickFills?: Array<{ label: string; values: Record<string, string> }>;
  /** Extra transport keys derived from the entered values. */
  derive?: (values: Record<string, string>) => Record<string, unknown>;
  /** Shown under "More" instead of the main grid. */
  more?: boolean;
}

const MODEL_OPTIONAL: PresetField = {
  key: 'model',
  label: 'Model (optional)',
  help: 'Leave blank to use the CLI’s default model.',
};

/** Escape a user-typed model id so it can anchor an identity RegExp. */
export function modelPatternFor(model: string): string {
  return `^${model.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'chatgpt',
    manifestId: 'codex',
    name: 'ChatGPT',
    blurb: 'OpenAI Codex CLI, signed in with your ChatGPT account',
    avatar: '◎',
    color: '#10a37f',
    setup: ['Install the Codex CLI: `npm install -g @openai/codex`', 'Sign in once: `codex login`'],
    fields: [{ ...MODEL_OPTIONAL, placeholder: 'e.g. gpt-5-codex' }],
  },
  {
    id: 'claude',
    manifestId: 'claude-code',
    name: 'Claude',
    blurb: 'Anthropic’s Claude Code CLI',
    avatar: '✦',
    color: '#d97757',
    setup: [
      'Install Claude Code: `npm install -g @anthropic-ai/claude-code` (or the desktop app)',
      'Run `claude` once and sign in',
    ],
    fields: [{ ...MODEL_OPTIONAL, placeholder: 'e.g. claude-sonnet-5' }],
  },
  {
    id: 'grok',
    manifestId: 'grok-build',
    name: 'Grok',
    blurb: 'xAI’s Grok Build CLI',
    avatar: '⚡',
    color: '#1d9bf0',
    setup: ['Install the Grok Build CLI (`grok`)', 'Sign in once with your SuperGrok account'],
    fields: [{ ...MODEL_OPTIONAL, placeholder: 'e.g. grok-4.5' }],
  },
  {
    id: 'cursor',
    manifestId: 'cursor',
    name: 'Cursor',
    blurb: 'Cursor Agent CLI (runs under WSL on Windows)',
    avatar: '▋',
    color: '#7C3AED',
    setup: [
      'Install the Cursor Agent CLI: `curl https://cursor.com/install -fsS | bash` (inside WSL on Windows)',
      'Sign in once: `agent login`, or set `CURSOR_API_KEY`',
    ],
    fields: [{ ...MODEL_OPTIONAL, placeholder: 'e.g. auto' }],
  },
  {
    id: 'hermes',
    manifestId: 'hermes',
    name: 'Hermes',
    blurb: 'Nous Research Hermes agent (local API server)',
    avatar: '☤',
    color: '#1e7a57',
    setup: ['Install Hermes and enable its local API server (default `http://127.0.0.1:8642`)'],
    fields: [
      { key: 'endpoint', label: 'API endpoint', defaultValue: 'http://127.0.0.1:8642' },
      {
        key: 'keyFile',
        label: 'Key file (optional)',
        placeholder: 'Path to Hermes .env',
        help: 'Leave blank to use Hermes’ default config location.',
      },
      { key: 'apiKey', label: 'API key (optional)', secret: true, help: 'Only needed for a remote Hermes.' },
    ],
  },
  {
    id: 'model-api',
    manifestId: 'ollama',
    name: 'Model API',
    blurb: 'Ollama, LM Studio, OpenAI, OpenRouter, Groq — anything OpenAI-compatible',
    avatar: '◈',
    color: '#6b8f71',
    setup: [
      'Point at any server that speaks the OpenAI `/v1/chat/completions` API.',
      'Chat-only: these agents can talk but cannot touch files, so they show as ATTESTED instead of VERIFIED.',
    ],
    fields: [
      { key: 'endpoint', label: 'Endpoint (…/v1)', defaultValue: 'http://127.0.0.1:11434/v1', required: true },
      { key: 'model', label: 'Model', placeholder: 'e.g. qwen3:8b', required: true },
      { key: 'apiKey', label: 'API key (hosted services only)', secret: true },
    ],
    quickFills: [
      { label: 'Ollama', values: { endpoint: 'http://127.0.0.1:11434/v1' } },
      { label: 'LM Studio', values: { endpoint: 'http://127.0.0.1:1234/v1' } },
      { label: 'OpenAI', values: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' } },
      { label: 'OpenRouter', values: { endpoint: 'https://openrouter.ai/api/v1' } },
      { label: 'Groq', values: { endpoint: 'https://api.groq.com/openai/v1' } },
    ],
    // The endpoint's reported model id must start with what the user typed
    // (OpenAI answers "gpt-4o-mini-2024-07-18" for "gpt-4o-mini").
    derive: (v) => (v.model?.trim() ? { modelPattern: modelPatternFor(v.model) } : {}),
  },
  {
    id: 'opencode',
    manifestId: 'opencode',
    name: 'OpenCode',
    blurb: 'sst/opencode CLI with any provider it supports',
    avatar: '⬡',
    color: '#F97316',
    setup: ['Install opencode: `npm install -g opencode-ai`', 'Sign in to a provider once: `opencode auth login`'],
    fields: [{ ...MODEL_OPTIONAL, placeholder: 'e.g. opencode/big-pickle' }],
    more: true,
  },
  {
    id: 'openclaw',
    manifestId: 'openclaw',
    name: 'OpenClaw',
    blurb: 'A running OpenClaw gateway',
    avatar: '🦞',
    color: '#7c3aed',
    setup: ['Start your OpenClaw gateway (default `ws://127.0.0.1:18789`)'],
    fields: [
      { key: 'endpoint', label: 'Gateway URL', defaultValue: 'ws://127.0.0.1:18789' },
      { key: 'token', label: 'Gateway token (if required)', secret: true },
      {
        key: 'modelPattern',
        label: 'Expected model (optional)',
        placeholder: 'e.g. ^claude',
        help: 'Regular expression the reported model must match.',
      },
    ],
    more: true,
  },
];

export function presetById(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id);
}

/** Lowercase slug for an instance id: [a-z0-9-]{1,16}. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/, '');
}

/**
 * Pick the seat id for a new agent. The first agent of an adapter gets the
 * plain manifest id; later ones get `manifestId#<slug of name>`, made unique.
 * Seats that are FAILED/OFFLINE count as free, so "Connect" after a failure
 * retries the same seat instead of piling up new ones.
 */
export function pickSeat(
  manifestId: string,
  name: string,
  existing: Array<{ id: string; status: string }>
): { seatId: string; instanceId?: string } {
  const taken = new Set(existing.filter((a) => a.status !== 'FAILED' && a.status !== 'OFFLINE').map((a) => a.id));
  if (!taken.has(manifestId)) return { seatId: manifestId };
  const base = slugify(name) || 'agent';
  let candidate = base;
  for (let n = 2; taken.has(`${manifestId}#${candidate}`); n++) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 16 - suffix.length)}${suffix}`;
  }
  return { seatId: `${manifestId}#${candidate}`, instanceId: candidate };
}

/** Build the AdapterConfig.transport for a preset from the form values (blank fields are omitted). */
export function buildTransport(preset: AgentPreset, values: Record<string, string>): Record<string, unknown> {
  const transport: Record<string, unknown> = {};
  for (const field of preset.fields) {
    const v = values[field.key]?.trim();
    if (v) transport[field.key] = v;
  }
  return { ...transport, ...(preset.derive?.(values) ?? {}) };
}

/** First required field left blank, if any. */
export function missingRequired(preset: AgentPreset, values: Record<string, string>): PresetField | undefined {
  return preset.fields.find((f) => f.required && !values[f.key]?.trim());
}
