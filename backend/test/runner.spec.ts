// The ingest tick's heartbeat bracketing (runIngestTick in ingestion/runner.ts).
//
// completed_at is the "this tick finished" half of the signal /api/health reads
// (health.spec.ts). A tick whose ingestion threw did not finish, so it must
// leave completed_at alone exactly as a killed tick does. It used not to: the
// scheduled handler's error wrapper swallowed the failure and the completion
// was written anyway.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getIngestHealth, getSourceHealthRows } from "../src/db/queries";
import { runIngestion, runIngestTick } from "../src/ingestion/runner";
import { found } from "../src/ingestion/silence";

const CRON = "*/15 * * * *";

describe("runIngestTick", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ingest_health").run();
  });

  it("marks the tick completed when ingestion returns", async () => {
    await runIngestTick(env, CRON, async () => {});
    const [row] = await getIngestHealth(env);
    expect(row!.started_at).toBeTruthy();
    expect(row!.completed_at).toBeTruthy();
  });

  it("leaves the tick unfinished, and does not throw, when ingestion throws", async () => {
    await expect(runIngestTick(env, CRON, async () => { throw new Error("boom"); }))
      .resolves.toBeUndefined();
    const [row] = await getIngestHealth(env);
    expect(row!.started_at).toBeTruthy();
    expect(row!.completed_at).toBeNull();
  });
});

// Source silence (silence.ts, migration 0022): each source's observation is
// recorded as soon as that source returns, so a later source killed on the CPU
// cap cannot take an earlier one's record down with it.
describe("runIngestion records what each source's parser found", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM source_health").run();
  });

  it("records an observation per source, and nothing for one that threw", async () => {
    // Names outside SOURCE_INTERVAL_MINUTES poll at the tick rate, so all are due.
    await runIngestion(env, [
      { name: "test-items", run: async () => found(3) },
      { name: "test-broken", run: async () => ({ outcome: "parse_error", detail: "layout changed" }) },
      { name: "test-threw", run: async () => { throw new Error("boom"); } },
      { name: "test-skipped", run: async () => null },
    ]);

    const rows = await getSourceHealthRows(env);
    expect(rows.map((r) => r.source)).toEqual(["test-broken", "test-items"]);
    expect(rows.find((r) => r.source === "test-items")).toMatchObject({ outcome: "items", items: 3 });
    expect(rows.find((r) => r.source === "test-broken"))
      .toMatchObject({ outcome: "parse_error", detail: "layout changed", items_at: null });
  });
});
