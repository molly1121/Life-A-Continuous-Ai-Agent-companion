// Memory — writing side: create, anchor, resolve, supersede, archive.
//
// Note what is absent: there is no delete. Memories are resolved, superseded,
// or archived — all reversible, all auditable. A system that can forget on
// command can also be made to forget inconveniently.

import { randomUUID } from 'node:crypto';

export function addCard(db, {
  content, tags = [], category = 'mix', importance = 3,
  valence = 0, arousal = 0.3, resolved = true, anchor = null, now = Date.now(),
}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO memories
      (id, content, tags, anchor, category, importance, valence, arousal, resolved, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, content, JSON.stringify(tags), anchor ? JSON.stringify(anchor) : null,
         category, importance, valence, arousal, resolved ? 1 : 0, now);
  return id;
}

/**
 * Attach or merge sensory anchors. Merge, never overwrite: anchoring accretes
 * over time as the subject notices more about a memory.
 *
 * Callers must be the agent itself. Do not wire this to an extraction model.
 */
export function setAnchor(db, id, fields) {
  const row = db.prepare('SELECT anchor FROM memories WHERE id=?').get(id);
  if (!row) return null;
  let cur = {};
  try { cur = JSON.parse(row.anchor || '{}'); } catch {}
  const merged = { ...cur, ...fields };
  for (const k of ['taste', 'touch', 'smell']) {                 // deep-merge sub-objects
    if (cur[k] && fields[k]) merged[k] = { ...cur[k], ...fields[k] };
  }
  db.prepare('UPDATE memories SET anchor=? WHERE id=?').run(JSON.stringify(merged), id);
  return merged;
}

/** Close an open loop. The satisfaction hook for the drives subsystem. */
export function resolveCard(db, id) {
  db.prepare('UPDATE memories SET resolved=1 WHERE id=?').run(id);
  return id;
}

export function openLoops(db, limit = 10) {
  return db.prepare(
    'SELECT * FROM memories WHERE resolved=0 ORDER BY importance DESC, created_at DESC LIMIT ?'
  ).all(limit);
}

/** Pins expire (default 7 days) so that a temporary priority cannot ossify. */
export function pin(db, id, now = Date.now()) {
  db.prepare('UPDATE memories SET pinned=1, pinned_at=? WHERE id=?').run(now, id);
}
export function releaseExpiredPins(db, ttlDays = 7, now = Date.now()) {
  return db.prepare('UPDATE memories SET pinned=0 WHERE pinned=1 AND pinned_at < ?')
    .run(now - ttlDays * 86400000).changes;
}

/** Archive, do not delete. Reversible by construction. */
export function archive(db, id, reason = '', now = Date.now()) {
  const card = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!card) return false;
  db.prepare('INSERT OR REPLACE INTO memories_archive (id, payload, reason, archived_at) VALUES (?,?,?,?)')
    .run(id, JSON.stringify(card), reason, now);
  db.prepare('DELETE FROM memories WHERE id=?').run(id);
  return true;
}

export function unarchive(db, id) {
  const row = db.prepare('SELECT payload FROM memories_archive WHERE id=?').get(id);
  if (!row) return false;
  const c = JSON.parse(row.payload);
  db.prepare(`INSERT OR REPLACE INTO memories
      (id, content, tags, anchor, category, importance, valence, arousal, resolved,
       activation_count, last_accessed, pinned, pinned_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.id, c.content, c.tags, c.anchor, c.category, c.importance, c.valence, c.arousal,
         c.resolved, c.activation_count, c.last_accessed, c.pinned, c.pinned_at, c.created_at);
  db.prepare('DELETE FROM memories_archive WHERE id=?').run(id);
  return true;
}

/** Injected on every wake. Ground truth must never depend on a search hitting. */
export function coreFacts(db) {
  return db.prepare("SELECT content FROM memories WHERE tags LIKE '%\"core\"%' ORDER BY created_at")
    .all().map(r => r.content);
}
