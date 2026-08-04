# src/memory

A runnable reference implementation of the memory subsystem.
Node ≥ 22 (uses `node:sqlite`), no dependencies.

```bash
node --experimental-sqlite probe.js
```

## Files

| File | Contents |
|---|---|
| `schema.js` | Cards, card links, learned anchor edges, drift audit, archive |
| `cards.js` | Write side: create, merge anchors, resolve, pin (with expiry), archive/unarchive, core facts |
| `anchors.js` | Sensory anchors, tokenization, richness, the learned synesthesia net (`weave`, `spread`, `linkAnchors`) |
| `retrieval.js` | The two paths: `recall()` (deliberate) and `drift()` (involuntary), plus decay, dormancy, co-activation |
| `probe.js` | Test bench, fully synthetic |

## The two paths

```js
import { openDb } from './schema.js';
import { addCard, setAnchor, resolveCard, openLoops } from './cards.js';
import { recall, drift } from './retrieval.js';
import { weave } from './anchors.js';

const db = openDb('./memory.db');

// The agent writes its own cards, and its own anchors.
const id = addCard(db, {
  content: 'the night the power failed and the stairwell smelled of woodsmoke',
  tags: ['weather'], category: 'emotion', importance: 4, arousal: 0.7,
  anchor: { smell: { name: 'woodsmoke' }, cadence: 'Em', color: ['red'] },
});

// Path 1 — deliberate: "I know what I'm looking for."
const hits = recall(db, 'the evening the lights went out');

// Path 2 — involuntary: "something just brushed past me."
const surfaced = drift(db, { smell: { name: 'woodsmoke' } });
// -> at most one candidate; the agent decides if it is the same quality,
//    and whether to say anything at all.

// Nightly: learn anchor edges from the agent's own co-anchoring.
weave(db);
```

## Wiring it into a host

Expose these to the agent as tools — **not** as automatic hooks:

| Tool | Maps to |
|---|---|
| `remember(content, tags, …, anchor?)` | `addCard` |
| `search_memory(query)` | `recall` |
| `set_anchor(id, fields)` | `setAnchor` (merge semantics) |
| `drift_recall(cue)` | `drift` |
| `resolve_memory(id)` | `resolveCard` (also the drives satisfaction hook) |

Scheduler jobs: `weave(db)` nightly; `releaseExpiredPins(db)` daily; dream sampling reads cards and calls `coActivate` on whatever it sewed together.

At wake, inject `coreFacts(db)` — ground truth must never depend on a search hitting.

## Credits

The emotional-coordinate fields (`valence`, `arousal`, and emotion-modulated
decay) descend from [Ombre-Brain](https://github.com/P0luz/Ombre-Brain) by P0luz
(MIT). No code was copied; the field design and the decay idea were. See
[CREDITS.md](../../CREDITS.md).

## Non-negotiables

- **Do not auto-inject retrieval results into every turn.** Retrieval is initiated by the agent; injection turns a subject into a feeding tube.
- **Do not auto-extract anchors from transcripts.** An anchor is how the subject encoded the event. Extracted ones are generic labels with no recall value, and they poison `weave` — the learned edges would become the extractor's associations, not the agent's.
- **Do not add a delete.** Resolve, supersede, archive. All reversible.
- **Keep the ignition gate narrow, not the edge set sparse.** A dense sub-threshold net is safe; what must stay expensive is *surfacing*.
