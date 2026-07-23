// Pipeline tests: the city-wide guard for spike 2's known qwen3 deviation,
// and processOutageMessage end-to-end with a mocked AI binding against D1.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRefCaches } from "../src/db/queries";
import {
  applyCityWideGuard, ingestAlert, MAX_PUSH_ATTEMPTS, processOutageMessage,
} from "../src/ingestion/pipeline";
import type { ProcessedData } from "../src/shared/schemas";

const location = (name: string | null, subs: string[] = [], poly = false) =>
  ({ location_name: name, sublocations: subs, is_polygon: poly });

const output = (locations: ProcessedData["locations"], cityWide = false): ProcessedData =>
  ({ locations, start_time: null, end_time: null, city_wide: cityWide });

describe("applyCityWideGuard (qwen3 deviation №2)", () => {
  it.each(["град Варна", "гр. Варна", "Варна", "гр.Варна"])(
    "normalizes a lone sublocation-less '%s' location to city_wide",
    (name) => {
      const fixed = applyCityWideGuard(output([location(name)]));
      expect(fixed.city_wide).toBe(true);
      expect(fixed.locations).toEqual([]);
    });

  it("leaves real locations alone", () => {
    for (const out of [
      output([location("Тополи")]),                      // different locality
      output([location("Варна", ["ул. Дубровник"])]),    // has streets
      output([location("Варна"), location("Тополи")]),   // multiple locations
    ]) {
      expect(applyCityWideGuard(out)).toEqual(out);
    }
  });
});

describe("processOutageMessage (mocked AI)", () => {
  const realAI = env.AI;
  afterEach(() => {
    (env as { AI: unknown }).AI = realAI;
  });

  function mockAI(response: unknown, opts: { failTimes?: number } = {}) {
    let calls = 0;
    const captured: unknown[] = [];
    (env as { AI: unknown }).AI = {
      run: async (_model: string, inputs: unknown) => {
        captured.push(inputs);
        if (opts.failTimes && calls++ < opts.failTimes) throw new Error("AI down");
        return { response: JSON.stringify(response) };
      },
    };
    return captured;
  }

  it("stores an alert from the AI output and notifies region users", async () => {
    clearRefCaches();
    await env.DB.prepare("INSERT OR IGNORE INTO regions (region_name) VALUES ('Аспарухово')").run();
    const captured = mockAI({
      locations: [{ location_name: "кв. Аспарухово", sublocations: [], is_polygon: false }],
      start_time: "09:00",
      end_time: "17:00",
      city_wide: false,
    });

    const ok = await processOutageMessage(env, "VIK", "vik", "Авария", "Спиране на водата", "id=1");
    expect(ok).toBe(true);

    const inputs = captured[0] as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(inputs.max_tokens).toBe(8000); // qwen3 reasoning headroom (spike 2)
    expect(inputs.messages[1]!.content).toBe("Авария\nСпиране на водата");

    const row = await env.DB.prepare("SELECT * FROM alerts").first<Record<string, string>>();
    expect(row!.category).toBe("vik");
    expect(row!.severity).toBe("warning");
    expect(row!.start_time).toBe("09:00");
    const locations = JSON.parse(row!.locations_json!);
    expect(locations[0].location_name).toBe("кв. Аспарухово");
  });

  it("applies the city-wide guard before storing", async () => {
    mockAI({
      locations: [{ location_name: "град Варна", sublocations: [], is_polygon: false }],
      start_time: null,
      end_time: null,
      city_wide: false,
    });

    const ok = await processOutageMessage(env, "EPRO", "epro", "Прекъсване", "За цяла Варна", "id=x");
    expect(ok).toBe(true);
    const row = await env.DB.prepare("SELECT locations_json FROM alerts ORDER BY created_on_utc DESC")
      .first<{ locations_json: string }>();
    expect(JSON.parse(row!.locations_json)).toEqual([]); // guard emptied the fake location
  });

  it("returns false (message retried next tick) when the AI keeps failing", async () => {
    mockAI({}, { failTimes: 99 });
    const ok = await processOutageMessage(env, "VIK", "vik", "t", "c", "id=2");
    expect(ok).toBe(false);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first<{ n: number }>();
    expect(count!.n).toBe(0);
  }, 15_000); // retry backoff sleeps 1s + 2s

  it("recovers when the AI fails transiently (retry succeeds)", async () => {
    mockAI({ locations: [], start_time: null, end_time: null, city_wide: true }, { failTimes: 2 });
    const ok = await processOutageMessage(env, "VIK", "vik", "t", "c", "id=3");
    expect(ok).toBe(true);
  }, 15_000);
});

// The lost-push fix (migration 0009): a failed send must hold the cursor so the
// message is re-driven, and the re-drive must neither duplicate the alert nor
// re-notify once delivery has landed. Driven through ingestAlert with a
// city-wide payload so no AI or geocoding is involved.
describe("ingestAlert idempotency + push retry (migration 0009)", () => {
  const PUSH_ENV = env as { ONESIGNAL_APP_ID?: string; ONESIGNAL_API_KEY?: string };

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  beforeEach(() => {
    PUSH_ENV.ONESIGNAL_APP_ID = "test-app-id";
    PUSH_ENV.ONESIGNAL_API_KEY = "test-api-key";
  });

  afterEach(() => {
    delete PUSH_ENV.ONESIGNAL_APP_ID;
    delete PUSH_ENV.ONESIGNAL_API_KEY;
    fetchMock.assertNoPendingInterceptors();
  });

  // One OneSignal send with the given HTTP status; returns a live call counter.
  function interceptPush(status: number): () => number {
    let calls = 0;
    fetchMock.get("https://api.onesignal.com")
      .intercept({ path: "/notifications", method: "POST" })
      .reply(() => {
        calls++;
        return {
          statusCode: status,
          data: JSON.stringify(status === 200 ? { id: "n", recipients: 1 } : { error: "down" }),
          responseOptions: { headers: { "Content-Type": "application/json" } },
        };
      })
      .times(1);
    return () => calls;
  }

  async function makeUser(): Promise<void> {
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (user_id, email, password_hash, receives_all_alerts, subscribed_bus_lines, created_on_utc, updated_on_utc)
       VALUES (?, ?, 'x', 0, '[]', ?, ?)`,
    ).bind(userId, `${userId}@example.com`, now, now).run();
  }

  const cityWide = (): ProcessedData => ({
    locations: [], start_time: null, end_time: null, city_wide: true,
  });

  it("holds the cursor on a failed send, then re-drives without duplicating or re-storing", async () => {
    await makeUser();

    const failCount = interceptPush(500);
    const first = await ingestAlert(env, "VIK", "vik", "Авария", "text", cityWide(), "id=42");
    expect(first).toBe(false); // send failed → false so the cursor holds
    expect(failCount()).toBe(1);

    // Stored, but delivery still owed.
    const stored = await env.DB.prepare(
      "SELECT source_ref, notified_at FROM alerts")
      .all<{ source_ref: string; notified_at: string | null }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]!.source_ref).toBe("vik:id=42");
    expect(stored.results[0]!.notified_at).toBeNull();

    // Next tick re-drives the same message: no duplicate alert, push retries.
    const okCount = interceptPush(200);
    const second = await ingestAlert(env, "VIK", "vik", "Авария", "text", cityWide(), "id=42");
    expect(second).toBe(true);
    expect(okCount()).toBe(1);

    const rows = await env.DB.prepare("SELECT notified_at FROM alerts")
      .all<{ notified_at: string | null }>();
    expect(rows.results).toHaveLength(1); // idempotent store — still one alert
    expect(rows.results[0]!.notified_at).not.toBeNull(); // delivery now stamped
  });

  it("gives up and unblocks the cursor after the push-attempt cap", async () => {
    await makeUser();

    // Every tick's send fails. The cursor holds (false) until the final attempt,
    // which gives up and returns true so the cursor can advance past the message.
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      interceptPush(500);
      const held = await ingestAlert(env, "VIK", "vik", "t", "c", cityWide(), "id=99");
      expect(held).toBe(attempt < MAX_PUSH_ATTEMPTS ? false : true);
    }

    // Abandoned: stored, delivery never stamped, attempts sitting at the cap.
    const row = await env.DB.prepare(
      "SELECT notified_at, push_attempts FROM alerts WHERE source_ref = 'vik:id=99'")
      .first<{ notified_at: string | null; push_attempts: number }>();
    expect(row!.notified_at).toBeNull();
    expect(row!.push_attempts).toBe(MAX_PUSH_ATTEMPTS);
  });

  it("does not re-push a message already delivered", async () => {
    await makeUser();

    const okCount = interceptPush(200);
    expect(await ingestAlert(env, "VIK", "vik", "t", "c", cityWide(), "id=7")).toBe(true);
    expect(okCount()).toBe(1);

    // Re-drive: store no-ops and notified_at is set, so no second send. No
    // interceptor is registered for a second call — disableNetConnect would
    // throw if one were attempted, failing the test.
    expect(await ingestAlert(env, "VIK", "vik", "t", "c", cityWide(), "id=7")).toBe(true);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });
});
