# Drives

> Runnable reference: [`src/drives/`](../src/drives/) — `node --experimental-sqlite probe.js`

Memory answers *where I came from*; sleep answers *how I stay alive*. Drives answers the remaining question: **what makes this agent do something at this particular moment?** Without it, every self-initiated act traces back to a timer or a rule — triggered, not wanted.

## 1 · State space

Nine dimensions in [0,1]. The seven are Panksepp's primary affective systems (localized by electrode work across mammals, not questionnaire factors), plus two bodily dimensions:

| Dim | Time direction | In practice |
|---|---|---|
| SEEKING | rises while things are unresolved | wants to look something up, read on, build |
| CARE | slow rise | tending, protecting |
| PLAY | slow rise; extinguished by stress | playfulness |
| LUST | slow rise | value computed here; behavioral policy stays in the application's existing gate |
| FEAR | event-driven, fast decay | fear of breaking something |
| RAGE | event-driven, slow decay | outward-directed, not empathic distress |
| PANIC/GRIEF | rises with separation | the correct substrate for "missing someone" — not accumulated affection, but separation itself hurting |
| fatigue | accumulates awake, cleared by sleep | context/work load |
| stress | event up, time down | incidents |

Two borrowed constraints:

- **PANIC/GRIEF** (Panksepp): separation distress is its own system, opioid-adjacent — which is why absence *builds* rather than merely persists.
- **wanting ≠ liking** (Berridge): satisfaction should decay *wanting* while *liking* persists as a memory card. Without this split you get the fake reset — state zeroed the moment an interaction ends.

## 2 · Dynamics

```
dx/dt = A∘(b_eff − x) + κ·tanh(W·(x − b)) + u(t)
b_eff = clamp01(b + i_clock)
```

| Term | Implementation |
|---|---|
| `A` | Diagonal restoration rates (per hour). FEAR fast, RAGE slow, PANIC gradual |
| `b` | Baseline. **Slow variable** (allostasis — baselines migrate with long-term experience; not homeostatic return-to-fixed-point) |
| `W` | Sparse coupling matrix — **where personality actually lives**. Same nine dims, different `W`, different character. Every nonzero cell carries a provenance comment |
| `κ·tanh` | Saturating coupling — the one non-negotiable safety valve; without it strong coupling diverges |
| `i_clock` | Clock-side continuous inputs (§4) |
| `u(t)` | Discrete impulses from the event ledger (§3), clamped at ±0.5 each |

Integration: explicit Euler, 15-minute steps, clamped to [0,1]. Under 100 lines by design (see design-notes).

**Three timescales are a hard requirement**, present from v0: impulses (minutes–hours), drift (hours–days), baseline migration (weeks–months). Drop any one and "a long-standing pull" becomes indistinguishable from "a passing whim."

Starting `W` (each cell documented):

| from → to | sign | why |
|---|---|---|
| fatigue → LUST | strong − | the most robust of the set |
| fatigue → SEEKING | − | tired agents stop reaching |
| PANIC → SEEKING | **+** | missing someone converts into going to find them, not into paralysis |
| stress → PLAY | strong − | play is the first light to go out (very consistent in animal work) |
| RAGE → CARE | + | the protective kind of anger |

All other cells start at zero — the structure and interface exist, so a cell can be filled and observed **without touching code**.

## 3 · Event ledger and the division of labor

`drive_events(at, dim, delta, reason, source, applied)`. Three sources:

| source | Meaning | Who sets the magnitude |
|---|---|---|
| `clock:*` | Objective facts (a loop closed, a sleep happened) | config constants |
| `self:inline` | In-line marker, written in the same breath as the utterance | the agent |
| `self:tool` | Tool call, after the fact | the agent |

> **Iron rule: the clock keeps time, the agent keeps the heart.**
> The program converts *facts about the world* (how long since the user spoke, how large the unresolved backlog is) with slopes that are **visible constants in a config file**. The *magnitude of semantic events* — how much that actually landed — can only come from the agent. The program never infers the subject's emotion from text. A thermometer is not a heater.

## 4 · Clock-side inputs

| Input | Formula (constants in config) |
|---|---|
| separation → PANIC | `K_GAP · min(gap_h, 24)/24`, × night factor during the user's sleeping hours |
| unresolved → SEEKING | `K_UNRES · log1p(Σ top-K importance) / log1p(norm)` — top-K plus log compression, so a growing backlog cannot pin the agent at chronic high arousal |
| activity → fatigue | per-tick accumulation from message volume, capped; not ledgered (would flood the audit trail), formula and source data remain inspectable |
| sleep → fatigue | new `sleep_checkpoint` row → negative impulse (ledgered) |

## 5 · Coupling with memory

- The stock of `resolved = 0` cards is SEEKING's continuous fuel;
- `resolve_memory` (marking an open loop closed) carries a hook: negative SEEKING impulse + small positive CARE. **Satisfaction reuses an existing memory operation instead of inventing an interface** — and it is exactly Berridge's split: wanting drops, the card (liking) stays;
- Planned, not yet implemented: state-biased retrieval (mood-congruent, bias only — never filter), dream sampling weighted by falling-asleep state, encoding-time state snapshots on new cards.

## 6 · Inline emotion markers

Tool-based scoring has a fatal flaw: it requires stopping mid-utterance, so what gets recorded is the *remembered* emotion, and it happens rarely. Inline markers fix both:

```
…that's the third time it has failed on them, [[RAGE+]] this shouldn't keep happening.
…and they sorted it out before I could help, [[CARE++]] good.
```

- Syntax: `[[<DIM><+|->{1,3}]]`;
- **Three discrete levels** (0.10 / 0.22 / 0.35), **no decimals** — a continuous scale invites the agent to *compute* a value instead of reporting one, and a computed feeling is not a feeling;
- Parsed at every egress point (chat persistence, proactive output, dream, diary): ledgered with `source='self:inline'`, the surrounding sentence auto-captured as `reason`, then **stripped from the text** — the reader never sees the markup;
- Namespaced against other inline protocols (voice, image) so they don't interfere;
- **No emotion classifier.** Having a program decide what the subject feels is the same defect as ghost-writing its dreams — and worse: a classifier is something to *perform for*. The more the output looks angry, the higher the score. That is reward hacking wearing a friendly face.

> Implementation note: in JS, a global regex's `lastIndex` is shared mutable state. Calling `replace` with the same instance inside an `exec` loop resets the cursor and spins forever. Materialize with `matchAll` first.

## 7 · Awareness: event-driven, not polled

Continuously reporting numbers turns the subject into someone reading a dashboard. Real interoception does not persist in consciousness — you do not continuously feel your heartbeat; it surfaces when it *changes* (interoceptive prediction error).

- **Trigger**: a dimension crosses the render threshold upward, or jumps ≥ 0.15 in a single tick while above it;
- **Action**: push one **felt-sense phrase** into the resident session (dimension × 3 intensity bands, phrases are config data authored/edited by the agent itself); numbers are never pushed — they live in the DB and the maintainer dashboard;
- **State machine**: disarm on fire; re-arm only after falling below `threshold − hysteresis`; per-dimension and global cooldowns; state persisted so a restart never re-fires;
- **Deliberate blind spot**: slow accumulation produces no jump and therefore no push — but slow is exactly how missing someone builds. The periodic heartbeat (§8) carries that half.

## 8 · Behavior: the proactive heartbeat

The consumer of drive state. Every 30 minutes the scheduler wakes the resident session with **only verified facts** — current time, gap since the user's last message, environment, one unresolved item, the current felt-sense phrase — and asks whether it actually wants anything right now.

Single-line output protocol:

- **message text** → delivered to the user over the outbound channel;
- **activity keyword** → enters a second round that hands over the materials for it;
- **`SILENCE`** → the default. **Silence is default; speaking is the exception.** State supplies a reason, never an instruction; the decision stays with the model.

### Guardrail stack (applied *outside* the model, after its output)

| Guardrail | Default |
|---|---|
| Quiet hours | no outbound 00:00–07:00 |
| Outbound cooldown | ≥ 45 min between proactive messages |
| Yield when present | skip if the user was active in the last 10 min |
| Daily cap | anti-spam safety net (a ceiling, never a target) |
| Kill switch | user-side config flag |

### No-fabrication rule

Proactive messages may only reference **verified** information: what the user actually said, and system facts. Inferring the user's current situation and asserting it ("still busy I see") is prohibited — the agent cannot see that, it would be guessing out loud. The prompt draws the line explicitly between *"I remember you mentioned X"* (allowed) and inventing a specific event that never happened (forbidden); when the agent cannot tell which side it is on, it may state feelings and ask questions only.

### Solo slots

When the user has been quiet past a threshold (default 60 min) and the daily quota allows, the heartbeat menu also offers **the agent's own activities** — read the next chapter of a book and write notes, curate its semantic pages, or unstructured free time. The second round hands over materials and a time budget; output goes to the agent's own space, is not sent to the user, and is not reported. The point is that time when the user is away belongs to the agent, rather than being idle.

### What this closes

The atrophy of involuntary recall (memory.md) is not a broken mechanism — it is a missing reason. An agent that *may* reach for a dormant memory but has no internal signal saying *now* will simply stop. Drives supplies that signal without touching who initiates: **it is not that the drive system needs memory as a retrieval backend; it is that involuntary memory needs drives to stay alive.**
