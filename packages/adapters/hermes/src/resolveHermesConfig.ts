import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { AdapterConfig, AdapterError } from '@agent-os/shared';
import type { HermesTransportConfig } from './hermesRuns.js';

/** Windows: %LOCALAPPDATA%\\hermes\\.env — matches `hermes config env-path` on native installs. */
export function defaultHermesKeyFile(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local) return join(local, 'hermes', '.env');
  }
  return join(homedir(), '.hermes', '.env');
}

/** Parse `API_SERVER_KEY=` from a .env file (no secrets logged). */
export function parseApiServerKeyFromEnvContent(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'API_SERVER_KEY') continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    return value.trim() || undefined;
  }
  return undefined;
}

export async function readApiServerKeyFromEnvFile(envPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(envPath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AdapterError(
      'auth-missing',
      `Cannot read Hermes env file: ${envPath}`,
      msg
    );
  }
  const key = parseApiServerKeyFromEnvContent(raw);
  if (!key) {
    throw new AdapterError(
      'auth-missing',
      `API_SERVER_KEY not found in ${envPath}`,
      'Run Hermes API setup or set API_SERVER_KEY in that file.'
    );
  }
  return key;
}

/**
 * Resolve transport.apiKey from keyFile (default: platform Hermes .env) or manual apiKey.
 * Gateway should call this at agent.connect time; adapter.connect also calls it.
 */
export async function resolveHermesAdapterConfig(config: AdapterConfig): Promise<AdapterConfig> {
  const transport = { ...(config.transport as HermesTransportConfig) };
  const manualKey = typeof transport.apiKey === 'string' ? transport.apiKey.trim() : '';
  if (manualKey) {
    return { ...config, transport: { ...transport, apiKey: manualKey } };
  }

  const keyFile =
    (typeof transport.keyFile === 'string' && transport.keyFile.trim()) ||
    defaultHermesKeyFile();
  const apiKey = await readApiServerKeyFromEnvFile(keyFile);
  return {
    ...config,
    transport: { ...transport, keyFile, apiKey },
  };
}