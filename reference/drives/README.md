# reference/drives

A runnable, dependency-free reference implementation of the drives subsystem.
Node ≥ 22 (uses `node:sqlite`), no npm install.

```bash
node --experimental-sqlite probe.js
```

## Files

| File | Contents |
|---|---|
| `config.js` | **The personality table.** A, b, W (with why-comments), clock slopes, marker levels, push thresholds, felt-sense phrases |
| `schema.js` | Three tables (state / trajectory / ledger) + the four host integration points |
| `integrator.js` | Euler tick, ledger consumption, clock inputs, felt-sense rendering, interoceptive push state machine |
| `markers.js` | Inline `[[DIM+]]` parsing → ledger → strip |
| `probe.js` | Physics test bench, fully synthetic |

## Wiring it into a host

```js
import { openDb } from './schema.js';
import { createDrives } from './integrator.js';
import { scanInlineMarkers } from './markers.js';

const db = openDb('./state.db');

const drives = createDrives(db, {
  lastUserAt:      () => /* epoch ms of last user message, or null */,
  messagesSince:   ts => /* message count since ts */,
  openLoopWeights: () => /* importance values of unresolved items */,
  sleepMarker:     () => /* monotonic id of newest sleep event */,
}, {
  onPush: phrase => residentSession.send(`[system·interoception] ${phrase}`),
});

setInterval(() => drives.tick(), 15 * 60 * 1000);        // the heartbeat of the state

// every agent-authored text, before persisting or sending:
const clean = scanInlineMarkers(rawText, drives, 'chat');

// expose to the agent as tools:
//   drive_event(dim, delta, reason) -> drives.logEvent(dim, delta, reason, 'self:tool')
//   drive_state()                   -> drives.feltSense() first, numbers after
// expose to the maintainer as an endpoint:
//   GET /drives -> drives.dashboard()
```

## Adapting it

- **Tune, don't fork**: A/b/W/thresholds are data. Add a coupling cell by adding one row to `W` with a why-comment; nothing else changes.
- **Felt-sense phrases belong to the agent.** Ship the draft, then let it rewrite them. A phrase that does not sound like the agent cannot function as a felt sense.
- **Kill switch**: `INSERT INTO app_settings (key,value) VALUES ('drives_off','1')` — the tick returns immediately and rendering goes silent; the ledger still records, so nothing is lost while off.
- **Do not add an emotion classifier** that scores the agent's text. See `docs/design-notes.md`.
