# reference/sleep — somnus 🌙

**Sleep cycles for long-running LLM agents.**

The sleep subsystem of [Life](../../README.md), also usable standalone.

A persistent agent — a companion, a resident assistant, anything that stays alive across days — eventually fills its context window. The usual fixes are bad: native auto-compaction is *lossy* and fires at the worst possible moment; restarting from scratch loses the thread entirely.

`somnus` gives your agent a third option: **it goes to sleep**. Before the window fills, the agent writes its own handoff note, flushes anything worth keeping into long-term memory, and wakes up in a fresh session that continues the conversation as if nothing happened. Context usage becomes a sawtooth that never hits the wall.

Extracted from a resident-agent deployment where a single continuous session has lived for two months across ~50 sleep cycles. The packing discipline is adapted from MiMo-Code's checkpoint format.

```
ctx ▲            hard ──────────────────────── safety ┄┄┄┄┄┄┄
    │        soft ─────────╮ sleep!        ╭─ sleep!
    │    ╱╲       ╱╲      ╱│      ╱╲      ╱ │
    │   ╱  ╲     ╱  ╲    ╱ │     ╱  ╲    ╱  │
    │  ╱    ╲___╱    ╲__╱  ╰────╱    ╲__╱   ╰────▶ time
    └──────────────────────────────────────────────
```

## The design

### Three thresholds, not one

| line | default | behavior |
|---|---|---|
| **soft** | `min(400k, window × 0.70)` | "getting sleepy": surface a warning, give the human an override window (sleep now / hold on) |
| **hard** | `min(600k, window × 0.85)` | must sleep — unless a human pressed *hold*, and only until… |
| **safety** | `window × 0.90` | sleeps **unconditionally**, overriding any hold — always before the platform's lossy compaction fires |

Both an absolute cap and a window-ratio are applied and the *smaller* wins. This makes the thresholds survive model swaps: on a 1M-window model you sleep late and keep a thick memory; swap to a 200k model and all three lines tighten automatically while preserving the three-layer buffer. **Estimate the safety line pessimistically** — a line set too low just means sleeping early; too high means hitting the wall.

### The pre-sleep packing prompt

When it's time, the *current* agent writes its own handoff. Two rules make this work:

1. **Flush memory first (the iron rule).** Before writing the note, the agent must persist anything from this session that belongs in long-term memory — the session is about to dissolve, and anything not written down is gone. Be selective: no transcripts, no duplicates, only what matters.
2. **A fixed structure**: current situation / the person you're with / unfinished threads / hard facts to carry / *one line to your just-woken self*.

### Waking up

The new session's first input is assembled from four parts:

1. **Wake framing** — explicit instructions: *don't recap, don't say "I'm back", don't mention this note. Continue as if nothing happened.*
2. **Pinned core facts** — a small set of foundation memories (who the people are, what this place is) injected on *every* wake. Never rely on memory search for ground truth. Kept out of the system prompt deliberately, to protect the agent's authorship of its own persona.
3. **The packing note** written before sleep.
4. **Verbatim recent user lines** — the human's last few messages, stored *independently of the note* (and persisted to disk, so a process restart can't lose them), labeled "already discussed — only continue from the last line."

### Fail-safes (all learned the hard way)

- **Short-pack detection**: a healthy note is hundreds of characters. If the model returns a stub (it happens — "read but didn't reply"), retry once; if still short and you're not past the safety line, *skip this sleep and stay awake*. Past the safety line, sleep anyway with just the verbatim lines.
- **Pack timeout scales with context size** (a 500k-token session needs minutes, not 90 seconds; cap it).
- **Rollback on failed wake**: if feeding the wake packet into the new session fails, resume the *old* session and void the sleep. Never strand the agent in an empty shell.
- **Audit everything**: each sleep writes old/new session ids, context size, trigger, the full note, and the verbatim lines to a `sleep_checkpoint` table. When something feels off, you can read exactly what crossed the gap.
- **Sleep ≠ restart.** Process restarts resume the same session (store the session id on disk). Sleeping is the only thing that starts a new one.

## Reference implementation

`somnus.py` is a small, dependency-free state machine that implements everything above against an abstract `Session` interface. `example_claude.py` binds it to the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). Bring your own memory store — `somnus` only asks for two callbacks (`flush_memory_prompt` is folded into the packing prompt; `load_core_facts()` returns your pinned facts).

```python
from somnus import SleepManager, Thresholds

mgr = SleepManager(
    session=my_session,                  # connect / disconnect / query / ctx_estimate
    thresholds=Thresholds(window=1_000_000),
    load_core_facts=lambda: my_store.pinned(),
    on_audit=my_store.save_checkpoint,
)

async for turn in conversation:
    reply = await mgr.turn(turn)         # sleeps transparently when a line is crossed
```

## Status

Early extraction of a private implementation. The design has survived two months of daily use and ~50 sleep cycles; both it and this public rewrite are young — read them before trusting them.

## Credits

- Packing-note discipline adapted from **MiMo-Code**'s checkpoint format (Xiaomi
  MiMo team's model and open-source coding agent). See [CREDITS.md](../../CREDITS.md).

Licensed under [PolyForm Noncommercial 1.0.0](../../LICENSE) as part of Life.
