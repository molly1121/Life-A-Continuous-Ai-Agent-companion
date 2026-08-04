"""State-machine tests for somnus with a fake session. Run: python test_somnus.py"""

import asyncio

from somnus import SleepManager, Thresholds, SleepRecord


class FakeSession:
    def __init__(self):
        self.sid = None
        self.ctx = 0
        self.n = 0
        self.pack_reply = "note " * 60          # healthy length by default
        self.fail_wake = False
        self.log = []

    async def connect(self, resume_id):
        self.n += 1
        self.sid = resume_id or f"s{self.n}"
        self.ctx = 0
        self.log.append(("connect", self.sid))

    async def disconnect(self):
        self.log.append(("disconnect", self.sid))

    async def query(self, text, timeout):
        self.log.append(("query", text[:24]))
        if text.startswith("[system · waking]"):
            if self.fail_wake:
                raise RuntimeError("wake failed")
            return "…continuing"
        if text.startswith("[system"):
            return self.pack_reply
        return "reply"

    @property
    def session_id(self):
        return self.sid

    @property
    def ctx_tokens(self):
        return self.ctx


async def run():
    t = Thresholds(window=1000)     # soft 700 / hard 850 / safety 900
    assert (t.soft, t.hard, t.safety) == (700, 850, 900)
    big = Thresholds(window=1_000_000)
    assert (big.soft, big.hard) == (400_000, 600_000), "absolute caps win on big windows"

    # 1. Normal life: below lines → no sleep.
    s = FakeSession()
    await s.connect(None)
    audits = []
    m = SleepManager(s, t, on_audit=audits.append)
    s.ctx = 100
    assert await m.turn("hi") == "reply" and m.sleep_count == 0

    # 2. Hard line crossed → sleeps, new session, audit written.
    s.ctx = 860
    old = s.sid
    await m.turn("more")
    assert m.sleep_count == 1 and s.sid != old
    assert audits and audits[0].trigger == "hard" and audits[0].ctx_before == 860

    # 3. Hold defers the hard line…
    s.ctx = 860
    m.hold(3600)
    await m.turn("held")
    assert m.sleep_count == 1, "hold should defer hard-line sleep"
    # …but never the safety line.
    s.ctx = 950
    await m.turn("critical")
    assert m.sleep_count == 2, "safety line must override hold"

    # 4. Short pack + below safety → stays awake, no sleep.
    s2 = FakeSession()
    await s2.connect(None)
    m2 = SleepManager(s2, t)
    s2.pack_reply = "stub"
    s2.ctx = 860
    await m2.turn("x")
    assert m2.sleep_count == 0 and m2.state in ("awake", "drowsy")

    # 5. Short pack + past safety → sleeps anyway with placeholder note.
    s2.ctx = 950
    await m2.turn("y")
    assert m2.sleep_count == 1

    # 6. Wake failure → rollback to old session, sleep voided.
    s3 = FakeSession()
    await s3.connect(None)
    m3 = SleepManager(s3, t)
    s3.ctx = 860
    s3.fail_wake = True
    old = s3.sid
    await m3.turn("z")
    assert m3.sleep_count == 0 and s3.sid == old, "must resume old session on wake failure"

    # 7. Verbatim lines are bounded.
    for i in range(20):
        s3.ctx = 10
        await m3.turn(f"line{i}")
    assert len(m3.recent_user) == m3.VERBATIM_KEEP

    print("all somnus tests passed ✓")


if __name__ == "__main__":
    asyncio.run(run())
