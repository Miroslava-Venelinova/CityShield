// Pipeline tests: the city-wide guard for spike 2's known qwen3 deviation,
// and processOutageMessage end-to-end with a mocked AI binding against D1.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearRefCaches } from "../src/db/queries";
import { applyCityWideGuard, processOutageMessage } from "../src/ingestion/pipeline";
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
