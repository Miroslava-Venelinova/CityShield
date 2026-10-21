// The ingest tick's heartbeat bracketing (runIngestTick in ingestion/runner.ts).
//
// completed_at is the "this tick finished" half of the signal /api/health reads
// (health.spec.ts). A tick whose ingestion threw did not finish, so it must
// leave completed_at alone exactly as a killed tick does. It used not to: the
// scheduled handler's error wrapper swallowed the failure and the completion
// was written anyway.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getIngestHealth } from "../src/db/queries";
import { runIngestTick } from "../src/ingestion/runner";

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
