// Operational health, readable without wrangler (docs/specification.md §3.8).
//
// This exists because the two things an operator needs during an ingest outage
// were both unreachable. The stalled-cursor alarm was a console.error, and an
// `exceededCpu` kill discards the invocation's logs; and historical logs are
// not queryable at all, because the wrangler token lacks the Workers
// Observability scopes. On 28.08.2026 that combination meant the outage could
// only be bounded by the timestamp of the newest stored alert.
//
// Everything here is a plain SELECT over rows written by the tick itself, so it
// reports on failures that destroyed their own logs. Three signals:
//
//   1. started_at newer than completed_at → the tick that started never
//      finished. That is the exceededCpu signature, and previously it was only
//      visible as a `cpuTime` sitting exactly on 10 ms in a live tail.
//   2. a cursor that has not moved in hours → the source is wedged, or quiet.
//   3. skipped messages → the pre-store attempt cap gave up on something and a
//      human should know which (migration 0018).
//   4. a SILENT source → its parser has found nothing for longer than that
//      source's normal quiet spell, which is what a layout change on the site
//      looks like (migration 0022, ingestion/silence.ts).
//
// For an external uptime checker, `silent_sources` is the field to watch: an
// empty array is healthy. `status` also folds in the 6 h cursor check, which
// heating and vt trip on any ordinary quiet week.

import { Hono } from "hono";
import {
  getCrawlStateRows, getIngestHealth, getSkippedIngests, getSourceHealthRows,
} from "../db/queries";
import { assessSilence } from "../ingestion/silence";
import type { AppEnv } from "./middleware";

export const healthRoutes = new Hono<AppEnv>();

/** How long a cursor may sit still before this route calls it stalled. */
const CURSOR_STALL_MS = 6 * 60 * 60 * 1000;

/** Most recent skipped messages to list. Enough to see a pattern, bounded. */
const SKIPPED_LIMIT = 20;

const hoursSince = (iso: string | null): number | null => {
  if (iso === null) return null;
  const age = Date.now() - Date.parse(iso);
  return Number.isFinite(age) ? +(age / 3_600_000).toFixed(2) : null;
};

healthRoutes.get("/", async (c) => {
  const [health, cursors, skipped, runs] = await Promise.all([
    getIngestHealth(c.env),
    getCrawlStateRows(c.env),
    getSkippedIngests(c.env, SKIPPED_LIMIT),
    getSourceHealthRows(c.env),
  ]);

  const ticks = health.map((row) => ({
    cron: row.cron,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_duration_ms: row.last_duration_ms,
    // The whole point of the table. A tick writes started_at before it parses
    // anything and completed_at only at the end, so a start with no later
    // completion is a tick that was killed part-way — which is what an
    // exceededCpu kill looks like from the outside, logs and all having been
    // discarded with it.
    started_but_never_completed:
      row.completed_at === null || Date.parse(row.started_at) > Date.parse(row.completed_at),
    hours_since_start: hoursSince(row.started_at),
    hours_since_completion: hoursSince(row.completed_at),
  }));

  const sources = cursors.map((row) => ({
    source: row.source,
    last_id: row.last_id,
    updated_at: row.updated_at,
    hours_since_cursor_moved: hoursSince(row.updated_at),
    // A quiet source and a wedged one look the same from here; the skipped list
    // below and the tick rows above are what tell them apart.
    stalled: Date.now() - Date.parse(row.updated_at) > CURSOR_STALL_MS,
  }));

  // Judged here from timestamps, not read from a flag the tick wrote: a source
  // whose every run is killed never writes again, and must still turn silent.
  const sourceRuns = runs.map((row) => ({
    source: row.source,
    last_run_at: row.run_at,
    last_outcome: row.outcome,
    last_items: row.items,
    last_detail: row.detail,
    items_found_at: row.items_at,
    ...assessSilence(row),
  }));
  const silentSources = sourceRuns.filter((s) => s.silent).map((s) => s.source);

  const degraded = ticks.some((t) => t.started_but_never_completed)
    || sources.some((s) => s.stalled)
    || silentSources.length > 0;

  return c.json({
    status: degraded ? "degraded" : "ok",
    checked_at: new Date().toISOString(),
    // The layout-change alarm. Empty when every source's parser has found
    // something within its quiet spell.
    silent_sources: silentSources,
    ticks,
    sources,
    source_runs: sourceRuns,
    // Messages the pre-store cap gave up on: deliberately not delivered, and
    // the one thing here that no other signal would ever surface.
    skipped_messages: skipped.map((row) => ({
      source: row.source,
      ref: row.ref,
      attempts: row.attempts,
      skipped_at: row.skipped_at,
    })),
  });
});
