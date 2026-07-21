// The upsert contract seeds/generate-seed.mjs emits.
//
// seed.sql is applied by hand against local and remote D1, sometimes more than
// once, and against a database whose reference rows predate migration 0005. The
// generator's promise is that re-applying it never loses data: new names are
// inserted, missing coordinates are backfilled, and existing coordinates
// survive a seed file that does not carry any. These tests pin that shape —
// the generator is a Node script, so the SQL it produces is what can be tested
// inside the worker pool.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/** Mirrors insertBatches() in seeds/generate-seed.mjs. */
function upsert(rows: Array<[string, number | null, number | null]>): string {
  const values = rows
    .map(([name, lat, lng]) => `('${name.replace(/'/g, "''")}', ${lat ?? "NULL"}, ${lng ?? "NULL"})`)
    .join(",\n");
  return `INSERT INTO streets (street_name, lat, lng) VALUES\n${values}\n` +
    `ON CONFLICT(street_name) DO UPDATE SET\n` +
    `  lat = COALESCE(excluded.lat, streets.lat),\n` +
    `  lng = COALESCE(excluded.lng, streets.lng);`;
}

const read = (name: string) =>
  env.DB.prepare("SELECT lat, lng FROM streets WHERE street_name = ?")
    .bind(name).first<{ lat: number | null; lng: number | null }>();

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM streets").run();
});

describe("seed.sql upsert", () => {
  it("inserts new names and backfills coordinates onto existing ones", async () => {
    // Pre-0005 state: the name is seeded, the coordinates are not.
    await env.DB.prepare("INSERT INTO streets (street_name) VALUES ('Дубровник')").run();
    expect((await read("Дубровник"))!.lat).toBeNull();

    await env.DB.exec(upsert([["Дубровник", 43.1953, 27.9021], ["Девня", 43.2, 27.9]])
      .replace(/\n/g, " ")); // D1's exec() is single-line per statement

    expect((await read("Дубровник"))!.lat).toBeCloseTo(43.1953);
    expect((await read("Девня"))!.lng).toBeCloseTo(27.9);
  });

  it("is idempotent and never blanks coordinates already in the database", async () => {
    await env.DB.exec(upsert([["Дубровник", 43.1953, 27.9021]]).replace(/\n/g, " "));

    // Re-applying an older seed file — one whose entry carries no coordinates —
    // must leave the row alone rather than nulling it out. This is what the
    // COALESCE in the generated ON CONFLICT clause exists for.
    await env.DB.exec(upsert([["Дубровник", null, null]]).replace(/\n/g, " "));

    const row = await read("Дубровник");
    expect(row!.lat).toBeCloseTo(43.1953);
    expect(row!.lng).toBeCloseTo(27.9021);

    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM streets")
      .first<{ count: number }>())!;
    expect(count).toBe(1);
  });
});
