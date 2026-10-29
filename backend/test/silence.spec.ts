// Source silence (ingestion/silence.ts, migration 0022).
//
// A layout change makes a parser find nothing, and nothing reads exactly like a
// quiet day. Both source-side outages so far (epro's API change, ViK's
// region-scoped listing) looked healthy in the logs, and heating was dead for
// ~18 days from 13.08.2026 with nothing said. These pin the clock that tells a
// quiet source from a blind one.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceHealthRows, type SourceHealthRow } from "../src/db/queries";
import {
  assessSilence, DEFAULT_QUIET_HOURS, found, quietHoursFor, recordObservation, SOURCE_QUIET_HOURS,
} from "../src/ingestion/silence";

const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const row = (over: Partial<SourceHealthRow>): SourceHealthRow => ({
  source: "heating", first_run_at: iso(1000 * HOUR), run_at: iso(0), outcome: "empty",
  items: null, detail: null, items_at: null, ...over,
});

async function healthOf(source: string): Promise<SourceHealthRow> {
  return (await getSourceHealthRows(env)).find((r) => r.source === source)!;
}

describe("quiet spells", () => {
  it("has one for every crawled source, longer than its polling interval", () => {
    // heating and vt poll every 4 h: a threshold under ~2 polls would fire on
    // one flaky fetch.
    expect(Object.keys(SOURCE_QUIET_HOURS).sort()).toEqual(["epro", "heating", "vik", "vt"]);
    for (const hours of Object.values(SOURCE_QUIET_HOURS)) expect(hours).toBeGreaterThanOrEqual(8);
    expect(quietHoursFor("something-new")).toBe(DEFAULT_QUIET_HOURS);
  });

  it("calls a source silent only past its own quiet spell", () => {
    const limit = SOURCE_QUIET_HOURS.heating!;
    expect(assessSilence(row({ items_at: iso((limit - 1) * HOUR) })).silent).toBe(false);
    const past = assessSilence(row({ items_at: iso((limit + 1) * HOUR) }));
    expect(past.silent).toBe(true);
    expect(past.quiet_limit_hours).toBe(limit);
    expect(past.hours_without_items).toBeGreaterThan(limit);
  });

  it("starts the clock at the first run for a source that has never found anything", () => {
    expect(assessSilence(row({ first_run_at: iso(HOUR), items_at: null })).silent).toBe(false);
    expect(assessSilence(row({ first_run_at: iso(100 * HOUR), items_at: null })).silent).toBe(true);
  });

  it("judges by the source's own spell: 30 h is quiet for vik, silent for epro", () => {
    const at = iso(30 * HOUR);
    expect(assessSilence(row({ source: "vik", items_at: at })).silent).toBe(false);
    expect(assessSilence(row({ source: "epro", items_at: at })).silent).toBe(true);
  });
});

describe("recordObservation", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM source_health").run();
  });
  afterEach(() => vi.restoreAllMocks());

  it("moves items_at only on a run that found something", async () => {
    await recordObservation(env, "vt", found(5));
    const first = await healthOf("vt");
    expect(first).toMatchObject({ outcome: "items", items: 5, detail: null });
    expect(first.items_at).toBe(first.run_at);

    await new Promise((r) => setTimeout(r, 5));
    await recordObservation(env, "vt", { outcome: "parse_error", detail: "page: #infoAccordion not found" });
    const second = await healthOf("vt");
    expect(second).toMatchObject({ outcome: "parse_error", items: null, detail: "page: #infoAccordion not found" });
    // The clock keeps running from the last real find.
    expect(second.items_at).toBe(first.items_at);
    expect(second.run_at > first.run_at).toBe(true);
    expect(second.first_run_at).toBe(first.first_run_at);

    await recordObservation(env, "vt", found(0));
    expect(await healthOf("vt")).toMatchObject({ outcome: "empty", items_at: first.items_at });
  });

  // The whole point: a parser that stopped recognising the page, logged loudly
  // so a tail shows it — the durable signal is the row /api/health reads.
  it("says so loudly once the source is silent past its spell", async () => {
    await recordObservation(env, "heating", found(15));
    await env.DB.prepare("UPDATE source_health SET items_at = ? WHERE source = 'heating'")
      .bind(iso(30 * HOUR)).run();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordObservation(env, "heating", { outcome: "parse_error", detail: "listing: no message links recognised" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Source 'heating' has found NOTHING"));
    expect(error.mock.calls[0]![0]).toContain("listing: no message links recognised");
  });

  it("stays quiet about a source inside its spell", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordObservation(env, "epro", found(0));
    expect(error).not.toHaveBeenCalled();
  });

  it("never throws — a monitor must not break the ingestion it watches", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as typeof env;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(recordObservation(broken, "vik", found(1))).resolves.toBeUndefined();
  });
});
