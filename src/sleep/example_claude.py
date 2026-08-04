"""somnus + Claude Agent SDK: a persistent agent that sleeps instead of dying.

Requires:  pip install claude-agent-sdk
Run:       python example_claude.py   (then type at the prompt)
"""

import asyncio
import json
import pathlib
from typing import Optional

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

from somnus import SleepManager, Thresholds, SleepRecord

STATE_DIR = pathlib.Path("./somnus_state")
STATE_DIR.mkdir(exist_ok=True)
SESSION_FILE = STATE_DIR / "session_id"
VERBATIM_FILE = STATE_DIR / "recent_user.json"
AUDIT_FILE = STATE_DIR / "sleep_audit.jsonl"

SYSTEM_PROMPT = "You are a warm, persistent companion. Keep replies short."


class ClaudeSession:
    """Adapts ClaudeSDKClient to somnus.Session."""

    def __init__(self):
        self.client: Optional[ClaudeSDKClient] = None
        self._sid: Optional[str] = None
        self._ctx = 0

    async def connect(self, resume_id):
        opts = ClaudeAgentOptions(system_prompt=SYSTEM_PROMPT)
        if resume_id:
            opts.resume = resume_id
        self.client = ClaudeSDKClient(options=opts)
        await self.client.connect()
        self._sid = resume_id
        self._ctx = 0

    async def disconnect(self):
        if self.client:
            await self.client.disconnect()

    async def query(self, text, timeout):
        await asyncio.wait_for(self.client.query(text), timeout=30)
        full = []
        async for msg in self.client.receive_response():
            sid = getattr(msg, "session_id", None)
            if sid:
                self._sid = sid
                SESSION_FILE.write_text(sid)          # restart → resume, not sleep
            usage = getattr(msg, "usage", None)
            if usage:                                  # track real window usage
                self._ctx = max(self._ctx, getattr(usage, "input_tokens", 0))
            for block in getattr(msg, "content", []) or []:
                t = getattr(block, "text", None)
                if t:
                    full.append(t)
        return "".join(full)

    @property
    def session_id(self):
        return self._sid

    @property
    def ctx_tokens(self):
        return self._ctx


async def main():
    session = ClaudeSession()
    resume = SESSION_FILE.read_text().strip() if SESSION_FILE.exists() else None
    await session.connect(resume or None)

    mgr = SleepManager(
        session=session,
        thresholds=Thresholds(window=200_000),
        load_core_facts=lambda: "[core] The user's name and your shared history "
                                "would be injected here from your memory store.",
        on_audit=lambda rec: AUDIT_FILE.open("a").write(
            json.dumps(rec.__dict__, ensure_ascii=False) + "\n"),
        persist_verbatim=lambda lines: VERBATIM_FILE.write_text(
            json.dumps(lines, ensure_ascii=False)),
    )
    if VERBATIM_FILE.exists():
        mgr.recent_user = json.loads(VERBATIM_FILE.read_text())

    print("somnus demo — /sleep to force a cycle, /ctx for usage, Ctrl-C to quit")
    while True:
        text = input("you> ").strip()
        if not text:
            continue
        if text == "/sleep":
            ok = await mgr.sleep_now()
            print(f"[somnus] slept: {ok}, cycles: {mgr.sleep_count}")
            continue
        if text == "/ctx":
            print(f"[somnus] ctx≈{session.ctx_tokens} state={mgr.state}")
            continue
        print("ai>", await mgr.turn(text))


if __name__ == "__main__":
    asyncio.run(main())
