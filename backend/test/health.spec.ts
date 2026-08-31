// /api/health — the signals that have to survive an exceededCpu kill.
//
// Both things under test here exist because the 28.08.2026 outage was invisible:
// the tick's own alarm was a console.error in a log stream the kill discarded,
// and historical logs are not queryable (the wrangler token lacks the
// observability scopes). These rows are written to D1 by the tick itself, so a
// kill cannot erase them.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getIngestHealth, markTickCompleted, markTickStarted,
} from "../src/db/queries";
import { claimAttempt, recordSkip, writeLastId } from "../src/ingestion/state";
import { api } from "./helpers";

const CRON = "*/15 * * * *";
const withKey = () => ({ headers: { "X-Api-Key": "test-ingest-key" } });

describe("tick heartbeat", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ingest_health").run();
    await env.DB.prepare("DELETE FROM ingest_attempts").run();
    await env.DB.prepare("DELETE FROM crawl_state").run();
  });

  it("records a start before the work and a completion after it", async () => {
    await markTickStarted(env, CRON);
    let [row] = await getIngestHealth(env);
    expect(row!.started_at).toBeTruthy();
    expect(row!.completed_at).toBeNull(); // nothing has finished yet

    await markTickCompleted(env, CRON, 1234);
    [row] = await getIngestHealth(env);
    expect(row!.completed_at).toBeTruthy();
    expect(row!.last_duration_ms).toBe(1234);
  });

  it("a start with no completion after it is the exceededCpu signature", async () => {
    // A tick that ran to the end...
    await markTickStarted(env, CRON);
    await markTickCompleted(env, CRON, 800);
    let res = await api("/api/health", withKey());
    let body = await res.json() as any;
    expect(body.ticks[0].started_but_never_completed).toBe(false);
    expect(body.status).toBe("ok");

    // ...then one that was killed part-way. completed_at is deliberately left
    // standing at the older value rather than cleared: it is the comparison
    // that carries the signal.
    await new Promise((r) => setTimeout(r, 5));
    await markTickStarted(env, CRON);
    res = await api("/api/health", withKey());
    body = await res.json() as any;
    expect(body.ticks[0].started_but_never_completed).toBe(true);
    expect(body.status).toBe("degraded");
  });

  it("reports a stalled cursor and the messages the cap gave up on", async () => {
    await writeLastId(env, "vik", 17372);
    // Backdate the cursor past the stall threshold.
    await env.DB.prepare("UPDATE crawl_state SET updated_at = ? WHERE source = 'vik'")
      .bind(new Date(Date.now() - 21 * 3600 * 1000).toISOString()).run();

    await claimAttempt(env, "vik", "17373");
    await recordSkip(env, "vik", "17373");

    const res = await api("/api/health", withKey());
    const body = await res.json() as any;

    expect(body.status).toBe("degraded");
    const vik = body.sources.find((s: any) => s.source === "vik");
    expect(vik.stalled).toBe(true);
    expect(vik.last_id).toBe(17372);
    expect(vik.hours_since_cursor_moved).toBeGreaterThan(20);

    // The one thing no other signal would ever surface: a message deliberately
    // not delivered.
    expect(body.skipped_messages).toEqual([
      expect.objectContaining({ source: "vik", ref: "17373", attempts: 1 }),
    ]);
  });

  it("is not public", async () => {
    expect((await api("/api/health")).status).toBe(401);
    expect((await api("/api/health", { headers: { "X-Api-Key": "wrong" } })).status).toBe(401);
  });
});
