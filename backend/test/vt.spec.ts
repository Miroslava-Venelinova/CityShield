// vt route changes end-to-end with a mocked AI and a mocked page fetch.
//
// The 30.07.2026 review found route-change alerts carrying no time at all —
// "Маршрутни промени по линия 41" arrived with an empty window — because vt was
// the one source that never asked the model for a schedule. It does now, and
// these cover that the period actually reaches the stored alert.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/ingestion/sources/vt";
import { addSeenIds } from "../src/ingestion/state";
import { sofiaToday } from "../src/shared/datetime";

const PAGE = env.TEST_FIXTURES["vt_page.html"]!;

describe("vt route changes", () => {
  const realAI = env.AI;
  afterEach(() => { (env as { AI: unknown }).AI = realAI; });

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM alerts").run();
    await env.DB.prepare("DELETE FROM crawl_state WHERE source = 'vt'").run();
    // A state row must exist, or the first run only bootstraps the seen set.
    // Mark 777 seen so exactly one message (778) is processed.
    await addSeenIds(env, "vt", ["777"]);
  });

  function mockAI(response: unknown) {
    const captured: unknown[] = [];
    (env as { AI: unknown }).AI = {
      run: async (_model: string, inputs: unknown) => {
        captured.push(inputs);
        return { response: JSON.stringify(response) };
      },
    };
    return captured;
  }

  function mockPage() {
    fetchMock.get("https://www.varnatraffic.com")
      .intercept({ path: /.*/, method: "GET" })
      .reply(200, PAGE, { headers: { "Content-Type": "text/html" } });
  }

  it("stores the period a route change is in force for", async () => {
    mockPage();
    const captured = mockAI({
      bus_lines: ["31A"],
      schedule: {
        from_date: "2026-08-01", to_date: "2026-08-15",
        windows: [{ start: "09:00", end: "17:00" }],
      },
    });

    await run(env, Date.now() + 30_000);

    // The model is given the current date, same contract as the outage sources.
    const inputs = captured[0] as { messages: Array<{ content: string }> };
    expect(inputs.messages[1]!.content).toContain(`CURRENT_DATE: ${sofiaToday()}`);

    const row = await env.DB.prepare("SELECT * FROM alerts").first<Record<string, string>>();
    expect(row!.category).toBe("vt");
    expect(row!.start_time).toBe("2026-08-01T09:00:00");
    expect(row!.end_time).toBe("2026-08-15T17:00:00");
    // A window repeating over a range is exactly what the envelope loses, so it
    // is kept — otherwise the alert reads as one continuous 14-day closure.
    expect(JSON.parse(row!.windows_json!)).toEqual({
      from_date: "2026-08-01", to_date: "2026-08-15",
      daily: [{ start: "09:00", end: "17:00" }],
    });
  });

  it("stores a dated route change that states no clock time", async () => {
    mockPage();
    mockAI({ bus_lines: ["0"], schedule: { from_date: "2026-08-04", to_date: "2026-08-04", windows: [] } });

    await run(env, Date.now() + 30_000);

    const row = await env.DB.prepare("SELECT * FROM alerts").first<Record<string, string>>();
    // No clock means no envelope to build — the alert still stores, untimed,
    // rather than inventing midnight-to-midnight.
    expect(row!.start_time).toBeNull();
    expect(row!.end_time).toBeNull();
    expect(row!.windows_json).toBeNull();
  });

  it("still stores a route change when the message states no period at all", async () => {
    mockPage();
    mockAI({ bus_lines: ["31A"], schedule: { from_date: null, to_date: null, windows: [] } });

    await run(env, Date.now() + 30_000);

    const row = await env.DB.prepare("SELECT * FROM alerts").first<Record<string, string>>();
    expect(row).not.toBeNull();
    expect(row!.start_time).toBeNull();
    expect(row!.windows_json).toBeNull();
  });

  it("skips an irrelevant message whatever schedule came back with it", async () => {
    mockPage();
    mockAI({
      bus_lines: null,
      schedule: { from_date: "2026-08-01", to_date: "2026-08-01", windows: [{ start: "09:00", end: "17:00" }] },
    });

    await run(env, Date.now() + 30_000);

    const row = await env.DB.prepare("SELECT * FROM alerts").first();
    expect(row).toBeNull();
  });
});
