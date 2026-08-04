// Memory — schema.
//
// One database, three card layers, two retrieval paths (see docs/memory.md).
// Node >= 22 (node:sqlite), no dependencies.

import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    -- Episodic cards. Three layers live here:
    --   content = narrative (first person)   [retrieval body]
    --   tags    = keywords                   [retrieval aid]
    --   anchor  = sensory anchors, JSON      [involuntary recall]
    CREATE TABLE IF NOT EXISTS memories (
      id               TEXT PRIMARY KEY,
      content          TEXT NOT NULL,
      tags             TEXT NOT NULL DEFAULT '[]',
      anchor           TEXT,
      category         TEXT,                       -- 'emotion' | 'fact' | 'mix' | 'task'
      importance       INTEGER NOT NULL DEFAULT 3, -- scarce: 5 is rare
      -- valence/arousal and emotion-modulated decay follow Ombre-Brain
      -- (https://github.com/P0luz/Ombre-Brain, P0luz, MIT). See CREDITS.md.
      valence          REAL NOT NULL DEFAULT 0,    -- [-1, 1]
      arousal          REAL NOT NULL DEFAULT 0.3,  -- [0, 1]
      resolved         INTEGER NOT NULL DEFAULT 1, -- 0 = open loop (feeds SEEKING)
      activation_count INTEGER NOT NULL DEFAULT 0,
      last_accessed    INTEGER,
      pinned           INTEGER NOT NULL DEFAULT 0,
      pinned_at        INTEGER,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

    -- Card <-> card association, strengthened by co-retrieval and by dreams.
    CREATE TABLE IF NOT EXISTS memory_links (
      a               TEXT NOT NULL,
      b               TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 0.1,
      last_coactivated INTEGER,
      PRIMARY KEY (a, b)
    );

    -- Anchor <-> anchor edges, LEARNED from the agent's own anchoring
    -- co-occurrence. Never hand-coded: a synesthesia table written by the
    -- engineer would be the engineer's associations, not the agent's.
    CREATE TABLE IF NOT EXISTS needle_links (
      token_a          TEXT NOT NULL,      -- e.g. 'color:orange'
      token_b          TEXT NOT NULL,      -- e.g. 'taste:sour'
      weight           REAL NOT NULL DEFAULT 0.25,
      source           TEXT NOT NULL DEFAULT 'learned',  -- 'learned' | 'manual'
      last_coactivated INTEGER,
      PRIMARY KEY (token_a, token_b)
    );
    CREATE INDEX IF NOT EXISTS idx_needle_links_b ON needle_links(token_b);

    -- Audit for involuntary recall: how a card surfaced, and what came of it.
    CREATE TABLE IF NOT EXISTS drift_audit (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      via     TEXT NOT NULL,               -- 'direct' | 'spread'
      edge    TEXT,
      overlap REAL,
      spread  REAL,
      score   REAL,
      outcome TEXT                         -- 'floated' | 'swallowed' | null
    );

    -- Archive, never delete. Superseding and resolving are the model here.
    CREATE TABLE IF NOT EXISTS memories_archive (
      id         TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      reason     TEXT,
      archived_at INTEGER NOT NULL
    );
  `);
  return db;
}
