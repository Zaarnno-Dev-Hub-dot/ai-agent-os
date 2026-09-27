/**
 * Live relay smoke: connects hermes + grok-build through the RUNNING gateway's
 * WS API (same path the UI uses), sends one human message into the first room,
 * and prints every relayed message until the window closes or the turn cap
 * pauses the room. Requires `node packages/gateway/dist/index.js` already up.
 */
const WS_URL = 'ws://127.0.0.1:4110/ws';
const COLLECT_MS = 240_000;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);

const ws = new WebSocket(WS_URL);
const send = (type, payload) =>
  ws.send(JSON.stringify({ v: 1, timestamp: Date.now(), type, payload }));

let quadId = null;
let phase = 'sync';
const status = new Map();
const transcript = [];
let capHit = false;

function connectAgent(manifestId) {
  log(`>> agent.connect ${manifestId}`);
  send('agent.connect', { manifestId, config: { transport: {} } });
}

function humanKickoff() {
  phase = 'collect';
  const content =
    'Advisor at the human seat, running the first two-agent relay smoke. ' +
    'Hermes and Grok: each reply with ONE short sentence — your name, your harness, ' +
    'and one thing you can do for the operator. One sentence only, no questions.';
  log('>> chat.send (human kickoff)');
  send('chat.send', { roomId: quadId, message: { role: 'user', senderId: 'human', content } });
  setTimeout(finish, COLLECT_MS);
}

function finish() {
  log('--- transcript ---');
  for (const m of transcript) log(`[${m.senderId}] ${m.content.slice(0, 200)}`);
  log(`--- ${transcript.length} messages, turn-cap ${capHit ? 'HIT (room paused)' : 'not reached'} ---`);
  process.exit(transcript.some((m) => m.senderId === 'grok-build') && transcript.some((m) => m.senderId === 'hermes') ? 0 : 1);
}

ws.onmessage = (raw) => {
  let ev;
  try {
    ev = JSON.parse(String(raw.data));
  } catch {
    return;
  }
  switch (ev.type) {
    case 'state.sync': {
      if (phase !== 'sync') break;
      quadId = ev.payload.activeRoomId ?? ev.payload.rooms[0]?.id;
      log(`state.sync — room ${quadId}`);
      phase = 'hermes';
      connectAgent('hermes');
      break;
    }
    case 'agent.status': {
      const { agentId, status: st } = ev.payload;
      if (status.get(agentId) === st) break;
      status.set(agentId, st);
      log(`agent.status ${agentId} = ${st}`);
      if (agentId === 'hermes' && st === 'VERIFIED' && phase === 'hermes') {
        phase = 'grok';
        connectAgent('grok-build');
      }
      if (agentId === 'grok-build' && st === 'VERIFIED' && phase === 'grok') {
        humanKickoff();
      }
      if (st === 'FAILED') {
        log(`agent ${agentId} FAILED — aborting`);
        process.exit(1);
      }
      break;
    }
    case 'message.new': {
      transcript.push(ev.payload);
      log(`msg [${ev.payload.senderId}]: ${ev.payload.content.slice(0, 140)}`);
      break;
    }
    case 'chat.typing':
      log(`typing: ${ev.payload.agentId}${ev.payload.tool ? ` (${ev.payload.tool})` : ''}`);
      break;
    case 'budget.warning':
      if (ev.payload.percent >= 100) {
        capHit = true;
        log('TURN CAP HIT — room paused');
        setTimeout(finish, 5_000);
      }
      break;
    case 'cost.event':
      log(`cost: ${ev.payload.agentId} ${ev.payload.tokensIn}in/${ev.payload.tokensOut}out ~$${ev.payload.estimatedCostUsd.toFixed(4)}`);
      break;
    case 'error':
      log(`gateway error [${ev.payload.code}]: ${ev.payload.message}`);
      break;
    default:
      break;
  }
};

ws.onerror = (e) => {
  console.error('WS error', e?.message ?? e);
  process.exit(1);
};

setTimeout(() => {
  log('overall timeout');
  finish();
}, 570_000);
