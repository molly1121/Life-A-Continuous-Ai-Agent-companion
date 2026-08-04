// Memory — the two retrieval paths.
//
//   recall()  deliberate: "I know what I'm looking for"      (BM25 + decay + resonance)
//   drift()   involuntary: "something just brushed past me"  (sensory cue -> dormant cards)
//
// Both are PULL: nothing here runs on its own. There is no per-turn injection
// hook, by design (docs/design-notes.md).

import { parseAnchor, tokenize, senseOf, SENSE_WEIGHT, richness, spread } from './anchors.js';

const DAY = 86400000;

export const TUNING = {
  // deliberate
  BM25_K1: 1.4,
  BM25_B: 0.75,
  SENSORY_MIX: 0.5,            // BM25 vs sensory channel, after min-max normalization
  DECAY_FLOOR: 0.4,            // time may fade a memory; it may not delete one
  HALF_LIFE_DAYS: { emotion: 60, mix: 40, fact: 21 },
  RESONANCE_MIN_WEIGHT: 0.4,   // strong links wake with their hit
  ACTIVATION_EXP: 0.3,         // diminishing returns: frequent cards must not ossify

  // involuntary
  DORMANT_DAYS: 10,            // "asleep" = not recalled for this long
  MIN_RICHNESS: 2,             // cards too thin to be picked out are not candidates
  SPREAD_DISCOUNT: 0.7,        // a spread hit is always worth less than a direct one
  DRIFT_MIN_SCORE: 0.35,       // narrow ignition gate — safety lives here, not in fewer edges
};

// --- tokenization (CJK-aware bigrams + latin words) --------------------------

export function tokensOf(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(/[a-z0-9]+/g)) out.push(m[0]);
  const cjk = s.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length; i++) {
    out.push(cjk[i]);
    if (i + 1 < cjk.length) out.push(cjk.slice(i, i + 2));   // bigram
  }
  return out;
}

// The searchable document of a card = narrative + keywords + textualized anchors,
// so that a query like "woodsmoke" or "Cmaj7" reaches cards anchored that way.
function docOf(card) {
  const a = parseAnchor(card);
  const anchorText = a
    ? [a.scene, a.smell?.name, a.smell?.klass, a.cadence, ...(a.color || []),
       ...Object.keys(a.taste || {}), ...Object.keys(a.touch || {})].filter(Boolean).join(' ')
    : '';
  let tags = [];
  try { tags = JSON.parse(card.tags || '[]'); } catch {}
  return `${card.content} ${tags.join(' ')} ${anchorText}`;
}

// --- decay -------------------------------------------------------------------

export function decayFactor(card, now) {
  const ageDays = (now - card.created_at) / DAY;
  const hl = TUNING.HALF_LIFE_DAYS[card.category] ?? TUNING.HALF_LIFE_DAYS.mix;
  const intensity = 1 + (card.arousal || 0) + Math.abs(card.valence || 0);   // vivid fades slower
  const raw = Math.pow(0.5, ageDays / (hl * intensity));
  return TUNING.DECAY_FLOOR + (1 - TUNING.DECAY_FLOOR) * raw;
}

export function dormancy(card, now) {
  const days = (now - (card.last_accessed || card.created_at)) / DAY;
  const rarity = 1 / (1 + (card.activation_count || 0));
  return Math.min(1, (days / TUNING.DORMANT_DAYS) * rarity);
}

// --- deliberate recall -------------------------------------------------------

/**
 * @returns {Array} scored cards, best first. Zero hits returns [] — never padding.
 */
export function recall(db, query, { limit = 6, now = Date.now() } = {}) {
  const cards = db.prepare('SELECT * FROM memories').all();
  if (!cards.length) return [];

  const qTokens = tokensOf(query);
  const docs = cards.map(docOf);
  const docTokens = docs.map(tokensOf);
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / docTokens.length || 1;

  // document frequency for BM25 idf
  const df = new Map();
  docTokens.forEach(toks => {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  });

  const bm25 = docTokens.map(toks => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const q of new Set(qTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (cards.length - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      s += idf * (f * (TUNING.BM25_K1 + 1)) /
           (f + TUNING.BM25_K1 * (1 - TUNING.BM25_B + TUNING.BM25_B * toks.length / avgLen));
    }
    return s;
  });

  // sensory channel: only scores when the query itself carries sense words
  const qAnchorTokens = qTokens.filter(t => t.length >= 1);
  const sensory = cards.map(c => {
    const toks = tokenize(parseAnchor(c));
    if (!toks.length) return 0;
    let s = 0;
    for (const t of toks) {
      const value = t.split(':')[1] || '';
      if (qAnchorTokens.some(q => value.includes(q) || q.includes(value))) {
        s += SENSE_WEIGHT[senseOf(t)] || 1;
      }
    }
    return s;
  });

  const norm = arr => {
    const max = Math.max(...arr, 0);
    return max > 0 ? arr.map(v => v / max) : arr.map(() => 0);
  };
  const nb = norm(bm25), ns = norm(sensory);

  const scored = cards.map((c, i) => {
    const base = TUNING.SENSORY_MIX * ns[i] + (1 - TUNING.SENSORY_MIX) * nb[i];
    const activation = Math.pow(1 + (c.activation_count || 0), TUNING.ACTIVATION_EXP);
    return { card: c, score: base * decayFactor(c, now) * activation, hit: nb[i] > 0 || ns[i] > 0 };
  }).filter(r => r.hit).sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, limit).map(r => r.card);

  // one-hop resonance: strong-link neighbours wake with their hit
  const ids = new Set(picked.map(c => c.id));
  for (const c of [...picked]) {
    const rows = db.prepare(
      'SELECT a, b, weight FROM memory_links WHERE (a=? OR b=?) AND weight>=?'
    ).all(c.id, c.id, TUNING.RESONANCE_MIN_WEIGHT);
    for (const r of rows) {
      const otherId = r.a === c.id ? r.b : r.a;
      if (ids.has(otherId)) continue;
      const other = db.prepare('SELECT * FROM memories WHERE id=?').get(otherId);
      if (other) { picked.push(other); ids.add(otherId); }
    }
  }

  noteAccess(db, picked, now);
  coActivate(db, picked.map(c => c.id), now);   // fire together, wire together
  return picked;
}

// --- involuntary recall (drift) ---------------------------------------------

/**
 * @param cue  {cadence?, color?[], smell?, taste?, touch?, scene?}
 * @returns    at most one candidate — the agent decides whether it is the same
 *             quality, and whether to voice it at all.
 */
export function drift(db, cue, { now = Date.now(), dormantDays = TUNING.DORMANT_DAYS } = {}) {
  const cueTokens = tokenize(cue);
  if (!cueTokens.length) return null;              // generic mood words yield no cue: stay quiet

  const pre = spread(db, cueTokens);               // sub-threshold pre-warming, one hop
  const cards = db.prepare('SELECT * FROM memories').all();

  let best = null;
  for (const c of cards) {
    const anchor = parseAnchor(c);
    if (!anchor) continue;
    if (richness(anchor) < TUNING.MIN_RICHNESS) continue;
    const dorm = dormancy({ ...c, }, now);
    if (dorm <= 0 || (now - (c.last_accessed || c.created_at)) / DAY < dormantDays) continue;

    const toks = tokenize(anchor);
    let overlap = 0, spreadScore = 0, via = null;
    for (const t of toks) {
      if (cueTokens.includes(t)) overlap += SENSE_WEIGHT[senseOf(t)] || 1;
      else {
        const warm = pre.find(p => p.token === t);
        if (warm) {
          spreadScore += (SENSE_WEIGHT[senseOf(t)] || 1) * warm.w * TUNING.SPREAD_DISCOUNT;
          via = via || warm.via;
        }
      }
    }
    if (overlap === 0 && spreadScore === 0) continue;

    const score = (overlap + spreadScore) * (0.5 + 0.5 * dorm);
    if (!best || score > best.score) {
      best = { card: c, score, overlap, spread: spreadScore, via, dormancy: dorm };
    }
  }

  if (!best || best.score < TUNING.DRIFT_MIN_SCORE) return null;   // narrow ignition gate

  db.prepare(`INSERT INTO drift_audit (at, card_id, via, overlap, spread, score)
              VALUES (?,?,?,?,?,?)`)
    .run(now, best.card.id, best.overlap > 0 ? 'direct' : 'spread',
         best.overlap, best.spread, best.score);
  noteAccess(db, [best.card], now);
  return best;
}

// --- bookkeeping -------------------------------------------------------------

export function noteAccess(db, cards, now = Date.now()) {
  const up = db.prepare('UPDATE memories SET activation_count = activation_count + 1, last_accessed = ? WHERE id = ?');
  for (const c of cards) up.run(now, c.id);
}

/** Cards recalled together grow a link between them. */
export function coActivate(db, ids, now = Date.now(), step = 0.05) {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]].sort();
      db.prepare(`INSERT INTO memory_links (a, b, weight, last_coactivated) VALUES (?,?,?,?)
                  ON CONFLICT(a, b) DO UPDATE SET weight = min(1.0, weight + ?), last_coactivated = ?`)
        .run(a, b, 0.1, now, step, now);
    }
  }
}
