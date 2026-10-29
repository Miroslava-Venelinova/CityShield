// Source silence (docs/specification.md §3.8, migration 0022): telling a quiet
// source from one whose parser has stopped recognising the page.
//
// A layout change makes a parser find nothing, and nothing reads exactly like a
// quiet day. Both source-side outages so far (epro's API change, ViK's
// region-scoped listing) looked healthy in the logs, and heating was dead for
// ~18 days from 13.08.2026 with nothing said. So every run reports what its
// parser found, the tick records it in D1, and a source is SILENT once it has
// found nothing for longer than its own normal quiet spell.
//
// This is the per-source cousin of the 6 h cursor-stall check in runner.ts. A
// cursor cannot tell the two cases apart — heating's cursor stands still for
// days by design — but "did the parser recognise anything" can, because most
// sources' parsers see far more than what is new.

import { recordSourceRun, type SourceHealthRow } from "../db/queries";
import type { Env } from "../env";

/**
 * What one run of a source's parser found.
 *
 *   `items`        it recognised at least one thing: listing links (heating),
 *                  accordion entries (vt), interruption entries (epro) or newly
 *                  published messages (vik — see SOURCE_QUIET_HOURS)
 *   `empty`        the page was fetched and parsed, and held nothing
 *   `parse_error`  the parser did not recognise the page (or a message on it)
 *   `fetch_error`  the source could not be reached
 *
 * A run reports the first failure it hit, else what it found. Failures past the
 * parser (the AI, the store, a push) are not the source's and do not count.
 */
export type SourceObservation =
  | { outcome: "items"; items: number }
  | { outcome: "empty" }
  | { outcome: "parse_error" | "fetch_error"; detail: string };

/** The observation for a parser that found `n` things. */
export const found = (n: number): SourceObservation =>
  n > 0 ? { outcome: "items", items: n } : { outcome: "empty" };

/**
 * How long each source may find nothing before it is called silent, in hours.
 *
 * Recorded as ranges in §3.8; each value is chosen inside its range, toward the
 * end that cries wolf less. What counts as an item matters more than how often
 * the source publishes:
 *
 * - `heating` — items are the links on the listing, an archive (15 in the
 *   captured page), so it is never legitimately empty. Polled every 4 h; 24 h is
 *   six polls of slack for a flaky site. Works anywhere in 8–48 h. The
 *   13.08.2026 outage ran 18 days.
 * - `epro` — items are the region's active-interruption lists, which carry
 *   planned cuts days ahead; 93 alerts in 02–08.08.2026 (~13 a day). Works
 *   anywhere in 12–48 h.
 * - `vik` — the id probe sees only NEW messages, so here the publishing rate
 *   decides: 36 in 02–08.08.2026 (~5 a day), but nights and weekends are
 *   unmeasured. 48 h is the conservative end of 24–72 h.
 * - `vt` — items are the accordion entries (5 in the captured page); whether
 *   the page can be legitimately empty is unmeasured. 72 h is a conservative
 *   default inside 48 h–7 d, not a measurement.
 */
export const SOURCE_QUIET_HOURS: Record<string, number> = {
  vik: 48,
  epro: 24,
  heating: 24,
  vt: 72,
};

/** For a source missing from the table — conservative, like vik's. */
export const DEFAULT_QUIET_HOURS = 48;

export const quietHoursFor = (source: string): number =>
  SOURCE_QUIET_HOURS[source] ?? DEFAULT_QUIET_HOURS;

export interface SilenceAssessment {
  /** Hours since the parser last found anything — or since the first recorded run, if it never has. */
  hours_without_items: number | null;
  quiet_limit_hours: number;
  silent: boolean;
}

/** Judge one source_health row against its source's quiet spell. */
export function assessSilence(row: SourceHealthRow, now: number = Date.now()): SilenceAssessment {
  const since = Date.parse(row.items_at ?? row.first_run_at);
  const limit = quietHoursFor(row.source);
  const hours = Number.isFinite(since) ? (now - since) / 3_600_000 : null;
  return {
    hours_without_items: hours === null ? null : +hours.toFixed(2),
    quiet_limit_hours: limit,
    silent: hours !== null && hours > limit,
  };
}

/**
 * Record a run's observation, and say so loudly if the source has now been
 * silent past its quiet spell.
 *
 * Swallows its own failures: this is a monitor, and a monitor that can break
 * ingestion is worse than none. One upsert per source run, which also returns
 * the row, so judging silence costs no extra read. The log line is the
 * convenience; the durable signal is the row, which /api/health reads.
 */
export async function recordObservation(
  env: Env, source: string, observation: SourceObservation,
): Promise<void> {
  try {
    const row = await recordSourceRun(
      env, source, observation.outcome,
      observation.outcome === "items" ? observation.items : null,
      "detail" in observation ? observation.detail.slice(0, 500) : null);
    if (row === null) return;
    const { silent, hours_without_items, quiet_limit_hours } = assessSilence(row);
    if (!silent) return;
    console.error(
      `[runner] Source '${source}' has found NOTHING for ${hours_without_items} h, past its `
      + `${quiet_limit_hours} h quiet spell (last run: ${row.outcome}`
      + `${row.detail ? ` — ${row.detail}` : ""}). A layout change on the source looks exactly `
      + `like this; check the page against its parser in scrape.ts.`);
  } catch (e) {
    console.warn(`[runner] Recording '${source}' source health failed: ${e}`);
  }
}
