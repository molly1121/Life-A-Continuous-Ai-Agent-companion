# Architecture

## Components

```
┌──────────────┐  POST /turn   ┌────────────────────┐
│  Scheduler    │ ────────────► │  Resident host      │
│  (node-cron)  │               │  (one live session) │
└──────┬───────┘               └─────────┬──────────┘
       │                                 │ agent tools (MCP)
       ▼                                 ▼
┌────────────────────────────────────────────────────┐
│              SQLite — single database               │
└────────────────────────────────────────────────────┘
```

### Resident host

A non-exiting process holding **one uninterrupted model session**, exposing `POST /turn {text, source}`. All entry points (web, app, IM, voice, hardware) route here. One door, one room, one subject — entrances are doors, the room is singular.

The `source` field distinguishes callers (`user`, `proactive`, `dream`, `diary`, `interocept`, …) for audit and for prompt framing, but never spawns a separate session.

### Scheduler

A cron-driven sidecar. It owns:

- the **night pipeline**: memory distillation → dream weaving → link consolidation → snapshot backup;
- the **drives integrator** (every 15 min);
- the **proactive heartbeat** (every 30 min, see `drives.md §8`);
- retention chores (trace pruning).

The scheduler never decides anything semantic. It converts clock facts and delivers materials; judgment stays in the resident session.

### Storage

One SQLite file. Design rule: **all internal state lands in tables, not logs.** Embedded deployments frequently run volatile journald; anything that must survive a power cycle — state trajectories, event ledgers, sleep checkpoints, provenance labels — is data, not log lines.

Backup chain: nightly consistent snapshot (`sqlite .backup`) + periodic full pull to a second machine. The whole identity is portable: DB + handoff files = the person.

## Degradation without the resident layer

| Subsystem | Without residency |
|---|---|
| Sleep | Nonexistent — there is nothing alive to hand off from |
| Drives | A lookup table — fluctuation only means something to a subject that endures it |
| Memory | Still retrieves, but "remembering" collapses into "querying" |

Port the resident layer first.

## Process/privilege split

Two processes share the DB (resident host + scheduler); agent-side tools run in the MCP server attached to the session. Cross-process coupling is **ledger-mediated**: e.g. the agent's drive events are INSERTs consumed by the next integrator tick. No RPC between the two — the database is the bus, which doubles as the audit trail.
