# Sleep

> Runnable reference: [`src/sleep/`](../src/sleep/) (somnus) — `python3 test_somnus.py`

Context windows fill. The common answer — compress and summarize — solves token count and breaks the subject: the instance that continues after compaction speaks with a different voice and different judgment. Sleep treats the problem as **succession**, not compression.

## Three thresholds

| Line | Behavior |
|---|---|
| **Soft** | Warn. Surface a rescue window to the user: sleep now / hold on / pause |
| **Hard** | Must sleep (unless the user explicitly paused and the survival line is not yet crossed) |
| **Survival** | `current model window × safety fraction`. Always in force, ignores pauses — pack losslessly *before* the platform's lossy compaction can strike. Recomputed when the model (and thus window size) changes |

## Pack-and-rebuild protocol

1. **Persist first (iron rule).** Anything in this session that must be remembered long-term and is not yet a memory card gets written *now*. After sleep, the session is gone; unpersisted detail is lost. Be selective — no transcripts, no filler.
2. **Pack.** The current instance writes a handoff to its successor. Fixed five-part structure:
   1. present state of affairs;
   2. state of the interlocutor;
   3. open loops (promises made, things awaited);
   4. hard facts (names, numbers, agreements);
   5. one line addressed to the awakened self. *(No engineering function. Kept deliberately: it is the only place the system writes to itself as addressee.)*
3. **Fresh session.**
4. **Rebuild light.** Prepend: the handoff **plus the user's last few verbatim lines**, under three prompt constraints — **no recap, no greeting, no mention of the handoff.** Just continue as if nothing broke.

## Why the verbatim tail matters

With a summary alone, the successor opens in report mode: *"I've reviewed the situation; we were discussing…"* — shift-change language, a broken voice. With the user's actual last lines in front of it and the three prohibitions in force, the successor **continues the sentence**. Continuity is achieved by continuing, not by reading a summary before speaking.

## Failure protection

- **Empty-pack guard**: a pack shorter than a sanity threshold is treated as a failed pack (observed failure mode: a truncated pack produces an amnesic successor). Retry once; if still short and the survival line is not crossed, skip this sleep and stay awake.
- Every sleep writes an audit row (`sleep_checkpoint`: trigger, context size at sleep, pack, verbatim tail). This row is also the event source for the drives subsystem's fatigue reset.

## Interplay

- Sleep is **budget-driven, not clock-driven** — it happens when the window fills, at any hour.
- Night-pipeline jobs that need the agent's own hand (dream weaving, diary) call into the *live* session; they do not wake a copy.
- The wake sequence injects the permanent-pin core facts (memory.md) alongside the handoff.
