/**
 * --transport-json argv parsing (8b45887), extracted out of
 * connect-agent.mjs so it's importable for testing without also pulling in
 * that script's top-level "connect for real" side effect (same reason
 * connectSeats.mjs itself was split out of connect-agent.mjs originally).
 *
 * See connect-agent.mjs's header comment for the full rationale/usage.
 */
import { readFileSync } from 'fs';

/**
 * Resolves --transport-json's raw value to a plain object: tried as inline
 * JSON first, then as a path to a JSON file. Throws with a message naming
 * which interpretation failed and why, rather than guessing silently.
 */
export function parseTransportJsonArg(raw) {
  const trimmed = raw.trim();

  let inline;
  try {
    inline = JSON.parse(trimmed);
  } catch {
    inline = undefined;
  }
  if (inline !== undefined && inline !== null && typeof inline === 'object' && !Array.isArray(inline)) {
    return inline;
  }

  // Either not valid JSON at all, or valid JSON that isn't an object (e.g. a
  // bare number/string/array) — neither is ever a real transport config, so
  // re-trying the ORIGINAL string as a file path is more useful than a
  // confusing "parsed fine, but into a number" error.
  let fileText;
  try {
    fileText = readFileSync(trimmed, 'utf8');
  } catch (e) {
    throw new Error(
      `--transport-json value is neither a JSON object nor a readable file path ("${trimmed}"): ` +
        (e instanceof Error ? e.message : String(e))
    );
  }
  let fromFile;
  try {
    fromFile = JSON.parse(fileText);
  } catch (e) {
    throw new Error(`--transport-json file "${trimmed}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (fromFile === null || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    throw new Error(
      `--transport-json file "${trimmed}" must contain a JSON object (got ${Array.isArray(fromFile) ? 'an array' : typeof fromFile}).`
    );
  }
  return fromFile;
}

/**
 * Splits argv into seat tokens + an optional parsed transport override
 * (undefined when --transport-json wasn't passed at all). Repeated
 * --transport-json flags: last one wins. Accepts both '--transport-json
 * <value>' and '--transport-json=<value>' forms.
 */
export function parseArgv(argv) {
  const seatArgs = [];
  let transportJsonRaw;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--transport-json') {
      i += 1;
      if (i >= argv.length) {
        throw new Error('--transport-json requires a value (inline JSON or a file path).');
      }
      transportJsonRaw = argv[i];
    } else if (arg.startsWith('--transport-json=')) {
      transportJsonRaw = arg.slice('--transport-json='.length);
    } else {
      seatArgs.push(arg);
    }
  }
  const transportOverride = transportJsonRaw === undefined ? undefined : parseTransportJsonArg(transportJsonRaw);
  return { seatArgs, transportOverride };
}
