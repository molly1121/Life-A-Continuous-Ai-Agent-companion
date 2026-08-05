// Probe for the MCP half of the minimal agent.
//
//   node --experimental-sqlite probe_mcp.js
//
// Spawns mcp_server.js as a child, speaks JSON-RPC to it exactly as an agent host
// would, and checks that the tools do what their descriptions promise. No API key
// and no model needed — this verifies the hands, not the mind.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(tmpdir(), `life-mcp-probe-${process.pid}.db`);
rmSync(DB, { force: true });

const srv = spawn(process.execPath, ['--experimental-sqlite', join(HERE, 'mcp_server.js'), DB], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) fails++;
};

// --- minimal JSON-RPC client -------------------------------------------------
let nextId = 1;
const waiting = new Map();
let buf = '';
srv.stdout.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = waiting.get(msg.id);
    if (resolve) { waiting.delete(msg.id); resolve(msg); }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 10000);
  });
}
const callText = async (name, args = {}) => {
  const r = await send('tools/call', { name, arguments: args });
  return r.result.content[0].text;
};

// --- the probe ---------------------------------------------------------------
try {
  const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  check('initialize handshake', init.result?.serverInfo?.name === 'life-minimal-agent',
    init.result?.serverInfo?.name);

  const list = (await send('tools/list')).result.tools;
  const names = list.map(t => t.name);
  check('tools are advertised', names.length >= 7, names.join(', '));
  check('every tool carries a description written to the agent',
    list.every(t => t.description && t.description.length > 40));

  // memory: store, then find by topic
  const stored = await callText('remember', {
    content: 'the night the power failed and the stairwell smelled of woodsmoke',
    tags: ['weather'], category: 'emotion', importance: 4, arousal: 0.7,
    anchor: { smell: { name: 'woodsmoke' }, cadence: 'Em', color: ['red'] },
  });
  check('remember stores a card', stored.startsWith('stored'), stored);

  const found = await callText('search_memory', { query: 'the night the lights went out' });
  check('search finds it by topic', found.includes('woodsmoke'), found.slice(0, 60));

  const empty = await callText('search_memory', { query: 'quantum chromodynamics' });
  check('search returns nothing rather than filler', empty.startsWith('(nothing'), empty);

  // involuntary recall: a fresh card is not dormant, so the cue should stay quiet
  const tooFresh = await callText('drift_recall', { smell: 'woodsmoke' });
  check('drift stays quiet on a card that was just touched', tooFresh.startsWith('(nothing'), tooFresh.slice(0, 50));

  // an open loop, then closing it (which is also the satisfaction hook)
  const loop = await callText('remember', {
    content: 'said I would look into the noisy fan', resolved: false, importance: 4,
  });
  const id = loop.match(/\(([0-9a-f]+)\)/)[1];
  const before = await callText('drive_state');
  const closed = await callText('resolve_memory', { id });
  check('resolve closes the loop', closed === 'closed', closed);

  const after = await callText('drive_state');
  check('drive_state leads with a phrase, numbers underneath',
    after.includes('SEEKING') && after.split('\n')[0] !== '', after.split('\n')[0].slice(0, 50));
  check('state is readable before and after', before.includes('CARE') && after.includes('CARE'));

  const bad = await send('tools/call', { name: 'no_such_tool', arguments: {} });
  check('unknown tool errors instead of crashing the server', bad.result?.isError === true);

  const stillAlive = await send('ping');
  check('server survives a bad call', !!stillAlive.result);
} catch (e) {
  check(`probe threw: ${e.message}`, false);
} finally {
  srv.kill();
  rmSync(DB, { force: true });
}

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
