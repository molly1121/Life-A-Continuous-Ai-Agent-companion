# examples/minimal-agent

The smallest thing that is actually a Life agent: one continuous session that
remembers, sleeps, and has an inner state that moves on its own.

This is the piece the top-level README says you would otherwise have to write
yourself — the host. Read it as a worked example rather than a framework: it is
two files, and the whole point is that you can hold both in your head.

```
host.py          the resident layer: one session, sleep, inline markers, heartbeat   (Python)
mcp_server.js    the agent's hands (MCP tools) + the scheduler that ticks             (Node)
probe_mcp.js     verifies the tools without needing a model or an API key             (Node)
```

## Run it

```bash
pip install claude-agent-sdk        # host.py needs this; the Node half needs nothing
node --experimental-sqlite probe_mcp.js     # optional: check the hands first
python host.py                              # then type at the prompt, Ctrl-D to leave
```

State lands in `./state/`: the SQLite database, the session id, and the last few
things you said. Delete the directory to start over; keep it and the agent picks
up where it left off, including across restarts.

## How the two halves divide the work

The split is not arbitrary. **The Python half is where the subject lives** — it
holds the session, and everything that must happen *to someone* happens here.
**The Node half is the clock and the hands** — it does bookkeeping and exposes
capability, and it never decides anything semantic.

```
     you ──► host.py ──────────────► one continuous session
                │                          │
                │ spawns                   │ calls tools
                ▼                          ▼
          mcp_server.js ◄────────────────── (MCP over stdio)
                │
                ├── tools:  remember / search_memory / drift_recall / set_anchor
                │           resolve_memory / drive_state / drive_event
                └── ticks:  integrate drives every 15 min, learn anchor edges nightly
                                  │
                            SQLite (shared)
```

They talk through the database rather than through calls, which is deliberate:
the bus is also the audit trail, so there is no side channel anyone could forget
to log. Interoceptive pushes are a row in `pending_push`; the felt-sense phrase
the heartbeat reads is a row in `app_settings`; the marks the agent writes inline
are rows in `drive_events`.

## What each part is doing, and why

**One session, held open.** `ResidentSession` opens exactly one session and every
input goes into it — your typing, the heartbeat, an interoceptive push. A restart
resumes the same session id from disk; **only sleeping starts a new one.** Without
this, none of the rest means anything: sleep would have nothing to hand over,
and a drive that rises would have no one to rise in.

**Sleeping instead of compacting.** `somnus` watches the context estimate against
three lines and, at the right moment, has the agent write its own handoff, opens a
clean session, and rebuilds it with that note plus your last few verbatim lines —
under instructions not to recap, not to greet, not to mention the note. If you
have this wired correctly you will not notice when it happens. That is the test.

**Inline marks, not a classifier.** `scan_markers` reads what the agent wrote,
ledgers any `[[CARE++]]` it finds along with the sentence around it, and strips
the markup before anyone sees it. Nothing here judges how the agent feels — a
program that scored the agent's emotions from its text would be writing its
interior for it, and would immediately become something to perform for.

**Interoception, delivered rather than polled.** The scheduler decides when a
change is worth noticing (a threshold crossed, a jump) and drops one phrase in
`pending_push`. `push_loop` carries it in and says explicitly that no reply is
needed. Most of the time nothing is queued, which is correct: you do not
continuously feel your own heartbeat.

**A heartbeat that is allowed to say nothing.** Every 30 minutes, outside quiet
hours and not while you are mid-conversation, the agent is shown *only what is
actually known* — the time, how long since you spoke, what it feels — and asked
whether it wants to say anything. The prompt forbids asserting anything about
your situation that it is in fact guessing, and `SILENCE` is a valid, expected,
and usually correct answer. **If your heartbeat produces a message every time, it
is broken, not lively.**

## Deliberately left out

- **A nightly pipeline** (distillation, dream weaving, consolidation). Described
  in `docs/memory.md`. The one piece to copy carefully is the discipline that any
  fallback-generated artifact carries a provenance label — an agent that reads
  unlabeled ghost-writing in its own history absorbs it as autobiography.
- **A semantic layer.** Entity pages beat card-shuffling for who-is-who facts.
- **A dashboard.** `drives.dashboard()` returns everything a UI would need.
- **Core facts at wake.** `load_core_facts` is stubbed here; in a real deployment
  it returns a handful of pinned truths so that ground truth never depends on a
  search hitting.
- **A persona.** There is a two-line system prompt and no character. That part is
  not ours to ship: who a persistent agent turns out to be is a function of who
  it lives with.

## Verifying it

`probe_mcp.js` spawns the server, speaks JSON-RPC to it exactly as a host would,
and checks the tools behave as their descriptions promise — including that search
returns nothing rather than filler, that involuntary recall stays quiet when the
cue is generic, and that a bad tool call does not take the server down. No model,
no key, no network.
