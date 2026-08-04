// Drives — integrator, ledger, felt-sense rendering, interoceptive push.
//
//   dx/dt = A∘(b_eff − x) + κ·tanh(W·(x − b)) + u(t)
//   b_eff = clamp01(b + i_clock)
//
// Explicit Euler, 15-minute steps. Under 100 lines of actual math by design:
// the requirement is legibility (the config is the personality table), not
// numerical accuracy.

import {
  DIMS, TICK_MINUTES, EVENT_CLAMP, TRACE_KEEP_DAYS,
  A, B, W, KAPPA, CLOCK, RENDER, FELT, PUSH,
} from './config.js';

const clamp01 = v => Math.max(0, Math.min(1, v));
const clampEv = v => Math.max(-EVENT_CLAMP, Math.min(EVENT_CLAMP, v));

export function createDrives(db, host, opts = {}) {
  // onPush(phrase, dim, from, to): delivered to the resident session by the host.
  const onPush = opts.onPush || (() => {});

  const getSetting = k => db.prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value ?? null;
  const setSetting = (k, v) =>
    db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?').run(k, v, v);

  const isOff = () => getSetting('drives_off') === '1';

  function ensure() {
    const ins = db.prepare('INSERT OR IGNORE INTO drives (dim, value, updated_at) VALUES (?,?,?)');
    const now = Date.now();
    for (const d of DIMS) ins.run(d, B[d] ?? 0.2, now);
  }

  function state() {
    ensure();
    const x = {};
    for (const r of db.prepare('SELECT dim, value FROM drives').all()) x[r.dim] = r.value;
    return x;
  }

  // The agent's pen, and the clock's. Both write here; nothing bypasses it.
  function logEvent(dim, delta, reason, source) {
    if (!DIMS.includes(dim)) throw new Error(`no such dimension: ${dim}`);
    db.prepare('INSERT INTO drive_events (at, dim, delta, reason, source) VALUES (?,?,?,?,?)')
      .run(Date.now(), dim, clampEv(delta), String(reason || '').slice(0, 200), source);
  }

  // Loop closure = satisfaction (wanting drops, liking persists as the memory card).
  function satisfyByResolve(itemId) {
    logEvent('SEEKING', -CLOCK.RESOLVE_SEEKING, `closed a loop (${String(itemId).slice(0, 8)})`, 'clock:resolve');
    logEvent('CARE', +CLOCK.RESOLVE_CARE, 'softening after satisfaction', 'clock:resolve');
  }

  // --- clock-side continuous inputs (objective facts only) -------------------

  function hourIn(tz, now) {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(now)));
  }

  function clockInputs(now) {
    const i = {};
    const lu = host.lastUserAt();
    if (lu) {
      const gapH = Math.min((now - lu) / 3600000, CLOCK.GAP_CAP_H);
      const h = hourIn(CLOCK.TIMEZONE, now);
      const night = h >= CLOCK.NIGHT_HOURS[0] && h < CLOCK.NIGHT_HOURS[1];
      i.PANIC = CLOCK.K_GAP * (gapH / CLOCK.GAP_CAP_H) * (night ? CLOCK.NIGHT_FACTOR : 1);
    }
    const weights = (host.openLoopWeights() || []).slice(0, CLOCK.UNRES_TOPK);
    const sum = weights.reduce((s, w) => s + (w || 3), 0);
    i.SEEKING = CLOCK.K_UNRES * Math.log1p(sum) / Math.log1p(CLOCK.UNRES_NORM);
    return i;
  }

  function activityDelta(now) {
    const c = host.messagesSince(now - TICK_MINUTES * 60000) || 0;
    return Math.min(CLOCK.K_MSG * c, CLOCK.MSG_CAP);
  }

  function detectSleep() {
    const marker = host.sleepMarker() || 0;
    const seen = Number(getSetting('drives_sleep_seen') || 0);
    if (marker > seen) {
      setSetting('drives_sleep_seen', String(marker));
      if (seen > 0) logEvent('fatigue', -CLOCK.SLEEP_RELIEF, 'slept', 'clock:sleep');
    }
  }

  // --- felt sense ------------------------------------------------------------

  const band = v => (v >= 0.85 ? 2 : v >= 0.70 ? 1 : 0);

  function feltSense(x = null) {
    if (isOff()) return null;
    const s = x || state();
    const hot = DIMS
      .filter(d => !RENDER.exclude.includes(d) && s[d] >= RENDER.threshold)
      .sort((a, b) => s[b] - s[a])
      .slice(0, RENDER.maxDims);
    const lines = hot.map(d => FELT[d]?.[band(s[d])]).filter(Boolean);
    return lines.length ? lines.join('; ') : null;
  }

  // --- interoceptive push: by change, not by value ---------------------------

  function maybePush(prev, next, now) {
    let st = {};
    try { st = JSON.parse(getSetting('drives_push_state') || '{}'); } catch {}
    if (st._last && now - st._last < PUSH.GLOBAL_COOLDOWN_MIN * 60000) return;
    const TH = RENDER.threshold;
    for (const d of DIMS) {
      if (RENDER.exclude.includes(d)) continue;
      const s = st[d] || { armed: true, lastPush: 0 };
      if (!s.armed && next[d] < TH - PUSH.HYST) s.armed = true;      // re-arm on falling back
      const crossed = prev[d] < TH && next[d] >= TH;
      const jumped = next[d] >= TH && Math.abs(next[d] - prev[d]) >= PUSH.JUMP;
      if (s.armed && (crossed || jumped) && now - s.lastPush >= PUSH.DIM_COOLDOWN_MIN * 60000) {
        const phrase = FELT[d]?.[band(next[d])];
        if (phrase) {
          st[d] = { armed: false, lastPush: now };
          st._last = now;
          setSetting('drives_push_state', JSON.stringify(st));
          onPush(phrase, d, prev[d], next[d]);
          return;                                                     // at most one per tick
        }
      }
      st[d] = s;
    }
    setSetting('drives_push_state', JSON.stringify(st));
  }

  // --- the tick --------------------------------------------------------------

  function tick(now = Date.now()) {
    if (isOff()) return null;
    ensure();
    detectSleep();

    const x = state();
    const dt = TICK_MINUTES / 60;
    const iClock = clockInputs(now);

    // consume unapplied ledger impulses (missed ticks catch up; nothing is lost)
    const pending = db.prepare('SELECT id, dim, delta FROM drive_events WHERE applied=0').all();
    const impulse = {};
    for (const e of pending) impulse[e.dim] = (impulse[e.dim] || 0) + clampEv(e.delta);

    // coupling: each target feels the source's deviation from its own baseline
    const couple = {};
    for (const { from, to, w } of W) {
      couple[to] = (couple[to] || 0) + w * ((x[from] ?? B[from]) - B[from]) * 2;
    }

    const next = {};
    for (const d of DIMS) {
      const bEff = clamp01((B[d] ?? 0.2) + (iClock[d] || 0));
      let v = x[d]
        + dt * ((A[d] ?? 0.1) * (bEff - x[d]) + KAPPA * Math.tanh(couple[d] || 0))
        + (impulse[d] || 0);
      if (d === 'fatigue') v += activityDelta(now);
      next[d] = clamp01(v);
    }

    try { maybePush(x, next, now); } catch { /* awareness must never break the tick */ }

    db.exec('BEGIN');                       // node:sqlite has no .transaction()
    try {
      const up = db.prepare('UPDATE drives SET value=?, updated_at=? WHERE dim=?');
      const mark = db.prepare('UPDATE drive_events SET applied=1 WHERE id=?');
      for (const d of DIMS) up.run(next[d], now, d);
      for (const e of pending) mark.run(e.id);
      db.prepare('INSERT INTO drive_trace (at, state) VALUES (?,?)').run(now, JSON.stringify(next));
      db.prepare('DELETE FROM drive_trace WHERE at < ?').run(now - TRACE_KEEP_DAYS * 86400000);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return next;
  }

  // dashboard payload: numbers for the maintainer, phrase for the agent
  function dashboard() {
    const now = state();
    return {
      off: isOff(),
      now,
      felt: feltSense(now),
      trace: db.prepare('SELECT at, state FROM drive_trace WHERE at >= ? ORDER BY at ASC')
        .all(Date.now() - 48 * 3600000)
        .map(r => ({ at: r.at, ...JSON.parse(r.state) })),
      events: db.prepare('SELECT at, dim, delta, reason, source FROM drive_events ORDER BY at DESC LIMIT 100').all(),
      config: { b: B, renderThreshold: RENDER.threshold, tickMinutes: TICK_MINUTES },
    };
  }

  return { tick, state, logEvent, satisfyByResolve, feltSense, dashboard, isOff };
}
