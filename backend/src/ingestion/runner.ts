// Scheduled dispatcher (docs/specification.md §1.7): the asyncio loops collapse into
// one cron tick. Sources run sequentially under a 5 min deadline guard, and
// the start order rotates by tick number so a slow source can't starve the
// others. Worst case is delayed — never lost — alerts (cursor semantics).
//
// Not every source runs on every tick — see schedule.ts for the per-source
// polling intervals.

import { markTickCompleted, markTickStarted, RETENTION_JOBS, runRetentionJob } from "../db/queries";
import type { Env } from "../env";
import { withTimeout } from "../shared/deadline";
import { TICK_MINUTES, isDue } from "./schedule";
import { recordObservation, type SourceObservation } from "./silence";
import { getLastIdUpdatedAt } from "./state";
import * as epro from "./sources/epro";
import * as heating from "./sources/heating";
import * as vik from "./sources/vik";
import * as vt from "./sources/vt";

/**
 * A source runs, and reports what its parser found (silence.ts) — or null when
 * it never got to look, e.g. its cursor was unreadable.
 */
export type SourceRun = (env: Env, deadline: number) => Promise<SourceObservation | null>;

const SOURCES: Array<{ name: string; run: SourceRun }> = [
  { name: "vik", run: vik.run },
  { name: "heating", run: heating.run },
  { name: "epro", run: epro.run },
  { name: "vt", run: vt.run },
];

// The 25 s the plan first assumed was conservative: scheduled handlers get up
// to ~15 min of wall clock (only CPU is capped at 10 ms, and the AI/
// Nominatim hops are all I/O — see spikes/RESULTS.md). The budget exists to
// keep a tick well inside the 15-min cron cadence so the next tick never
// overlaps this one (the cursor/state model assumes one writer per source at a
// time), NOT because the platform kills at 30 s. 5 min gives the AI room to
// wait out its I/O — a qwen3 parse runs 4–21 s, and a message may need a retry
// or two — without raising MAX_MESSAGES_PER_TICK. It still leaves a 10-min gap
// before the next 15-min tick, so two ticks can never overlap.
const DEADLINE_MS = 300_000;
const TICK_INTERVAL_MS = TICK_MINUTES * 60 * 1000;

export async function runIngestion(env: Env, sources = SOURCES): Promise<void> {
  const now = Date.now();
  const deadline = now + DEADLINE_MS;
  const tick = Math.floor(now / TICK_INTERVAL_MS);
  const rotated = [...sources.slice(tick % sources.length), ...sources.slice(0, tick % sources.length)];

  // Index in SOURCES (not the rotated order) is the stagger phase, so a
  // source's due ticks don't shift as the rotation moves.
  const order = rotated.filter((s) => isDue(s.name, sources.indexOf(s), now));
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
      const observed = await withTimeout(
        source.run(env, deadline), deadline - startedAt, undefined, `source '${source.name}'`);
      // Recorded straight after the source, not at the end of the tick: a later
      // source killed on the CPU cap must not take this one's record with it.
      // A source that threw or timed out records nothing, so its silence clock
      // keeps running — which is right, since nobody saw it parse anything.
      if (observed) await recordObservation(env, source.name, observed);
    } catch (e) {
      console.error(`[runner] Source '${source.name}' failed after ${Date.now() - startedAt} ms: ${e}`);
    }
  }

  await warnOnStalledCursors(env);
}

/**
 * One ingest cron tick, bracketed by the D1 heartbeat.
 *
 * The heartbeat is written to D1, not to the log stream: an `exceededCpu` kill
 * discards the invocation's logs, so the one signal that a tick died is the one
 * that must not live in them (migration 0019). `started_at` is committed before
 * any parsing; `completed_at` only if ingestion returns normally — a tick that
 * threw did not complete either, and must read as unfinished on /api/health
 * just as a killed one does. Both are I/O, so neither adds meaningfully to the
 * 10 ms CPU burst they report on.
 *
 * Never throws: each step reports its own failure, and a heartbeat write that
 * fails must not stop the ingestion it brackets.
 *
 * `ingest` is injectable for tests; it defaults to runIngestion.
 */
export async function runIngestTick(
  env: Env, cron: string, ingest: (env: Env) => Promise<void> = runIngestion,
): Promise<void> {
  try {
    await markTickStarted(env, cron);
  } catch (e) {
    console.error(`[runner] Tick heartbeat (start) failed: ${e}`);
  }

  const startedAt = Date.now();
  try {
    await ingest(env);
  } catch (e) {
    console.error(`[runner] Ingestion failed; the tick is left unfinished: ${e}`);
    return;
  }

  try {
    await markTickCompleted(env, cron, Date.now() - startedAt);
  } catch (e) {
    console.error(`[runner] Tick heartbeat (end) failed: ${e}`);
  }
}

/**
 * How long a source's cursor may sit still before the tick says so.
 *
 * The cheap half of the cursor-pin problem (§4.1). The crawler is oldest-first
 * and advances only past successes, so a pinned cursor produces no errors —
 * every tick reads the same message, fails the same way, and writes nothing.
 * On 30.07.2026 a single over-budget message turned into a 20-hour ingestion
 * outage and six unsent ViK outages, and the only reason anyone found out was
 * that someone went looking.
 *
 * The bound itself now exists: MAX_PRE_STORE_ATTEMPTS (state.ts, migration
 * 0018) gives up on a message after five strikes and moves the cursor past it,
 * so the same failure costs one message rather than the source. This stays as
 * the narrower check it always was — five strikes is ~75 minutes, and a source
 * that is quiet for six hours for any *other* reason is still worth saying so.
 *
 * One thing it cannot do is survive the failure it most needs to report: an
 * `exceededCpu` kill discards the invocation's logs, so on 28.08.2026 this
 * warning was written into a log stream that was thrown away. That is what the
 * D1 heartbeat and /api/health are for (migration 0019) — this remains the
 * convenient version for anyone already reading a tail.
 *
 * 6 hours is chosen against the quietest source rather than the busiest: vt and
 * heating publish a handful of items a week, so anything tighter would cry wolf
 * on an ordinary quiet night. It is well inside the 20-hour outage it exists to
 * catch.
 */
const CURSOR_STALL_MS = 6 * 60 * 60 * 1000;

/**
 * Warn for every source whose cursor has not moved in CURSOR_STALL_MS.
 *
 * Deliberately at the end of the tick and deliberately swallowing its own
 * failures: this is a monitor, and a monitor that can break ingestion is worse
 * than no monitor. One read per source, on a 15-minute cadence.
 */
async function warnOnStalledCursors(env: Env): Promise<void> {
  try {
    const now = Date.now();
    for (const source of SOURCES) {
      const updatedAt = await getLastIdUpdatedAt(env, source.name);
      if (updatedAt === null) continue; // no row yet — the source has never run
      const age = now - Date.parse(updatedAt);
      if (Number.isFinite(age) && age > CURSOR_STALL_MS) {
        console.error(
          `[runner] Source '${source.name}' has not advanced its cursor in `
          + `${(age / 3_600_000).toFixed(1)} h (since ${updatedAt}). Either it has published `
          + `nothing, or one message is failing before the store and pinning the cursor — `
          + `check the tick logs for that source.`);
      }
    }
  } catch (e) {
    console.warn(`[runner] Stall check failed: ${e}`);
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

  // The jobs and their retention periods live beside the rest of the SQL
  // (db/queries.ts RETENTION_JOBS).
  for (const job of RETENTION_JOBS) {
    try {
      const removed = await runRetentionJob(env, job, cutoff(job.cutoffDays));
      console.log(`[cleanup] removed ${removed} ${job.label}`);
    } catch (e) {
      console.error(`[cleanup] failed to remove ${job.label}: ${e}`);
    }
  }
}
