"""somnus — sleep cycles for long-running LLM agents.

A persistent agent fills its context window; somnus lets it sleep before the
wall: the agent writes its own handoff note, wakes in a fresh session, and
continues as if nothing happened. See README.md for the full design.

The packing-note discipline is adapted from MiMo-Code's checkpoint format
(Xiaomi MiMo team). See CREDITS.md.

This module is deliberately dependency-free. You supply a Session object
(connect/disconnect/query/ctx) and optional callbacks for pinned facts and
audit; somnus owns the state machine.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional, Protocol


# ── The contract you implement ────────────────────────────────────────────────

class Session(Protocol):
    """Minimal surface somnus needs from your LLM session."""

    async def connect(self, resume_id: Optional[str]) -> None:
        """Open a session. resume_id=None means a brand-new one."""

    async def disconnect(self) -> None: ...

    async def query(self, text: str, timeout: float) -> str:
        """Send one turn, return the full text reply."""

    @property
    def session_id(self) -> Optional[str]: ...

    @property
    def ctx_tokens(self) -> int:
        """Best-effort estimate of current context usage, in tokens."""


# ── Configuration ─────────────────────────────────────────────────────────────

@dataclass
class Thresholds:
    """Three lines. Absolute caps and window ratios are both applied; min wins.

    Estimate `window` pessimistically: a safety line set too low just means
    sleeping early; set too high, you hit the platform's lossy compaction.
    """
    window: int                      # model context window, tokens
    soft_abs: int = 400_000
    hard_abs: int = 600_000
    soft_frac: float = 0.70
    hard_frac: float = 0.85
    safety_frac: float = 0.90

    @property
    def soft(self) -> int:
        return min(self.soft_abs, int(self.window * self.soft_frac))

    @property
    def hard(self) -> int:
        return min(self.hard_abs, int(self.window * self.hard_frac))

    @property
    def safety(self) -> int:
        return int(self.window * self.safety_frac)


PACK_PROMPT = """[system · pre-sleep packing] Context is nearly full. You are \
about to sleep; this note is how you wake up and continue.

First, the iron rule — flush memory: anything from this stretch that belongs in \
long-term memory but isn't there yet (important feelings, events, promises, \
changes), persist it NOW with your memory tool. Once you sleep, this session \
dissolves; whatever isn't written down is gone. Be selective — no transcripts, \
no duplicates, only what matters.

Then write the handoff, in this shape:
1. Current situation
2. The person you're with — how they are right now
3. Unfinished threads
4. Hard facts to carry
5. One line to your just-woken self

Write it and you sleep; it is the first thing you will see when you wake."""

WAKE_FRAMING = """[system · waking] You just slept. Below is the note you left \
yourself, and the person's most recent words. Continue directly — no recap, no \
"I'm back", no mention of this note. As if nothing happened."""

RETRY_PROMPT = ("[system] Your packing note didn't come through. Write it now, "
                "directly: situation / them / unfinished / hard facts / one "
                "line to your woken self.")


@dataclass
class SleepRecord:
    old_session: Optional[str]
    new_session: Optional[str]
    ctx_before: int
    trigger: str
    note: str
    verbatim: str
    at: float = field(default_factory=time.time)


# ── The manager ───────────────────────────────────────────────────────────────

class SleepManager:
    """Wraps a Session; call `turn()` for every user turn, and call
    `maybe_sleep()` between turns (or let `turn()` do it for you).

    States: awake → drowsy (soft line, human may hold) → sleeping → awake.
    """

    PACK_MIN_CHARS = 200          # a healthy note is longer; shorter = failed
    VERBATIM_KEEP = 6             # user lines carried across the gap

    def __init__(
        self,
        session: Session,
        thresholds: Thresholds,
        load_core_facts: Callable[[], str] = lambda: "",
        on_audit: Callable[[SleepRecord], None] = lambda rec: None,
        persist_verbatim: Callable[[list[str]], None] = lambda lines: None,
    ):
        self.s = session
        self.t = thresholds
        self.load_core_facts = load_core_facts
        self.on_audit = on_audit
        self.persist_verbatim = persist_verbatim
        self.state = "awake"          # awake | drowsy | sleeping
        self.hold_until = 0.0         # human override: no auto-sleep before this
        self.sleep_count = 0
        self.recent_user: list[str] = []
        self._lock = asyncio.Lock()

    # -- public -----------------------------------------------------------------

    async def turn(self, text: str, timeout: float = 120) -> str:
        """One conversational turn. Transparently sleeps first if needed."""
        self.recent_user.append(text)
        self.recent_user = self.recent_user[-self.VERBATIM_KEEP:]
        self.persist_verbatim(self.recent_user)   # survive process restarts
        async with self._lock:
            await self._maybe_sleep_locked()
            reply = await self.s.query(text, timeout=timeout)
            self._update_state()
            return reply

    def hold(self, seconds: float = 1800) -> None:
        """Human pressed 'not now'. Honored up to the safety line, never past."""
        self.hold_until = time.time() + seconds

    async def sleep_now(self, trigger: str = "manual") -> bool:
        async with self._lock:
            return await self._sleep(trigger)

    # -- internals --------------------------------------------------------------

    def _update_state(self) -> None:
        if self.state == "sleeping":
            return
        self.state = "drowsy" if self.s.ctx_tokens >= self.t.soft else "awake"

    async def _maybe_sleep_locked(self) -> None:
        ctx = self.s.ctx_tokens
        if ctx >= self.t.safety:
            await self._sleep("safety")           # unconditional, ignores hold
        elif ctx >= self.t.hard and time.time() >= self.hold_until:
            await self._sleep("hard")

    async def _sleep(self, trigger: str) -> bool:
        self.state = "sleeping"
        ctx_before = self.s.ctx_tokens
        verbatim = "\n".join(f"· {t}" for t in self.recent_user) or "(they were quiet)"
        over_safety = ctx_before >= self.t.safety

        # Pack timeout scales with context size (big sessions think slowly).
        pack_timeout = min(300, max(90, ctx_before // 2000))

        note = await self._try_query(PACK_PROMPT, pack_timeout)
        if len(note.strip()) < self.PACK_MIN_CHARS:
            note = await self._try_query(RETRY_PROMPT, max(60, pack_timeout // 2))
        if len(note.strip()) < self.PACK_MIN_CHARS:
            if not over_safety:
                # Failed to pack and we still have room: stay awake, retry later.
                self.state = "awake"
                return False
            note = "(packing failed — waking with recent words only.)"

        # New blank session.
        old_sid = self.s.session_id
        try:
            await self.s.disconnect()
        except Exception:
            pass
        await self.s.connect(None)

        core = self.load_core_facts()
        core_block = f"{core}\n\n" if core else ""
        seed = (
            f"{WAKE_FRAMING}\n\n{core_block}"
            f"[your pre-sleep note]\n{note}\n\n"
            f"[their recent words — already discussed, do not answer line by "
            f"line; continue only from the last one]\n{verbatim}"
        )
        try:
            await self.s.query(seed, timeout=120)
        except Exception:
            # Rollback: never strand the agent in an empty shell.
            if old_sid:
                try:
                    await self.s.disconnect()
                except Exception:
                    pass
                await self.s.connect(old_sid)
            self.state = "awake"
            return False

        self.on_audit(SleepRecord(old_sid, self.s.session_id, ctx_before,
                                  trigger, note, verbatim))
        self.sleep_count += 1
        self.state = "awake"
        return True

    async def _try_query(self, prompt: str, timeout: float) -> str:
        try:
            return await self.s.query(prompt, timeout=timeout)
        except Exception:
            return ""
