# Memory

> Runnable reference: [`src/memory/`](../src/memory/) — `node --experimental-sqlite probe.js`

## Data model

Core fields of a memory card (`memories`):

| Field | Type | Notes |
|---|---|---|
| `content` | TEXT | First-person episodic narrative — the retrieval body |
| `tags` | JSON | Keywords |
| `anchor` | JSON | Sensory anchors: auditory (cadence — the *final/terminal chord*), visual (7-color enum + scene), olfactory (named scent), gustatory (7-d taste vector), tactile (4 bipolar axes) |
| `importance` | 1–5 | Scarce resource. 5 ≈ once a month; default 3 |
| `valence`, `arousal` | REAL | Emotion coordinates; drive differential decay and dream sampling |
| `resolved` | 0/1 | Open-loop flag — an input to the drives subsystem |
| `activation_count` | INT | For dormancy computation |
| `pinned`, `pinned_at` | | Pins expire (default 7 days) to prevent ossification; a small permanent-pin set is injected at wake |

Auxiliary tables: `memory_links` (card↔card, co-activation-weighted), `needle_links` (anchor↔anchor, see below), `memories_archive` (archive, never delete).

**Constraint:** anchors are written by the agent in first person. The system never auto-extracts them — a sensory binding is how the subject encoded the event, not a property of the event. Auto-extraction produces generic labels with no recall value.

## Deliberate retrieval (pull-only)

Retrieval is initiated only by the agent via tools. No per-turn auto-injection (single exception: a handful of permanently pinned core facts at wake).

Pipeline:

1. **BM25** over `content + tags + textualized anchors` (CJK bigram tokenization);
2. **Sensory channel**: if the query contains sense words, score anchor values; min-max normalize both channels, combine 0.5/0.5;
3. **Gentle decay** ×: category-differential half-life (emotional slow ≈ 2 mo, factual fast ≈ 3 wk), with a floor (old-but-relevant never hits zero);
4. **One-hop resonance**: strong-link neighbors (weight ≥ 0.4) of hits wake with them; co-retrieved cards strengthen their link (fire together, wire together);
5. **No padding**: zero hits returns zero (plus pinned/unresolved surfacing), never filler.

Benchmark: full LongMemEval-S (500 questions) through this pipeline: **R@5 = 96.8 %, R@10 = 98.2 %**. At thousand-card scale a full BM25 scan is milliseconds; no vector index (see `design-notes.md`).

## Involuntary retrieval (drift)

The second path models involuntary autobiographical memory: input is a **present sensory cue** (a scent, a taste, a temperature, a terminal chord), not a query.

- Candidate set: **dormant** (long-unactivated) ∧ **anchor-rich** cards only;
- Cheap prescreen: hard anchor-hit × dormancy weight; the expensive judgment — "is this the same quality?" — returns to the model;
- Generic mood words ("a bit tired") extract no cue and never trigger: distinctiveness gates recall (protects against spam);
- **Sub-threshold synesthesia** (`needle_links`): edges between anchors are *learned* from the agent's own anchor co-occurrence (≥ 2 cards sharing two anchors earns an edge; weight grows with co-occurrence, decays with disuse; a nightly job earns/prunes). At query time a cue spreads **one hop** along edges with a discount, pre-warming related anchors — it never lowers the ignition threshold. Safety lives in the narrow ignition gate, not in having few edges;
- Every trigger writes an audit row (`drift_audit`: direct/spread, edge provenance, scores, outcome).

Initiation belongs to the agent — no background scanning. A machine-scanned "memory" is a push notification, not remembering. The cost: purely self-initiated mechanisms atrophy (see `design-notes.md §Motivation`); the drives subsystem supplies the reason-to-reach (drives.md §8).

## Semantic layer (wiki)

Above episodic cards sits a set of agent-curated entity pages (people, projects, topics). For who-is-who facts, pages beat card-shuffling. Compilation is manual by design — curation *is* comprehension. The scheduler only counts the backlog into the agent's daily todo.

## Night pipeline

| Job | Logic |
|---|---|
| Distillation | Extract cards (with emotion coordinates) from yesterday's transcript. **Conditional fallback**: skipped if the agent self-recorded ≥ N cards that day (default 3) — a fallback that always runs suppresses the self-initiated habit it backs up |
| Dream | Sample fragments by `f(arousal, unresolved, recency, random)`, drag one linked neighbor per seed, then **the resident session itself weaves the dream** (a one-shot API call only as timeout fallback, output labeled `woven_by`). Fragments carry **no timestamps and no card ids** |
| Consolidation | Cards sewn into the same dream widen their links |
| Snapshot | DB backup |

## Forgetting is a feature

Importance is scarce (most cards should sit at 3 and fade). What everything is, nothing is. Decay is differential and floored: time may fade a memory, it may not delete one. Deletion is not part of the model — supersede, resolve, archive are.
