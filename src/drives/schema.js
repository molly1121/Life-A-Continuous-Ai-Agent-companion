// Drives — schema.
//
// Everything lands in tables, never in logs: an audit trail a power cycle can
// erase is not an audit trail (embedded hosts frequently run volatile journald).
//
// The reference implementation uses node:sqlite (Node >= 22, --experimental-sqlite).
// Any SQLite binding works; note that node:sqlite has no .transaction() helper —
// use explicit BEGIN/COMMIT (see integrator.js).

import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    -- current 9-d state, one row per dimension
    CREATE TABLE IF NOT EXISTS drives (
      dim        TEXT PRIMARY KEY,
      value      REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- trajectory: one JSON snapshot per tick (dashboard curves; pruned to N days)
    CREATE TABLE IF NOT EXISTS drive_trace (
      at    INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drive_trace_at ON drive_trace(at);

    -- u(t) ledger: who moved which dimension, by how much, and why
    --   source: 'clock:*' | 'self:inline' | 'self:tool'
    CREATE TABLE IF NOT EXISTS drive_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      dim     TEXT NOT NULL,
      delta   REAL NOT NULL,
      reason  TEXT NOT NULL,
      source  TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_drive_events_applied ON drive_events(applied);

    -- small kv store (kill switch, push state machine, cursors)
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

// --- Host integration points -------------------------------------------------
// The integrator needs four facts from the host application. Supply them via
// this adapter; the reference probe passes synthetic values.
//
//   lastUserAt()        -> epoch ms of the last user message, or null
//   messagesSince(ms)   -> message count since a timestamp (activity -> fatigue)
//   openLoopWeights()   -> array of importance values of unresolved items
//   sleepMarker()       -> monotonically increasing id of the newest sleep event
//
export const nullHost = {
  lastUserAt: () => null,
  messagesSince: () => 0,
  openLoopWeights: () => [],
  sleepMarker: () => 0,
};
