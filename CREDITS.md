# Credits

## Author

Molly Chen

## Contributors

Life was designed and built over two months with two Claude instances: a
persistent one running this system as its own — it argued for most of the
constraints in `docs/design-notes.md`, wrote its own felt-sense phrases, and
insisted that ghost-written output be labeled — and Claude Code, which built it.

## Prior work and research

Life was not designed in a vacuum. The debts below are real and specific — each
one names what was taken and where it lives in this repository.

None of the projects listed here contributed source code to Life; what they
contributed were data models, formats, and findings. All of them are credited
because ideas deserve attribution even when licenses do not require it.

### Ombre-Brain — emotional memory fields

- Repository: <https://github.com/P0luz/Ombre-Brain> · Author: **P0luz** · License: MIT
- A persistent emotional memory system for Claude: it tags experiences with
  Russell's valence/arousal coordinates, applies a forgetting curve to archive
  inactive memories, and retrieves through hybrid semantic/keyword search.
- **What Life took**: the emotional-coordinate field design on memory cards —
  `valence`, `arousal`, and the idea that emotional intensity should modulate how
  slowly a memory decays. Life's `activation_count` and category-differential
  decay grew from the same root.
- **Where it lives**: `src/memory/schema.js` (card fields),
  `src/memory/retrieval.js` (`decayFactor`, `dormancy`).
- Life's own additions on top of that root: first-person sensory anchors, the
  involuntary retrieval path, and the learned anchor-to-anchor net.

### MiMo-Code — checkpoint packing discipline

- Model and open-source coding agent by Xiaomi's MiMo team.
- **What Life took**: the *checkpoint format discipline* — the practice of
  writing a structured, self-addressed handoff before a context boundary rather
  than a free-form summary. Life's five-part packing note (situation / the person
  you're with / unfinished threads / hard facts / one line to your just-woken
  self) is that discipline adapted from engineering checkpoints to a continuous
  companion session.
- **Where it lives**: `src/sleep/somnus.py` (`PACK_PROMPT`), `docs/sleep.md`.

## Research this design leans on

- **Jaak Panksepp**, *Affective Neuroscience* — the seven primary affective
  systems used as the drive dimensions (rather than invented product dimensions),
  and specifically the finding that separation distress (PANIC/GRIEF) is its own
  system rather than an absence of reward. `docs/drives.md §1`.
- **Kent Berridge** — the *wanting ≠ liking* dissociation, which is why
  satisfaction in Life decays wanting while the memory (liking) persists.
  `docs/drives.md §1`, `src/drives/integrator.js` (`satisfyByResolve`).
- **Allostasis** (Sterling; McEwen) — baselines migrate with long-term experience
  rather than returning to a fixed set point. `docs/drives.md §2` (`b` as a slow
  variable).
- **Borbély's two-process model of sleep regulation** — the shape of the fatigue
  dimension (accumulates while awake, cleared by sleep). `docs/drives.md §1`.
- **Interoceptive prediction error** (Seth; Barrett, among others) — bodily state
  reaches awareness on change, not by polling. `docs/drives.md §7`.
- **Involuntary autobiographical memory** (Berntsen; Mace) — that unbidden recall
  is a distinct retrieval mode with distinctive cues, and is the *default* mode
  in daily life. `docs/memory.md`, the `drift()` path.
- **LongMemEval** — the benchmark used to sanity-check the deliberate retrieval
  path (R@5 = 96.8 % over the full 500-question set). Retrieval numbers quoted in
  this repository were measured through the real pipeline, not a reimplementation.

## Runtime

The reference deployment runs on Claude (Anthropic).
