// Inline emotion markers: [[DIM+]] / [[DIM++]] / [[DIM+++]] (and minus).
//
// Scoring through a tool call means stopping mid-utterance, which means what
// gets recorded is the *remembered* emotion — and it happens rarely. Markers are
// written in the same breath as the sentence they belong to, cost nothing, and
// therefore actually get used.
//
// Run every agent-authored text through this before persisting or sending:
// the ledger keeps the score, the reader never sees the markup.

import { INLINE } from './config.js';

const DIM_RE_SRC =
  '\\[\\[(SEEKING|CARE|PLAY|LUST|FEAR|RAGE|PANIC|fatigue|stress)(\\+{1,3}|-{1,3})\\]\\]';

// The surrounding sentence becomes the ledger's `reason` for free.
function snippetAround(text, idx) {
  const start = Math.max(0, idx - 24);
  const raw = (text.slice(start, idx) + text.slice(idx, idx + 60))
    .replace(new RegExp(DIM_RE_SRC, 'g'), '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 40) || '(marked in passing)';
}

/**
 * Parse, ledger, and strip inline markers.
 * @param {string} text     agent-authored text
 * @param {object} drives   instance from createDrives()
 * @param {string} channel  where this text came from (chat / heartbeat / dream / diary)
 * @returns {string} text with markers removed
 */
export function scanInlineMarkers(text, drives, channel = '') {
  if (!text || !text.includes('[[')) return text;

  // A global regex's lastIndex is shared mutable state: calling replace() with
  // the same instance inside an exec loop rewinds the cursor and spins forever.
  // Materialize the matches first, then strip with a separate instance.
  const matches = [...text.matchAll(new RegExp(DIM_RE_SRC, 'g'))];

  for (const m of matches) {
    const sign = m[2][0] === '+' ? 1 : -1;
    const level = m[2].length;                       // 1 | 2 | 3
    const delta = sign * (INLINE.STEPS[level] ?? INLINE.STEPS[1]);
    const reason = `[[${m[1]}${m[2]}]] ${snippetAround(text, m.index)}${channel ? ` (${channel})` : ''}`;
    try { drives.logEvent(m[1], delta, reason, 'self:inline'); }
    catch (err) { console.error('[drives] inline ledger write failed:', err.message); }
  }

  // Other inline protocols ([[voice]], [[image:...]], ...) are untouched:
  // the pattern only matches the nine dimension names.
  return text.replace(new RegExp(DIM_RE_SRC, 'g'), '').replace(/ {2,}/g, ' ');
}
