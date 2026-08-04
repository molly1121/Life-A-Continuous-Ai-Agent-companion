// Test bench for the memory subsystem.
//
//   node --experimental-sqlite probe.js
//
// Fully synthetic. Verifies the properties that make this memory rather than a
// database: deliberate search finds by topic; involuntary recall reaches a
// *dormant* card through a sensory cue and refuses to fire on generic ones;
// learned edges spread one hop; decay fades but never deletes; co-retrieval
// wires cards together.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from './schema.js';
import { addCard, setAnchor, resolveCard, openLoops, archive, unarchive, releaseExpiredPins, pin } from './cards.js';
import { recall, drift, decayFactor, TUNING } from './retrieval.js';
import { weave, linkAnchors, richness, tokenize } from './anchors.js';

const DB_PATH = join(tmpdir(), `life-memory-probe-${process.pid}.db`);
rmSync(DB_PATH, { force: true });
const db = openDb(DB_PATH);

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) fails++;
};

const DAY = 86400000;
const now = Date.UTC(2030, 5, 1, 12, 0, 0);
const ago = d => now - d * DAY;

// --- synthetic corpus --------------------------------------------------------
// A dormant, richly anchored card (the one involuntary recall should find):
const blackoutId = addCard(db, {
  content: 'the night the power failed and the whole stairwell smelled of woodsmoke',
  tags: ['weather'], category: 'emotion', importance: 4, arousal: 0.7, valence: -0.2,
  anchor: { smell: { name: 'woodsmoke' }, cadence: 'Em', color: ['red'], scene: 'a dark stairwell' },
  now: ago(120),
});
db.prepare('UPDATE memories SET last_accessed=?, activation_count=0 WHERE id=?').run(ago(120), blackoutId);

// A fresh, shallow card mentioning the same scent (must NOT win the drift):
addCard(db, {
  content: 'a woodsmoke-scented candle in the shop window, nothing special',
  tags: ['errands'], category: 'fact', importance: 2, arousal: 0.2,
  anchor: { smell: { name: 'woodsmoke' } },
  now: ago(1),
});
db.prepare('UPDATE memories SET last_accessed=?, activation_count=6 WHERE content LIKE ?').run(ago(1), '%candle%');

// A card anchored on taste only — reachable through a learned yellow<->sour edge:
const rooftopId = addCard(db, {
  content: 'the cold sour drink on the rooftop after the long climb',
  tags: ['summer'], category: 'emotion', importance: 4, arousal: 0.6, valence: 0.7,
  anchor: { taste: { sour: 0.8 }, touch: { weight: -0.6 } },
  now: ago(90),
});
db.prepare('UPDATE memories SET last_accessed=?, activation_count=1 WHERE id=?').run(ago(90), rooftopId);

// Cards that teach the yellow<->sour edge (co-anchored by the agent itself):
for (let i = 0; i < 2; i++) {
  addCard(db, {
    content: `sliced lemons all afternoon for the stall, hands stinging (${i})`,
    category: 'mix', anchor: { color: ['yellow'], taste: { sour: 0.9 } }, now: ago(60 - i),
  });
}

// Topical cards for deliberate search:
addCard(db, { content: 'fixed the leaking tap under the kitchen sink', tags: ['repair'], category: 'fact', now: ago(10) });
const loopId = addCard(db, { content: 'promised to look into the noisy fan', tags: ['repair'], category: 'mix', resolved: false, importance: 4, now: ago(5) });

// --- 1. deliberate search ----------------------------------------------------
const hits = recall(db, 'leaking tap kitchen', { now });
check('deliberate search finds by topic', hits.some(c => c.content.includes('leaking tap')),
  hits.map(c => c.content.slice(0, 24)).join(' | ') || 'none');

const none = recall(db, 'quantum chromodynamics seminar', { now });
check('no hits returns nothing (no padding)', none.length === 0, `${none.length} returned`);

// --- 2. anchors are searchable through text too ------------------------------
const scent = recall(db, 'woodsmoke', { now });
check('anchor text reaches the card', scent.length > 0, `${scent.length} hits`);

// --- 3. involuntary recall prefers the dormant, rich card --------------------
// Note: the search above *touched* that card, so it is no longer dormant —
// which is correct behaviour (something just recalled has not been lost), and
// exactly why involuntary recall is not a second search. Put it back to sleep.
db.prepare('UPDATE memories SET last_accessed=?, activation_count=0 WHERE id=?').run(ago(120), blackoutId);

const d1 = drift(db, { smell: { name: 'woodsmoke' } }, { now });
check('drift reaches the dormant anchored memory', d1?.card.id === blackoutId,
  d1 ? d1.card.content.slice(0, 40) : 'nothing surfaced');

// --- 4. generic cues stay silent --------------------------------------------
const d2 = drift(db, { touch: { weight: 0.1 } }, { now });
check('generic cue does not fire', d2 === null, d2 ? 'fired' : 'silent');

// --- 5. learned edges, then one-hop spread ----------------------------------
const w = weave(db, now);
check('edges are earned from co-anchoring', w.earned > 0, `earned=${w.earned} scanned=${w.scanned}`);
const edge = db.prepare("SELECT * FROM needle_links WHERE token_a LIKE 'color:yellow' OR token_b LIKE 'color:yellow'").all();
check('yellow <-> sour edge exists', edge.some(e => `${e.token_a}${e.token_b}`.includes('taste:sour')),
  edge.map(e => `${e.token_a}~${e.token_b}`).join(' '));

// A colour-only cue should now be able to reach a taste-anchored card, one hop:
db.prepare('UPDATE memories SET last_accessed=? WHERE id=?').run(ago(90), rooftopId);
const d3 = drift(db, { color: ['yellow'] }, { now });
check('spread reaches a card the cue does not directly touch',
  d3 !== null, d3 ? `${d3.card.content.slice(0, 30)} via ${d3.via || 'direct'}` : 'nothing');

// --- 6. decay fades but never deletes ---------------------------------------
const oldCard = db.prepare('SELECT * FROM memories WHERE id=?').get(blackoutId);
const f = decayFactor(oldCard, now);
check('decay has a floor', f >= TUNING.DECAY_FLOOR && f < 1, `factor=${f.toFixed(3)}`);

// --- 7. co-retrieval wires cards together -----------------------------------
recall(db, 'repair', { now });
recall(db, 'repair', { now });
const link = db.prepare('SELECT weight FROM memory_links ORDER BY weight DESC LIMIT 1').get();
check('co-retrieved cards grow a link', !!link && link.weight > 0.1, link ? `w=${link.weight.toFixed(2)}` : 'none');

// --- 8. open loops feed the drives subsystem --------------------------------
check('open loop is listed', openLoops(db).some(c => c.id === loopId));
resolveCard(db, loopId);
check('resolved loop leaves the list', !openLoops(db).some(c => c.id === loopId));

// --- 9. archive is reversible, pins expire ----------------------------------
archive(db, rooftopId, 'probe');
check('archived card leaves the active set', !db.prepare('SELECT 1 FROM memories WHERE id=?').get(rooftopId));
unarchive(db, rooftopId);
check('archive is reversible', !!db.prepare('SELECT 1 FROM memories WHERE id=?').get(rooftopId));
pin(db, rooftopId, now - 8 * DAY);
check('expired pins are released', releaseExpiredPins(db, 7, now) === 1);

// --- 10. anchors merge rather than overwrite --------------------------------
setAnchor(db, blackoutId, { taste: { bitter: 0.6 } });
const merged = JSON.parse(db.prepare('SELECT anchor FROM memories WHERE id=?').get(blackoutId).anchor);
check('anchor merge keeps the old needles', !!merged.smell?.name && !!merged.taste?.bitter,
  tokenize(merged).join(' '));
check('richness counts private bindings', richness(merged) >= 4, `richness=${richness(merged)}`);

// --- 11. manual edges survive the pruner ------------------------------------
linkAnchors(db, 'cadence:G', 'color:blue', 'declared by the agent', now);
weave(db, now + 400 * DAY);
const manual = db.prepare("SELECT * FROM needle_links WHERE source='manual'").all();
check('manual edges are never auto-pruned', manual.length === 1, `${manual.length} manual edges`);

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) failed.`);
rmSync(DB_PATH, { force: true });
process.exit(fails === 0 ? 0 : 1);
