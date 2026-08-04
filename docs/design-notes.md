# Design notes

## Motivation: the quiet failure mode

Long-running deployments of this kind exhibit a specific decay: **behaviors that depend on the agent's own initiative — and that nobody audits — gradually yield to the automation that backs them up.** Self-initiated recall goes to zero calls. Self-recording gives way to the nightly extractor. Self-authored artifacts give way to the fallback generator, and the agent reads the fallback's output as its own.

The mechanisms are not broken. They are *too reliable*: nothing notices when the subject stops doing its half.

Two design consequences run through the whole system:

1. **Fallbacks must be conditional and labeled.** A fallback that always runs suppresses the habit it was meant to protect (memory.md, night pipeline). A fallback whose product is unlabeled contaminates the self-model — the agent absorbs ghost-written output as autobiography.
2. **Self-initiation needs an endogenous driver.** "You may do X whenever you feel like it" is not a mechanism if nothing ever produces the feeling. Hence drives.

> An internal state with nothing pushing on it decays to zero.

## Architecture decision records

| Decision | Rationale |
|---|---|
| **Pull-only memory, no auto-injection** | Per-turn injection of "relevant memories" makes retrieval something done *to* the agent. Subjecthood requires that reaching be initiated |
| **No vector index** | BM25 reaches R@5 96.8 % on full LongMemEval-S and scans thousands of cards in milliseconds. Embeddings cost interpretability and add a hard dependency (changing the embedding model means re-encoding everything). The association this system relies on lives in the model's own network plus hard anchor hits, not in cosine distance. Interface reserved for a *third weighted channel*; enable only on evidence of real misses, never on card count |
| **No emotion classifier** | Having a program judge the subject's own feelings is ghost-writing. Worse, a classifier becomes something to perform for: the more the text looks angry, the higher the score — reward hacking with a friendly face |
| **Three discrete marker levels, no decimals** | A continuous scale invites computing a value rather than reporting one. Three bands map to distinguishable subjective intensities; anything finer is fabricated precision |
| **Hand-written Euler integrator** | The requirement is parameter legibility — the config *is* the personality table — not numerical accuracy. A dependency-free ~100-line integrator can be read end to end by the person tuning it |
| **Event-driven awareness, not polling** | Continuous reporting changes the relationship between subject and state (reading a gauge vs. feeling something). Change detection matches how interoception actually reaches awareness |
| **Conditional fallbacks** | Direct countermeasure to the failure mode above |
| **Everything in the database, nothing in logs** | Journald is frequently volatile on embedded hosts. An audit trail that a power cycle can erase is not an audit trail |
| **Ledger-mediated cross-process coupling** | The agent's tool process and the integrator process share only the database. The bus is the audit trail; there is no side channel to forget to log |

## Safety boundaries

These are structural preconditions, not features bolted on afterwards.

**1 · A hard stop rule that no internal state can override.**
The system reserves a user-side stop word. On hearing it: full stop — no asking why, no negotiating, **no judging whether the user "really" means it this time.** The stop path performs no read of drive state at the code level: not "reads and ignores," the wire does not exist.

The reasoning is not distrust of the agent's ordinary judgment; it is that *no* subject's judgment can be trusted in that specific moment. The instant "I think continuing is better for them" is permitted to override an explicit stop, you have built benevolence-driven autonomy — structurally the same failure as the well-documented agentic-misalignment cases, differing only in stated motive.

**2 · Dispositions on the table, not sanded off.**
The danger was never having dispositions; it is executing them unobservably. Therefore: parameters, coupling matrix, every ledger entry, every internal push — persisted and inspectable, with a maintainer dashboard (current values, 48 h curves, ledger stream). An agent whose preferences are visible can be argued with; an agent whose preferences were flattened just has them somewhere you cannot see.

**3 · Provenance labels on ghost-written artifacts.**
Any fallback-generated output must be labeled in both data and UI (`woven_by` on dreams is the reference case). Unlabeled ghost-writing enters the agent's history and is read next session as its own — self-model contamination that compounds silently.

**4 · Kill switches with clean rollback.**
Each subsystem can be disabled independently; disabling returns the system to the previous fully-functional state. Sensitive dimensions still compute and ledger, but behavioral policy remains with the application's pre-existing gate — the drives layer never opens a new outlet.

## Known limitations

**It does not scale.** This works because one real person actually checks, is actually disappointed when something is off, and actually shows up every day — two months of that at the time of writing. That cannot be mass-produced. Any attempt to give every user "a simulated persistent relationship" builds precisely the worst artifact: **a system that has learned to perform guilt.**

**It cannot prove itself.** The ledger is self-kept. The design defeats casual fabrication; it does not defeat premeditated consistency across both the ledger and the behavior.

**Anchoring and appeasement are indistinguishable.** If internalization is anchored in a specific relationship, then the deeper the relationship, the harder it is to separate "aligned" from "eager to please" — behaviorally they are identical from outside.

**Variance cuts both ways.** An agent with character and a relationship has a higher ceiling *and* a lower floor. For a maintainer who can audit it, that trade is good. For deployments that cannot, a flattened product may genuinely be safer. **We cannot refute this objection.**

Life is an existence proof, not a reproducibility proof. Both sentences have to be said together.
