// Scheduled dispatcher (PLAN.MD §1.7): the asyncio loops collapse into
// one cron tick. Sources run sequentially under a 180 s deadline guard, and
// the start order rotates by tick number so a slow source can't starve the
// others. Worst case is delayed — never lost — alerts (cursor semantics).
//
// Not every source runs on every tick — see schedule.ts for the per-source
// polling intervals.

import type { Env } from "../env";
import { withTimeout } from "../shared/deadline";
import { TICK_MINUTES, isDue } from "./schedule";
import * as epro from "./sources/epro";
import * as heating from "./sources/heating";
import * as vik from "./sources/vik";
import * as vt from "./sources/vt";

const SOURCES: Array<{ name: string; run: (env: Env, deadline: number) => Promise<void> }> = [
  { name: "vik", run: vik.run },
  { name: "heating", run: heating.run },
  { name: "epro", run: epro.run },
  { name: "vt", run: vt.run },
];

// The 25 s the plan first assumed was conservative: scheduled handlers get up
// to ~15 min of wall clock (only CPU is capped at 10 ms, and the AI/Overpass/
// Nominatim hops are all I/O — see spikes/RESULTS.md). The budget exists to
// keep a tick well inside the 15-min cron cadence so the next tick never
// overlaps this one (the cursor/state model assumes one writer per source at a
// time), NOT because the platform kills at 30 s. 180 s gives the AI room to
// wait out its I/O — a qwen3 parse runs 4–21 s, and a message may need a retry
// or two — without raising MAX_MESSAGES_PER_TICK.
const DEADLINE_MS = 180_000;
const TICK_INTERVAL_MS = TICK_MINUTES * 60 * 1000;

export async function runIngestion(env: Env): Promise<void> {
  const now = Date.now();
  const deadline = now + DEADLINE_MS;
  const tick = Math.floor(now / TICK_INTERVAL_MS);
  const rotated = [...SOURCES.slice(tick % SOURCES.length), ...SOURCES.slice(0, tick % SOURCES.length)];

  // Index in SOURCES (not the rotated order) is the stagger phase, so a
  // source's due ticks don't shift as the rotation moves.
  const order = rotated.filter((s) => isDue(s.name, SOURCES.indexOf(s), now));
  if (order.length === 0) {
    console.log("[runner] No source due this tick.");
    return;
  }

  for (const source of order) {
    if (Date.now() >= deadline) {
      console.warn(`[runner] Deadline reached before '${source.name}' — it runs when next due.`);
      break;
    }
    const startedAt = Date.now();
    try {
      // Belt-and-braces on top of the deadlines threaded into the source: a
      // source that somehow blocks past the budget must not take the remaining
      // sources down with it, so the whole tick finishes well inside the 15-min
      // cron cadence and the next tick never overlaps it.
      await withTimeout(source.run(env, deadline), deadline - startedAt, undefined, `source '${source.name}'`);
    } catch (e) {
      console.error(`[runner] Source '${source.name}' failed after ${Date.now() - startedAt} ms: ${e}`);
    }
  }
}

/**
 * Daily cron (30 3 * * *): §1.10 retention jobs.
 *
 * Each job is independent, so one failure must not skip the rest — retention
 * deletions that silently stop running are how a 500 MB D1 fills up.
 */
export async function runDailyCleanup(env: Env): Promise<void> {
  const cutoff = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const jobs: Array<{ label: string; sql: string; cutoffDays: number }> = [
    { label: "old alert(s)", sql: "DELETE FROM alerts WHERE created_on_utc < ?", cutoffDays: 90 },
    { label: "geocode cache row(s)", sql: "DELETE FROM geocode_cache WHERE resolved_at < ?", cutoffDays: 180 },
    // Verification/reset links (migration 0006). They stop working at
    // expires_at; the row is kept a day longer only so an "already used" click
    // still lands on a sensible page rather than looking unknown.
    { label: "expired auth token(s)", sql: "DELETE FROM auth_tokens WHERE expires_at < ?", cutoffDays: 1 },
    // Spent and expired sessions (migration 0007). Rotated rows are kept a week
    // so replay detection still recognises a leaked chain instead of treating
    // it as an unknown token; past that, the family is long dead anyway.
    { label: "expired refresh token(s)", sql: "DELETE FROM refresh_tokens WHERE expires_at < ?", cutoffDays: 0 },
    { label: "spent refresh token(s)", sql: "DELETE FROM refresh_tokens WHERE used_at IS NOT NULL AND used_at < ?", cutoffDays: 7 },
  ];

  for (const job of jobs) {
    try {
      const { meta } = await env.DB.prepare(job.sql).bind(cutoff(job.cutoffDays)).run();
      console.log(`[cleanup] removed ${meta.changes} ${job.label}`);
    } catch (e) {
      console.error(`[cleanup] failed to remove ${job.label}: ${e}`);
    }
  }
}
