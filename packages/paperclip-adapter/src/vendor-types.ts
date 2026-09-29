/**
 * VENDORED TYPE SHIMS — NOT part of the design's §3 file layout.
 *
 * `@paperclipai/adapter-utils` is not installable from this machine/network
 *. This file hand-trims ONLY the type signatures this package
 * actually consumes, transcribed from the read-only reference clone at
 * ..\..\Paperclip\repo\packages\adapter-utils\src\types.ts (session-compaction.ts
 * for AdapterSessionManagement) — never copied wholesale, no runtime code.
 *
 * If/when @paperclipai/adapter-utils becomes installable, delete this file
 * and import these types from the real package instead. Keep this file
 * type-only (no values, no logic) so there is nothing here to drift out of
 * sync with adapter behavior.
 */

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type AdapterExecutionErrorFamily = "transient_upstream" | "model_refusal";

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorFamily?: AdapterExecutionErrorFamily | null;
  retryNotBefore?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  summary?: string | null;
  clearSession?: boolean;
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

export interface AdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  context?: Record<string, unknown>;
}

export interface AdapterAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string | null;
  adapterConfig: unknown;
}

export interface AdapterRuntime {
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  authToken?: string;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  environmentName?: string | null;
}

export interface ConfigFieldOption {
  label: string;
  value: string;
  group?: string;
}

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
  options?: ConfigFieldOption[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export interface AdapterModel {
  id: string;
  label: string;
}

/** Trimmed from adapter-utils/src/session-compaction.ts — only the shape hermes_gateway sets. */
export interface AdapterSessionManagement {
  supportsSessionResume: boolean;
  nativeContextManagement: "confirmed" | "unconfirmed" | "unsupported";
  defaultSessionCompaction?: {
    enabled: boolean;
    maxSessionRuns: number;
    maxRawInputTokens: number;
    maxSessionAgeHours: number;
  };
}

export interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: AdapterSessionManagement;
  supportsLocalAgentJwt?: boolean;
  models?: AdapterModel[];
  agentConfigurationDoc?: string;
  supportsInstructionsBundle?: boolean;
  requiresMaterializedRuntimeSkills?: boolean;
  getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;
}
