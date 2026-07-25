// epro's endpoint contract: entries are returned only for a queried region_id +
// type, inside `area_locations` (not the old top-level bucket keys, now empty).
// These cover the fetch/parse layer that silently returned nothing after the
// site changed shape.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fetchVarnaEntries, type FetchImpl } from "../src/ingestion/sources/epro";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

// A response as the endpoint shapes it: an array of areas, each with an
// `area_locations` list for the queried type.
const areasWith = (locations: unknown[]) => [
  { area_id: "1", area_name: "Варна", area_locations: locations },
  { area_id: "2", area_name: "Русе", area_locations: [{ location_period: "x", location_text: "y" }] },
];

const entry = (period: string, text: string) => ({ location_period: period, location_text: text });

describe("epro fetchVarnaEntries (new region_id + type contract)", () => {
  it("reads area_locations for the configured region and dedups across the two type queries", async () => {
    const shared = entry("На 27.07 8:00", "ул. Тест 1");
    const only48 = entry("На 27.07 9:00", "ул. Тест 2");
    const onlyActive = entry("На 27.07 10:00", "ул. Тест 3");

    const seen: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      seen.push(url);
      // The same interruption appears in both buckets; the active-only one only
      // in all_active, the 48h-only one only there.
      if (url.includes("type=for_next_48_hours")) return jsonResponse(areasWith([shared, only48]));
      if (url.includes("type=all_active")) return jsonResponse(areasWith([shared, onlyActive]));
      throw new Error(`unexpected url ${url}`);
    };

    const entries = await fetchVarnaEntries(env, Date.now() + 5000, fetchImpl);
    expect(entries).not.toBeNull();
    // shared counted once, plus the two unique ones = 3.
    const texts = entries!.map((e) => e.location_text).sort();
    expect(texts).toEqual(["ул. Тест 1", "ул. Тест 2", "ул. Тест 3"]);

    // Queried the configured region for both types.
    expect(seen.every((u) => u.includes("region_id=1"))).toBe(true);
    expect(seen.some((u) => u.includes("type=for_next_48_hours"))).toBe(true);
    expect(seen.some((u) => u.includes("type=all_active"))).toBe(true);
  });

  it("returns [] (not null) when the region is present but has no entries", async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse(areasWith([]));
    const entries = await fetchVarnaEntries(env, Date.now() + 5000, fetchImpl);
    expect(entries).toEqual([]);
  });

  it("returns null when every type query fails, so run() skips the tick", async () => {
    const fetchImpl: FetchImpl = async () => { throw new Error("network down"); };
    expect(await fetchVarnaEntries(env, Date.now() + 5000, fetchImpl)).toBeNull();
  });

  it("returns null when the region is absent from every response", async () => {
    // Only other regions come back — never our configured region_id.
    const fetchImpl: FetchImpl = async () =>
      jsonResponse([{ area_id: "9", area_name: "Шумен", area_locations: [entry("p", "t")] }]);
    expect(await fetchVarnaEntries(env, Date.now() + 5000, fetchImpl)).toBeNull();
  });

  it("tolerates a non-array (unexpected) response as 'nothing for this type'", async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ error: "nope" });
    // Both types return a bad shape → no region matched → null.
    expect(await fetchVarnaEntries(env, Date.now() + 5000, fetchImpl)).toBeNull();
  });
});
