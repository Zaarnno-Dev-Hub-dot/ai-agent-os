/**
 * Connect (and proof-of-life verify) agents on the RUNNING gateway from the
 * command line — the scriptable alternative to the dashboard's "+ Add agent"
 * panel.
 *
 * Usage:
 *   node scripts/connect-agent.mjs claude-code
 *   node scripts/connect-agent.mjs codex --remember
 *   node scripts/connect-agent.mjs ollama#local --label "Local Qwen" --remember \
 *     --transport-json '{"endpoint":"http://127.0.0.1:11434/v1","model":"qwen3:8b","modelPattern":"^qwen3"}'
 *
 * A token is `manifestId` or `manifestId#instanceId` (instanceId: [a-z0-9-]{1,16})
 * for a second agent of the same kind. --transport-json takes inline JSON or a
 * path to a .json file and is used as config.transport for every token.
 * --remember saves the agent so the gateway reconnects it on every start.
 */
import { connectSeatsOrdered } from './lib/connectSeats.mjs';
import { parseArgv } from './lib/transportJson.mjs';

const USAGE =
  'usage: node scripts/connect-agent.mjs <manifestId>[#instanceId] [...] [--transport-json <json-or-file>] [--label <name>] [--remember]';

let argv = process.argv.slice(2);
const remember = argv.includes('--remember');
argv = argv.filter((a) => a !== '--remember');
let label;
const labelIdx = argv.indexOf('--label');
if (labelIdx >= 0) {
  label = argv[labelIdx + 1];
  argv.splice(labelIdx, 2);
}

if (argv.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

let seatArgs;
let transportOverride;
try {
  ({ seatArgs, transportOverride } = parseArgv(argv));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

if (seatArgs.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

const code = await connectSeatsOrdered(seatArgs, { transportOverride, remember, label });
process.exit(code);
