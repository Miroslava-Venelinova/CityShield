// processOutageMessage end-to-end with a mocked AI binding against D1.
//
// The deterministic guards it now runs — including the city-wide guard, which
// moved out of this file with the rest of them — are covered as pure functions
// in normalize.spec.ts. What is tested here is that the pipeline actually
// applies them, and the store/notify contract around it.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRefCaches } from "../src/db/queries";
import { ingestAlert, MAX_PUSH_ATTEMPTS, processOutageMessage } from "../src/ingestion/pipeline";
import type { ProcessedData } from "../src/shared/schemas";
import { sofiaToday } from "../src/shared/datetime";

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
      locations: [{ settlement: null, area: "кв. Аспарухово", streets: [], is_polygon: false }],
      schedule: { from_date: null, to_date: null, windows: [{ start: "09:00", end: "17:00" }] },
      city_wide: false,
    });

    const ok = await processOutageMessage(
      env, "VIK", "vik", "Авария", "Спиране на водата в кв. Аспарухово", "id=1");
    expect(ok).toBe(true);

    const today = sofiaToday();
    const inputs = captured[0] as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(inputs.max_tokens).toBe(10_000); // qwen3 reasoning headroom (spike 2)
    // The pipeline prepends the current date so the model can default it.
    expect(inputs.messages[1]!.content)
      .toBe(`CURRENT_DATE: ${today}\nАвария\nСпиране на водата в кв. Аспарухово`);

    const row = await env.DB.prepare("SELECT * FROM alerts").first<Record<string, string>>();
    expect(row!.category).toBe("vik");
    expect(row!.severity).toBe("warning");
    // A dateless schedule is dated to today (Sofia); one window on one day is
    // fully described by the envelope, so windows_json stays NULL.
    expect(row!.start_time).toBe(`${today}T09:00:00`);
    expect(row!.end_time).toBe(`${today}T17:00:00`);
    expect(row!.windows_json).toBeNull();
    const locations = JSON.parse(row!.locations_json!);
    expect(locations[0].location_name).toBe("кв. Аспарухово");
  });

  // "От 30.07 до 31.07 В периода 8:30 до 17:00" is 08:30–17:00 on each day.
  // The envelope alone read as 55 continuous hours (13 alerts, 28.07 review).
  it("stores the daily windows a date range implies (migration 0012)", async () => {
    mockAI({
      locations: [{ settlement: null, area: "кв. Аспарухово", streets: [], is_polygon: false }],
      schedule: {
        from_date: "2026-07-30", to_date: "2026-07-31",
        windows: [{ start: "08:30", end: "17:00" }],
      },
      city_wide: false,
    });

    await processOutageMessage(
      env, "EPRO", "epro", "Прекъсване", "От 30.07 до 31.07 В периода 8:30 до 17:00", "id=w");
    const row = await env.DB.prepare(
      "SELECT start_time, end_time, windows_json FROM alerts WHERE source_ref = 'epro:id=w'")
      .first<{ start_time: string; end_time: string; windows_json: string }>();

    // The envelope still bounds the alert, for every reader that only knows it.
    expect(row!.start_time).toBe("2026-07-30T08:30:00");
    expect(row!.end_time).toBe("2026-07-31T17:00:00");
    expect(JSON.parse(row!.windows_json)).toEqual({
      from_date: "2026-07-30",
      to_date: "2026-07-31",
      daily: [{ start: "08:30", end: "17:00" }],
    });
  });

  it("applies the city-wide guard before storing", async () => {
    mockAI({
      locations: [{ settlement: "град Варна", area: null, streets: [], is_polygon: false }],
      schedule: { from_date: null, to_date: null, windows: [] },
      city_wide: false,
    });

    const ok = await processOutageMessage(
      env, "EPRO", "epro", "Прекъсване", "Без ток остава цялата Варна", "id=x");
    expect(ok).toBe(true);
    const row = await env.DB.prepare("SELECT locations_json FROM alerts ORDER BY created_on_utc DESC")
      .first<{ locations_json: string }>();
    expect(JSON.parse(row!.locations_json)).toEqual([]); // guard emptied the fake location
  });

  // The same parse from a message that never says city-wide is a lost district,
  // not a broadcast — the alert must keep its location (guard A3, SPEC.md §1.7).
  it("keeps a lone Варна when the message does not say city-wide", async () => {
    mockAI({
      locations: [{ settlement: "град Варна", area: null, streets: [], is_polygon: false }],
      schedule: { from_date: null, to_date: null, windows: [] },
      city_wide: false,
    });

    const ok = await processOutageMessage(
      env, "EPRO", "epro", "Прекъсване", "гр. Варна - кв. Владислав Варненчик", "id=y");
    expect(ok).toBe(true);
    const row = await env.DB.prepare(
      "SELECT locations_json FROM alerts WHERE source_ref = 'epro:id=y'")
      .first<{ locations_json: string }>();
    expect(JSON.parse(row!.locations_json)).toHaveLength(1);
  });

  // 406268df +8: the district arrives in the street array and has to be moved
  // into the area slot before enrichment pins the city centre.
  it("lifts a district out of the street array (guard A4, SPEC.md §1.7)", async () => {
    clearRefCaches();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO regions (region_name, lat, lng) VALUES ('ж.к. Младост', 43.2309578, 27.879652)",
    ).run();
    mockAI({
      locations: [{ settlement: "Варна", area: null, streets: ["Младост"], is_polygon: false }],
      schedule: { from_date: null, to_date: null, windows: [] },
      city_wide: false,
    });

    await processOutageMessage(
      env, "EPRO", "epro", "Прекъсване", "гр. Варна - кв. Младост", "id=z");
    const row = await env.DB.prepare(
      "SELECT locations_json FROM alerts WHERE source_ref = 'epro:id=z'")
      .first<{ locations_json: string }>();
    const locations = JSON.parse(row!.locations_json) as Array<Record<string, unknown>>;
    expect(locations).toHaveLength(1);
    // The city is no longer dropped — it is the settlement of the same entry.
    expect(locations[0]!.settlement).toBe("Варна");
    expect(locations[0]!.area).toBe("Младост");
    // The derived display field is what the shipped app reads, and it still
    // answers with the most specific place named.
    expect(locations[0]!.location_name).toBe("Младост");
    expect(locations[0]!.lat).toBeCloseTo(43.2309578);
  });

  it("returns false (message retried next tick) when the AI keeps failing", async () => {
    mockAI({}, { failTimes: 99 });
    const ok = await processOutageMessage(env, "VIK", "vik", "t", "c", "id=2");
    expect(ok).toBe(false);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts").first<{ n: number }>();
    expect(count!.n).toBe(0);
  }, 15_000); // retry backoff sleeps 1s + 2s

  it("recovers when the AI fails transiently (retry succeeds)", async () => {
    mockAI({
      locations: [],
      schedule: { from_date: null, to_date: null, windows: [] },
      city_wide: true,
    }, { failTimes: 2 });
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
    locations: [], start_time: null, end_time: null, windows: null, city_wide: true,
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
