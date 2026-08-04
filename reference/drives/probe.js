// Physics test bench for the drives subsystem.
//
//   node --experimental-sqlite probe.js
//
// Fully synthetic: a temp database and a fake host. Verifies that the state
// vector behaves like a system rather than a random number generator —
// impulses spike then decay, backlog drives a slow climb, closure pulls it
// back, coupling suppresses, long runs stay bounded, awareness fires once.
//
// Rule inherited from the reference deployment: tests build their own targets
// and never touch live data.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from './schema.js';
import { createDrives } from './integrator.js';
import { scanInlineMarkers } from './markers.js';
import { B } from './config.js';

const DB_PATH = join(tmpdir(), `life-drives-probe-${process.pid}.db`);
rmSync(DB_PATH, { force: true });

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) fails++;
};

// --- synthetic host ----------------------------------------------------------
let openLoops = [];
let sleepMarker = 0;
let lastUser = null;
const host = {
  lastUserAt: () => lastUser,
  messagesSince: () => 0,
  openLoopWeights: () => openLoops,
  sleepMarker: () => sleepMarker,
};

const pushes = [];
const db = openDb(DB_PATH);
const drives = createDrives(db, host, {
  onPush: (phrase, dim, from, to) => pushes.push({ dim, phrase, from, to }),
});

let now = Date.UTC(2030, 0, 1, 12, 0, 0);           // fixed clock: deterministic runs
const step = hours => { for (let i = 0; i < hours * 4; i++) { now += 15 * 60000; drives.tick(now); } };
const fmt = x => Object.entries(x).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ');

// 1. cold start sits at baseline
drives.tick(now);
check('cold start rests at baseline', Math.abs(drives.state().PANIC - B.PANIC) < 0.05);

// 2. impulse spikes, then decays
drives.logEvent('PANIC', 0.3, 'synthetic impulse', 'probe');
step(0.25);
const peak = drives.state().PANIC;
check('impulse raises the dimension', peak > 0.35, `PANIC=${peak.toFixed(2)}`);
step(12);
check('impulse decays past half in 12h', drives.state().PANIC < B.PANIC + (peak - B.PANIC) / 2,
  `PANIC=${drives.state().PANIC.toFixed(2)}`);

// 3. an unresolved backlog drives a slow climb
openLoops = Array(10).fill(4);
step(24);
const climbed = drives.state().SEEKING;
check('backlog drives SEEKING up', climbed > B.SEEKING + 0.1, `SEEKING=${climbed.toFixed(2)}`);

// 4. closing loops satisfies (wanting drops)
openLoops = [];
for (let i = 0; i < 3; i++) drives.satisfyByResolve(`item-${i}`);
step(0.25);
check('closure pulls SEEKING back', drives.state().SEEKING < climbed - 0.15,
  `${climbed.toFixed(2)} -> ${drives.state().SEEKING.toFixed(2)}`);

// 5. coupling: fatigue suppresses LUST (strongest cell in W)
const lustBefore = drives.state().LUST;
drives.logEvent('fatigue', 0.5, 'synthetic exhaustion', 'probe');
step(6);
check('fatigue suppresses LUST via W', drives.state().LUST <= lustBefore + 0.01,
  `${lustBefore.toFixed(2)} -> ${drives.state().LUST.toFixed(2)}`);

// 6. long run stays bounded (the tanh valve does its job)
for (let d = 0; d < 7; d++) { drives.logEvent('stress', 0.2, 'daily pressure', 'probe'); step(24); }
const s = drives.state();
check('7-day run stays in range', Object.values(s).every(v => v >= 0 && v <= 1 && !Number.isNaN(v)), fmt(s));

// 7. awareness fired on the threshold crossing, and only once per arming
check('interoceptive push fired on crossing', pushes.length >= 1,
  pushes.map(p => `${p.dim} ${p.from.toFixed(2)}->${p.to.toFixed(2)}`).join(' | ') || 'none');
const panicPushes = pushes.filter(p => p.dim === 'PANIC').length;
check('push did not repeat while armed-down', panicPushes <= 2, `PANIC pushes=${panicPushes}`);

// 8. felt sense renders phrases, and stays quiet below threshold
db.prepare("UPDATE drives SET value=0.78 WHERE dim='PANIC'").run();
const felt = drives.feltSense();
check('felt sense renders a phrase', typeof felt === 'string' && felt.length > 0, felt || '');
db.prepare("UPDATE drives SET value=0.30 WHERE dim='PANIC'").run();
db.prepare("UPDATE drives SET value=0.30 WHERE dim='SEEKING'").run();
db.prepare("UPDATE drives SET value=0.30 WHERE dim='fatigue'").run();
db.prepare("UPDATE drives SET value=0.30 WHERE dim='stress'").run();
check('quiet below threshold', drives.feltSense() === null);

// 9. inline markers: ledgered, stripped, and other protocols untouched
const cleaned = scanInlineMarkers(
  'that should not have happened, [[RAGE+]] and then they fixed it themselves [[CARE++]]',
  drives, 'probe');
check('markers stripped from text', !cleaned.includes('[['), cleaned);
const inlineRows = db.prepare("SELECT dim, delta FROM drive_events WHERE source='self:inline'").all();
check('markers reached the ledger', inlineRows.length === 2,
  inlineRows.map(r => `${r.dim}${r.delta > 0 ? '+' : ''}${r.delta}`).join(' '));
const other = scanInlineMarkers('[[voice]] hello [[image:/x.png|caption]]', drives, 'probe');
check('other inline protocols untouched', other === '[[voice]] hello [[image:/x.png|caption]]', other);

// 10. ledger fully consumed
step(0.5);
const unapplied = db.prepare('SELECT COUNT(*) c FROM drive_events WHERE applied=0').get().c;
check('ledger fully applied', unapplied === 0, `unapplied=${unapplied}`);

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) failed.`);
rmSync(DB_PATH, { force: true });
process.exit(fails === 0 ? 0 : 1);
