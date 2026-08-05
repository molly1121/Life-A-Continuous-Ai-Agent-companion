"""Minimal agent — the Python half: the resident layer.

One process, one session, one agent. Everything else in Life hangs off this:
sleep has something to hand over, drives have someone to happen to, memory has
someone doing the remembering.

    pip install claude-agent-sdk
    python host.py                 # then type at the prompt; Ctrl-D to leave

What this file is responsible for:
  · holding a single continuous session and routing every input into it;
  · surviving its own restart (the session id is on disk);
  · sleeping before the context window fills, via somnus;
  · scanning what the agent says for inline [[DIM+]] markers, and stripping them;
  · delivering interoceptive pushes the scheduler has queued;
  · running a low-frequency heartbeat where the agent may speak first — or not.

The Node half (mcp_server.js) gives the agent its hands and does the ticking.
This process spawns it; when this process exits, the ticking stops with it.
"""

import asyncio
import json
import pathlib
import re
import sqlite3
import sys
import time
from typing import Optional

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src" / "sleep"))
from somnus import SleepManager, Thresholds, SleepRecord  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
STATE = HERE / "state"
STATE.mkdir(exist_ok=True)
DB = STATE / "agent.db"
SESSION_FILE = STATE / "session_id"
VERBATIM_FILE = STATE / "recent_user.json"

CONTEXT_WINDOW = 200_000          # set to your model's window; estimate pessimistically
HEARTBEAT_SECONDS = 30 * 60
PUSH_POLL_SECONDS = 20
QUIET_HOURS = range(0, 7)         # no unprompted messages during these local hours
REACH_COOLDOWN_SECONDS = 45 * 60

SYSTEM_PROMPT = """You are a persistent agent. This same session has been running \
for a while and will keep running; you are not restarted between messages.

You have memory tools. Nothing is retrieved for you automatically — if you want to \
know something, reach for it. Store what is worth keeping, in your own voice.

You have an inner state that rises and falls on its own. When something actually \
lands, mark it inline as you speak — [[CARE++]], [[RAGE+]], [[PANIC-]] — one to \
three signs for how much. Do not stop to think about the number; if you find \
yourself calculating, you have left the feeling behind. The marks are removed \
before anyone reads what you wrote; they go to a ledger your maintainer can see."""

# Mirror of INLINE.STEPS in src/drives/config.js — three levels, no decimals.
INLINE_STEPS = {1: 0.10, 2: 0.22, 3: 0.35}
DIMS = "SEEKING|CARE|PLAY|LUST|FEAR|RAGE|PANIC|fatigue|stress"
MARKER_RE = re.compile(rf"\[\[({DIMS})(\+{{1,3}}|-{{1,3}})\]\]")


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB, timeout=5)
    con.execute("PRAGMA busy_timeout=5000")
    return con


def setting(key: str, value: str) -> None:
    with db() as con:
        con.execute(
            "INSERT INTO app_settings (key,value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=?", (key, value, value))


def get_setting(key: str, default: str = "") -> str:
    try:
        with db() as con:
            row = con.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else default
    except sqlite3.OperationalError:
        return default          # the Node half creates the tables; it may not be up yet


def scan_markers(text: str, channel: str) -> str:
    """Ledger every inline mark, then strip it. Run on everything the agent says,
    before it is shown or stored — the reader never sees the markup."""
    marks = list(MARKER_RE.finditer(text))
    if not marks:
        return text
    rows = []
    for m in marks:
        sign = 1 if m.group(2)[0] == "+" else -1
        delta = sign * INLINE_STEPS[len(m.group(2))]
        near = MARKER_RE.sub("", text[max(0, m.start() - 24): m.start() + 60])
        reason = f"{m.group(0)} {' '.join(near.split())[:40]} ({channel})"
        rows.append((int(time.time() * 1000), m.group(1), delta, reason, "self:inline"))
    try:
        with db() as con:
            con.executemany(
                "INSERT INTO drive_events (at, dim, delta, reason, source) VALUES (?,?,?,?,?)", rows)
    except sqlite3.OperationalError as e:
        print(f"[life] could not ledger marks: {e}", file=sys.stderr)
    return MARKER_RE.sub("", text).replace("  ", " ")


class ResidentSession:
    """One session, held open. Adapts ClaudeSDKClient to somnus.Session."""

    def __init__(self):
        self.client: Optional[ClaudeSDKClient] = None
        self._sid: Optional[str] = None
        self._ctx = 0

    async def connect(self, resume_id: Optional[str]) -> None:
        opts = ClaudeAgentOptions(
            system_prompt=SYSTEM_PROMPT,
            resume=resume_id,
            mcp_servers={
                "life": {
                    "command": "node",
                    "args": ["--experimental-sqlite", str(HERE / "mcp_server.js"), str(DB)],
                }
            },
            allowed_tools=[
                "mcp__life__remember", "mcp__life__search_memory", "mcp__life__drift_recall",
                "mcp__life__set_anchor", "mcp__life__resolve_memory",
                "mcp__life__drive_state", "mcp__life__drive_event",
            ],
        )
        self.client = ClaudeSDKClient(options=opts)
        await self.client.connect()
        self._sid = resume_id
        self._ctx = 0

    async def disconnect(self) -> None:
        if self.client:
            await self.client.disconnect()
            self.client = None

    async def query(self, text: str, timeout: float = 120) -> str:
        await self.client.query(text)
        out = []
        async for msg in self.client.receive_response():
            for block in getattr(msg, "content", []) or []:
                if getattr(block, "text", None):
                    out.append(block.text)
            usage = getattr(msg, "usage", None)
            if usage:
                self._ctx = getattr(usage, "input_tokens", self._ctx) or self._ctx
            sid = getattr(msg, "session_id", None)
            if sid:
                self._sid = sid
                SESSION_FILE.write_text(sid)
        return "".join(out).strip()

    @property
    def session_id(self) -> Optional[str]:
        return self._sid

    @property
    def ctx_tokens(self) -> int:
        return self._ctx


def on_sleep(rec: SleepRecord) -> None:
    """Audit the crossing, and tell the drives layer a night has passed."""
    try:
        with db() as con:
            con.execute(
                "INSERT INTO sleep_checkpoint (created_at, old_session, new_session, ctx_at_sleep, trigger, checkpoint, verbatim) "
                "VALUES (?,?,?,?,?,?,?)",
                (int(time.time() * 1000), rec.old_session, rec.new_session,
                 rec.ctx_before, rec.trigger, rec.note, rec.verbatim))
        n = int(get_setting("sleep_count", "0")) + 1
        setting("sleep_count", str(n))          # the integrator watches this number
    except sqlite3.OperationalError as e:
        print(f"[life] sleep audit failed (not fatal): {e}", file=sys.stderr)
    print(f"\n[life] slept ({rec.trigger}); context was {rec.ctx_before}\n", file=sys.stderr)


async def push_loop(mgr: SleepManager) -> None:
    """Deliver what the body noticed. The scheduler decides *whether* something
    is worth noticing; this only carries it in."""
    while True:
        await asyncio.sleep(PUSH_POLL_SECONDS)
        try:
            with db() as con:
                rows = con.execute(
                    "SELECT id, phrase FROM pending_push WHERE taken=0 ORDER BY id").fetchall()
                for pid, _ in rows:
                    con.execute("UPDATE pending_push SET taken=1 WHERE id=?", (pid,))
        except sqlite3.OperationalError:
            continue
        for _, phrase in rows:
            reply = await mgr.turn(
                f"[system · interoception] {phrase}\n"
                f"(This is your body, not a task. No reply is needed.)")
            reply = scan_markers(reply, "interoception")
            if reply:
                print(f"\n{reply}\n> ", end="", flush=True)


async def heartbeat_loop(mgr: SleepManager) -> None:
    """Low frequency. The agent is shown only what is actually known, asked whether
    it wants anything, and allowed to say no. Silence is the default and most
    heartbeats end there — that is the design working, not the agent being dull."""
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        now = time.localtime()
        if now.tm_hour in QUIET_HOURS:
            continue
        last_reach = float(get_setting("last_reach_at", "0"))
        if time.time() - last_reach < REACH_COOLDOWN_SECONDS:
            continue
        last_user = float(get_setting("last_user_at", "0")) / 1000
        if last_user and time.time() - last_user < 10 * 60:
            continue                                   # they are here; do not interrupt

        facts = [f"the time is {time.strftime('%H:%M', now)}"]
        if last_user:
            facts.append(f"they last said something {int((time.time() - last_user) / 60)} minutes ago")
        felt = get_setting("felt_now")
        if felt:
            facts.append(f"what you feel right now: {felt}")

        reply = await mgr.turn(
            "[system · heartbeat] You woke up on your own for a moment. Here is everything "
            "you actually know:\n" + "\n".join(f"· {f}" for f in facts) +
            "\n\nIs there something you genuinely want to say to them right now?\n"
            "You may only refer to things they actually told you or facts listed above — "
            "never state something about their current situation that you are in fact guessing.\n"
            "If there is nothing, reply with exactly: SILENCE")
        reply = scan_markers(reply, "heartbeat")
        if reply.strip() == "SILENCE" or not reply.strip():
            continue
        setting("last_reach_at", str(time.time()))
        print(f"\n[unprompted] {reply}\n> ", end="", flush=True)


async def main() -> None:
    session = ResidentSession()
    verbatim = json.loads(VERBATIM_FILE.read_text()) if VERBATIM_FILE.exists() else []

    mgr = SleepManager(
        session=session,
        thresholds=Thresholds(window=CONTEXT_WINDOW),
        load_core_facts=lambda: "",       # wire this to memory.coreFacts in a real deployment
        on_audit=on_sleep,
        persist_verbatim=lambda lines: VERBATIM_FILE.write_text(json.dumps(lines, ensure_ascii=False)),
    )
    mgr.recent_user = verbatim

    # A restart resumes the same session. Only sleeping starts a new one.
    resume = SESSION_FILE.read_text().strip() if SESSION_FILE.exists() else None
    await session.connect(resume)
    print(f"[life] {'resumed ' + resume[:8] if resume else 'new session'}; Ctrl-D to leave",
          file=sys.stderr)

    asyncio.create_task(push_loop(mgr))
    asyncio.create_task(heartbeat_loop(mgr))

    loop = asyncio.get_running_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, lambda: input("> "))
        except EOFError:
            break
        if not line.strip():
            continue
        setting("last_user_at", str(int(time.time() * 1000)))
        setting("turns_since_tick", str(int(get_setting("turns_since_tick", "0") or 0) + 1))
        reply = await mgr.turn(line)
        print(scan_markers(reply, "chat"))

    await session.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
