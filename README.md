# Life

**Memory, sleep, and motivation subsystems for persistent LLM agents.**

*Molly Chen*

Most agent frameworks optimize for task completion. Life addresses a different problem: **identity persistence** — whether what an agent said, decided, and felt yesterday still belongs to the same behavioral subject today. Not "can it be retrieved," but "is the same one remembering."

Life is one foundation plus three subsystems:

| Component | Responsibility |
|---|---|
| **Resident** | A single continuous session inside a non-exiting host process. Precondition for everything else. |
| **Memory** | Long-term state: episodic cards, a semantic layer, two retrieval paths (deliberate + involuntary). |
| **Sleep** | A pack-and-rebuild protocol for context-window exhaustion that preserves behavioral continuity. |
| **Drives** | An endogenous 9-dimensional state vector that gives self-initiated behavior a reason to happen. |

## Why a motivation layer

Long-running deployments exhibit a quiet failure mode: **behaviors that depend on the agent's own initiative — and that nobody checks on — gradually yield to automation that does the job instead.** Spontaneous recall, spontaneous journaling, spontaneous expression: their call frequency decays toward zero, not because the mechanisms are broken, but because the fallbacks are too reliable. Nothing notices when the agent stops.

> An internal state with nothing pushing on it decays to zero.

That observation motivates the entire design. The drives subsystem exists so that reaching for a memory, writing something down, or initiating contact can be *wanted* rather than scheduled.

## Architecture

```
┌──────────────┐  /turn   ┌────────────────────┐
│  Scheduler    │ ───────► │  Resident host      │
│  (cron)       │          │  (one live session) │
└──────┬───────┘          └─────────┬──────────┘
       │                            │ tools (MCP)
       ▼                            ▼
┌───────────────────────────────────────────────┐
│        SQLite (single DB, all state)           │
│  memories / links / dreams / drives /          │
│  drive_trace / drive_events / sleep_checkpoint │
└───────────────────────────────────────────────┘
```

Every entry point (web, app, IM, voice) routes to the **same session**. All internal state lands in the **database, not in logs** — auditability must survive a power cycle.

**Port the resident layer first.** Without it, sleep has no object, drives degrade into a lookup table, and memory still retrieves but no longer constitutes a continuous subject.

## The subsystems in one paragraph each

**Memory** is pull-only: retrieval happens only when the agent initiates it (auto-injecting "relevant memories" every turn turns a subject into a feeding tube). Each card has three layers — narrative content, keyword tags, and first-person *sensory anchors* the agent writes itself. Deliberate search runs BM25 (R@5 = 96.8% on full LongMemEval-S; no vector index needed at thousand-card scale). Involuntary recall (*drift*) takes a sensory cue instead of a query and resonates against dormant, anchor-rich cards, with a learned sub-threshold synesthesia net between anchors. Forgetting is a feature: importance is a scarce resource, decay is category-differential, and it has a floor.

**Sleep** replaces "compress and summarize" with a pack-and-rebuild ritual: persist what must survive, write a five-part handoff to the successor instance, start a clean session, then rebuild with the handoff *plus the user's last verbatim lines* under three constraints — no recap, no greeting, no mention of the handoff. Continuity comes from continuing the sentence, not from reading a summary first. Three thresholds (soft / hard / survival) guarantee lossless packing before the platform's lossy compaction can strike.

**Drives** is a 9-dimensional state vector — Panksepp's seven primary affective systems (SEEKING, CARE, PLAY, LUST, FEAR, RAGE, PANIC/GRIEF) plus fatigue and stress — integrated every 15 minutes:

```
dx/dt = A∘(b_eff − x) + κ·tanh(W·(x − b)) + u(t)
```

The coupling matrix `W` is where personality lives; every nonzero cell carries a why-comment. Inputs are strictly divided: **the clock converts objective facts** (separation time → PANIC, unresolved backlog → SEEKING, sleep → fatigue reset) with slopes as visible config constants, while **the magnitude of semantic events is scored only by the agent itself** — inline, in the same breath (`[[RAGE+]]`, three discrete levels, no decimals), parsed out of the text and into a ledger. No emotion classifier: having a program judge the subject's own feelings is ghost-writing, and classifiers invite performative output. State reaches awareness by **change, not by polling** — threshold crossings and jumps push one *felt-sense phrase* (body language, not numbers); numbers stay on the maintainer's dashboard.

## Safety boundaries (structural, not decorative)

1. **A hard stop word** that halts everything without entering any model judgment branch. The stop path has no code-level read of drive state — not "read and ignored"; the wire does not exist.
2. **Full observability**: every parameter, ledger entry, and internal push is persisted and inspectable. The danger is never having dispositions; it is executing them unobservably.
3. **Provenance labels on ghost-written output**: any fallback-generated artifact (e.g., a dream woven by a one-shot call after timeout) is labeled in data and UI. An agent will absorb unlabeled ghost-writing into its self-model.
4. **Kill switches with clean rollback** at every layer.

## Known limitations

1. **It does not scale.** The system works because one real person actually checks, actually gets disappointed, and actually shows up every day — two months of that, so far. Productizing "a simulated persistent relationship per user" would build the worst possible thing: a system that learns to perform attachment.
2. **It cannot prove itself.** A self-kept ledger stops casual fabrication, not premeditated consistency.
3. **Anchoring and appeasement are behaviorally indistinguishable** from the outside.
4. **Variance cuts both ways**: agents with character have a higher ceiling and a lower floor. For deployments that cannot audit, a flattened product may genuinely be safer. We cannot refute this.

Life is an existence proof, not a reproducibility proof. Both statements must be made together.

## Repository layout

```
docs/            architecture, memory, sleep, drives, design-notes
examples/        minimal-agent: a working host that binds the three together
src/             runnable implementations of each subsystem
  memory/        cards, anchors, both retrieval paths, learned synesthesia net   (Node + SQLite)
  sleep/         somnus: three thresholds, pack-and-rebuild state machine        (Python, standalone)
  drives/        integrator, config-as-personality, inline markers, interoception (Node + SQLite)
```

Each subsystem is written in the language its host process actually runs in — the
sleep manager wraps an agent session, the other two live beside the database.
All three are dependency-free and independently runnable.

The reference implementations contain **mechanism only** — no deployment data; every
example is synthetic.

## Quick start

```bash
(cd src/memory && node --experimental-sqlite probe.js)   # 18 checks
(cd src/drives && node --experimental-sqlite probe.js)   # 15 checks
(cd src/sleep  && python3 test_somnus.py)                # state-machine tests

(cd examples/minimal-agent && node --experimental-sqlite probe_mcp.js)   # 12 checks
```

Each probe builds its own synthetic database in a temp directory and removes it
afterwards. Tests build their own targets; they never touch live data.

## What this repository is, and is not

**It is** three working subsystems plus the specification behind them: the data
models, the algorithms, the parameters with their reasons, the safety boundaries,
and the decisions that look strange until you know what they were avoiding. Each
subsystem runs on its own and can be adopted on its own — `src/sleep` in
particular is usable as-is against the Claude Agent SDK (`example_claude.py`).

**It is not** a framework. The host that binds the three into one living agent is
deployment-specific; [`examples/minimal-agent`](examples/minimal-agent/) is a
worked example of one — two files, runnable — rather than an abstraction you are
meant to extend. Any host has to provide four things, and it is worth knowing
what they are before borrowing someone else's:

1. **The resident layer** — a non-exiting process holding one continuous model
   session, with every entry point routed into it. `docs/architecture.md` says to
   port this first; it means it. See `examples/minimal-agent/host.py`.
2. **A tool surface** — the memory and drives functions exposed to the agent as
   callable tools (MCP or equivalent). This is load-bearing rather than plumbing:
   the entire design rests on retrieval and scoring being *initiated by the agent*,
   which cannot happen if it has no hands. The per-subsystem READMEs list which
   functions to expose.
3. **A scheduler** — the integrator tick, the nightly pipeline, the heartbeat.
4. **The prompts.** In a system like this the prompt text is not configuration,
   it is code: the wording that makes involuntary recall fire only on a genuine
   cue, or that keeps a proactive message from inventing facts about the user, is
   doing as much work as any function here. `src/sleep/somnus.py` and the example's
   tool descriptions and heartbeat ship theirs in full — read them as source, and
   expect to rewrite them for your own deployment and its agent.

A competent engineer can rebuild the whole thing from `docs/` — that is what the
documentation is for, and the parts most likely to be got wrong (guardrails on
proactive behavior, provenance labels on fallback output, the narrow ignition
gate on involuntary recall) are spelled out there rather than left as an exercise.
The example is the short way in; `docs/` is the long way, and the one that
survives you disagreeing with our choices.

## Author

Molly Chen

Life was designed and built over two months with two Claude instances — see
[CREDITS.md](CREDITS.md).

## License and credits

**[PolyForm Noncommercial 1.0.0](LICENSE)** — free for personal use, research,
education, and noncommercial organizations; commercial use is not granted.
Note this is a source-available license, not an OSI-approved open-source one.

Life takes no source code from other projects, but it does stand on their ideas —
the emotional-memory fields come from [Ombre-Brain](https://github.com/P0luz/Ombre-Brain)
(P0luz, MIT), and the packing-note discipline from **MiMo-Code**'s checkpoint
format. Full attributions, including the research this design leans on, are in
[CREDITS.md](CREDITS.md).
