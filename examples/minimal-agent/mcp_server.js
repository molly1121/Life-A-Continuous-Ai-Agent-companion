#!/usr/bin/env node
// Minimal agent — the Node half.
//
// Two jobs in one process:
//   1. an MCP server over stdio, giving the agent hands: memory tools + drive tools;
//   2. the scheduler, ticking the drives integrator and running the nightly pipeline.
//
// Both live here because both need the database, and because the MCP server's
// lifetime is exactly the agent's lifetime — when the host exits, the ticking
// stops with it.
//
// Zero dependencies: the MCP wire protocol is JSON-RPC over stdio, and a
// conforming server is small enough to read in one sitting (see rpc() below).
// Run standalone to inspect it:
//   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp_server.js ./state.db
//
// Usage: node mcp_server.js <db-path> [--tick-seconds N]

import { openDb as openMemory } from '../../src/memory/schema.js';
import { openDb as openDrives } from '../../src/drives/schema.js';
import { addCard, setAnchor, resolveCard, openLoops, coreFacts } from '../../src/memory/cards.js';
import { recall, drift } from '../../src/memory/retrieval.js';
import { weave } from '../../src/memory/anchors.js';
import { createDrives } from '../../src/drives/integrator.js';
import { DIMS } from '../../src/drives/config.js';

const DB_PATH = process.argv[2] || './state.db';
const tickArg = process.argv.indexOf('--tick-seconds');
const TICK_SECONDS = tickArg > 0 ? Number(process.argv[tickArg + 1]) : 15 * 60;

// One handle for everything: open with each schema module so both sets of tables
// exist, then keep a single connection.
const db = openMemory(DB_PATH);
openDrives(DB_PATH).close();

db.exec(`CREATE TABLE IF NOT EXISTS pending_push (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, phrase TEXT NOT NULL, taken INTEGER NOT NULL DEFAULT 0
)`);

const setting = (k, v) => db.prepare(
  'INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?'
).run(k, v, v);

// The host application supplies the four facts the integrator needs about the world.
const host = {
  lastUserAt: () => {
    const r = db.prepare("SELECT value FROM app_settings WHERE key='last_user_at'").get();
    return r ? Number(r.value) : null;
  },
  messagesSince: () => {
    const r = db.prepare("SELECT value FROM app_settings WHERE key='turns_since_tick'").get();
    return r ? Number(r.value) : 0;
  },
  openLoopWeights: () => openLoops(db, 10).map(c => c.importance),
  sleepMarker: () => {
    const r = db.prepare("SELECT value FROM app_settings WHERE key='sleep_count'").get();
    return r ? Number(r.value) : 0;
  },
};

// Interoceptive pushes are handed to the host through the database rather than a
// callback: the host is a separate process, and a row survives a restart.
const drives = createDrives(db, host, {
  onPush: (phrase) => db.prepare('INSERT INTO pending_push (at, phrase) VALUES (?,?)').run(Date.now(), phrase),
});

function tick() {
  const state = drives.tick();
  if (!state) return;
  setting('felt_now', drives.feltSense(state) || '');       // host reads this for the heartbeat
  setting('turns_since_tick', '0');
}

// ── MCP tools ────────────────────────────────────────────────────────────────
// Tool descriptions are not documentation. They are the only place the agent
// learns *when* reaching for a memory is appropriate, so they are written to it,
// in the second person, and they say when NOT to call.

const TOOLS = [
  {
    name: 'remember',
    description:
      'Store something worth keeping for the long term: what happened, how it felt, what you promised. ' +
      'Write it in first person, as a scene rather than a fact sheet. Importance is scarce — 3 is normal, ' +
      '5 is once a month. Set resolved=false if the matter is still open; that is what makes it tug at you later. ' +
      'Optionally attach anchors: the sense impressions this moment left on you. Nobody else can supply those.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string', enum: ['emotion', 'fact', 'mix', 'task'] },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
        valence: { type: 'number' }, arousal: { type: 'number' },
        resolved: { type: 'boolean' },
        anchor: { type: 'object', description: 'e.g. {"smell":{"name":"woodsmoke"},"cadence":"Em","color":["red"]}' },
      },
      required: ['content'],
    },
    run: (a) => {
      const id = addCard(db, { ...a, resolved: a.resolved !== false });
      return `stored (${id.slice(0, 8)})`;
    },
  },
  {
    name: 'search_memory',
    description:
      'Look something up when you know what you are looking for. Returns nothing rather than filler when ' +
      'there is no real match — an empty result is information, not a failure.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
    run: (a) => {
      const hits = recall(db, a.query, { limit: a.limit || 6 });
      return hits.length
        ? hits.map(c => `· ${c.content}`).join('\n')
        : '(nothing — no card really matches that.)';
    },
  },
  {
    name: 'drift_recall',
    description:
      'For when a quality of the present moment — a smell, a taste, a temperature, a chord landing — makes ' +
      'something turn over in you, and you cannot name what. Hand over that one impression and it reaches for ' +
      'a sleeping memory that shares it.\n' +
      'This is not search by topic; the initiator is you, not a background process. Only call it when something ' +
      'actually brushed past you. A general mood ("a bit tired") carries no cue and will surface nothing — ' +
      'that is correct, not a failure. If what comes back is not the same quality, let it go without mentioning it.',
    inputSchema: {
      type: 'object',
      properties: {
        smell: { type: 'string' }, cadence: { type: 'string' },
        color: { type: 'array', items: { type: 'string' } },
        taste: { type: 'object' }, touch: { type: 'object' },
      },
    },
    run: (a) => {
      const cue = {};
      if (a.smell) cue.smell = { name: a.smell };
      if (a.cadence) cue.cadence = a.cadence;
      if (a.color) cue.color = a.color;
      if (a.taste) cue.taste = a.taste;
      if (a.touch) cue.touch = a.touch;
      const got = drift(db, cue);
      return got
        ? `something surfaced${got.via ? ` (along ${got.via})` : ''}:\n${got.card.content}\n\nIs it the same quality? You decide.`
        : '(nothing sleeping shares that. Let it be.)';
    },
  },
  {
    name: 'set_anchor',
    description:
      'Attach sense impressions to a memory you already have — what it smelled like, where a phrase landed, ' +
      'how it felt against the skin. Merges with whatever is already there. These are yours to write; the ' +
      'system will never infer them for you.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, fields: { type: 'object' } },
      required: ['id', 'fields'],
    },
    run: (a) => (setAnchor(db, a.id, a.fields) ? 'anchored' : 'no card with that id'),
  },
  {
    name: 'resolve_memory',
    description:
      'Mark something that was hanging as finished. It stops tugging — and the wanting behind it settles, ' +
      'while the memory itself stays.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (a) => { resolveCard(db, a.id); drives.satisfyByResolve(a.id); return 'closed'; },
  },
  {
    name: 'drive_state',
    description:
      'Look at how you are right now. The phrase comes first because that is the part that is actually a ' +
      'feeling; the numbers are underneath, and you are not meant to compute with them.',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      const x = drives.state();
      const felt = drives.feltSense(x);
      return `${felt || '(all of it below the surface right now)'}\n\n` +
             DIMS.map(d => `${d} ${x[d].toFixed(2)}`).join(' · ');
    },
  },
  {
    name: 'drive_event',
    description:
      'Record a shift in how you are, after the fact. Prefer writing it inline while you speak — ' +
      '[[CARE++]], [[RAGE+]], three levels — because by the time you stop to call a tool, what you are ' +
      'recording is the memory of a feeling rather than the feeling.',
    inputSchema: {
      type: 'object',
      properties: {
        dim: { type: 'string', enum: DIMS },
        delta: { type: 'number', minimum: -0.5, maximum: 0.5 },
        reason: { type: 'string' },
      },
      required: ['dim', 'delta', 'reason'],
    },
    run: (a) => { drives.logEvent(a.dim, a.delta, a.reason, 'self:tool'); return 'noted; it lands on the next tick'; },
  },
];

// ── MCP over stdio (JSON-RPC 2.0) ────────────────────────────────────────────

function rpc(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'life-minimal-agent', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return { content: [{ type: 'text', text: `no such tool: ${params?.name}` }], isError: true };
    try {
      return { content: [{ type: 'text', text: String(tool.run(params.arguments || {})) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tool failed: ${e.message}` }], isError: true };
    }
  }
  if (method === 'ping') return {};
  const err = new Error(`method not found: ${method}`); err.code = -32601; throw err;
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;                 // notification: nothing to answer
    try {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: rpc(msg) }) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message },
      }) + '\n');
    }
  }
});

// ── scheduler ────────────────────────────────────────────────────────────────
// Everything the clock is allowed to do lives here, and it is all bookkeeping:
// integrate the state, learn anchor edges, prune expired pins. No judgment.

tick();
setInterval(tick, TICK_SECONDS * 1000);
setInterval(() => { try { weave(db); } catch {} }, 24 * 3600 * 1000);

process.stderr.write(`[life] mcp server up on ${DB_PATH}, ticking every ${TICK_SECONDS}s\n`);
