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

/**
 * Mirrors insertStreets() in seeds/generate-seed.mjs.
 *
 * The settlement is a region NAME resolved by the statement itself, not an id:
 * region ids are autoincrement and differ between databases, so a checked-in
 * seed file cannot carry one. That is why this is an INSERT … SELECT rather
 * than the batched VALUES form the regions still use.
 */
function upsert(rows: Array<[string, string, number | null, number | null]>): string[] {
  return rows.map(([name, settlement, lat, lng]) =>
    `INSERT INTO streets (street_name, region_id, lat, lng) ` +
    `SELECT '${name.replace(/'/g, "''")}', id, ${lat ?? "NULL"}, ${lng ?? "NULL"} ` +
    `FROM regions WHERE region_name = '${settlement.replace(/'/g, "''")}' ` +
    `ON CONFLICT(street_name, region_id) DO UPDATE SET ` +
    `lat = COALESCE(excluded.lat, streets.lat), ` +
    `lng = COALESCE(excluded.lng, streets.lng);`);
}

/** D1's exec() is single-line per statement; the generator's output is not. */
const apply = async (rows: Array<[string, string, number | null, number | null]>) => {
  for (const statement of upsert(rows)) await env.DB.exec(statement);
};

const read = (name: string, settlement = "Варна") =>
  env.DB.prepare(
    `SELECT s.lat, s.lng FROM streets s JOIN regions r ON r.id = s.region_id
     WHERE s.street_name = ? AND r.region_name = ?`,
  ).bind(name, settlement).first<{ lat: number | null; lng: number | null }>();

const count = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS count FROM streets").first<{ count: number }>())!.count;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM streets").run();
  await env.DB.prepare("DELETE FROM regions").run();
  // The settlements the statements below resolve against. seed.sql emits the
  // regions before the streets for exactly this reason.
  await env.DB.prepare(
    "INSERT INTO regions (region_name, lat, lng) VALUES ('Варна', 43.2073873, 27.9166653), ('Аврен', 43.1138714, 27.6658571)",
  ).run();
});

describe("seed.sql upsert", () => {
  it("inserts new names and backfills coordinates onto existing ones", async () => {
    // Pre-0005 state: the name is seeded, the coordinates are not.
    await env.DB.prepare(
      `INSERT INTO streets (street_name, region_id)
       SELECT 'Дубровник', id FROM regions WHERE region_name = 'Варна'`,
    ).run();
    expect((await read("Дубровник"))!.lat).toBeNull();

    await apply([["Дубровник", "Варна", 43.1953, 27.9021], ["Девня", "Варна", 43.2, 27.9]]);

    expect((await read("Дубровник"))!.lat).toBeCloseTo(43.1953);
    expect((await read("Девня"))!.lng).toBeCloseTo(27.9);
  });

  it("is idempotent and never blanks coordinates already in the database", async () => {
    await apply([["Дубровник", "Варна", 43.1953, 27.9021]]);

    // Re-applying an older seed file — one whose entry carries no coordinates —
    // must leave the row alone rather than nulling it out. This is what the
    // COALESCE in the generated ON CONFLICT clause exists for.
    await apply([["Дубровник", "Варна", null, null]]);

    const row = await read("Дубровник");
    expect(row!.lat).toBeCloseTo(43.1953);
    expect(row!.lng).toBeCloseTo(27.9021);
    expect(await count()).toBe(1);
  });

  it("keeps one row per settlement for a name that repeats across them", async () => {
    // Half the street names around the villages already exist in the Varna seed
    // (52% over Тополи/Аврен/Долни чифлик), which is the whole reason migration
    // 0015 moved the UNIQUE from street_name to (street_name, region_id). Under
    // the old constraint the second of these two inserted nothing.
    await apply([
      ["ул. Тича", "Варна", 43.2166, 27.9166],
      ["ул. Тича", "Аврен", 43.1138, 27.6658],
    ]);

    expect(await count()).toBe(2);
    expect((await read("ул. Тича", "Варна"))!.lng).toBeCloseTo(27.9166);
    expect((await read("ул. Тича", "Аврен"))!.lng).toBeCloseTo(27.6658);
  });

  it("inserts nothing for a street whose settlement has no regions row", async () => {
    // Documented rather than desirable: the SELECT finds no region, so the row
    // is dropped without a word. generate-seed.mjs warns about settlements
    // missing from regions.json, and the counts it prints are what the apply is
    // checked against afterwards.
    await apply([["ул. Тича", "Несъществуващо село", 43.1, 27.6]]);
    expect(await count()).toBe(0);
  });
});

/**
 * Mirrors insertDistricts() in seeds/generate-seed.mjs.
 *
 * A district carries its parent in the same statement that inserts it, rather
 * than in a second UPDATE pass as it did under migration 0016. It has to: since
 * 0017 the parent is half the key, so a district inserted without one would land
 * on the settlement slot for its name and collide with its own namesake instead
 * of joining it.
 *
 * `AND settlement_id IS NULL` is what keeps the parent lookup single-valued — a
 * name is unique among settlements, not among all regions.
 */
const district = (name: string, parent: string, lat: number | null, lng: number | null) =>
  env.DB.exec(
    `INSERT INTO regions (region_name, lat, lng, settlement_id) ` +
    `SELECT '${name.replace(/'/g, "''")}', ${lat ?? "NULL"}, ${lng ?? "NULL"}, id ` +
    `FROM regions WHERE region_name = '${parent.replace(/'/g, "''")}' AND settlement_id IS NULL ` +
    `ON CONFLICT(region_name, COALESCE(settlement_id, 0)) DO UPDATE SET ` +
    `lat = COALESCE(excluded.lat, regions.lat), ` +
    `lng = COALESCE(excluded.lng, regions.lng);`);

/** Mirrors insertSettlements() — the batched form, which carries no parent. */
const settlement = (name: string, lat: number | null, lng: number | null) =>
  env.DB.exec(
    `INSERT INTO regions (region_name, lat, lng) VALUES ` +
    `('${name.replace(/'/g, "''")}', ${lat ?? "NULL"}, ${lng ?? "NULL"}) ` +
    `ON CONFLICT(region_name, COALESCE(settlement_id, 0)) DO UPDATE SET ` +
    `lat = COALESCE(excluded.lat, regions.lat), ` +
    `lng = COALESCE(excluded.lng, regions.lng);`);

const parentsOf = (name: string) =>
  env.DB.prepare(
    `SELECT s.region_name AS parent, d.lat FROM regions d
       LEFT JOIN regions s ON s.id = d.settlement_id
      WHERE d.region_name = ? ORDER BY COALESCE(s.region_name, '')`)
    .bind(name).all<{ parent: string | null; lat: number | null }>()
    .then((r) => r.results);

describe("seed.sql regions, keyed by (name, settlement)", () => {
  // The headline of migration 0017, and the reason the brackets are gone: Варна
  // and Белослав each hold a real "Цветен квартал", 17.5 km apart. Under the old
  // global UNIQUE the second inserted nothing, which is why 0014 had to rename
  // one of these collisions by hand.
  it("keeps one row per settlement for a district name that repeats", async () => {
    await settlement("Белослав", 43.1958, 27.7042);
    await district("Цветен квартал", "Варна", 43.2238681, 27.9138306);
    await district("Цветен квартал", "Белослав", 43.1816837, 27.7038);

    const rows = await parentsOf("Цветен квартал");
    expect(rows.map((r) => r.parent)).toEqual(["Белослав", "Варна"]);
    expect(rows[0]!.lat).toBeCloseTo(43.1816837);
    expect(rows[1]!.lat).toBeCloseTo(43.2238681);
  });

  // The NULL half of the key. SQLite treats NULLs in a UNIQUE index as distinct,
  // so without the COALESCE fold a settlement would have no uniqueness left at
  // all and every `WHERE region_name = 'Варна'` lookup could start seeing two.
  it("still refuses a second settlement of the same name", async () => {
    await settlement("Варна", 43.2073873, 27.9166653);
    const rows = await parentsOf("Варна");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parent).toBeNull();
  });

  // The two halves are independent: a district may be called what a settlement
  // is called, which is the case 0014 handled by renaming the village.
  it("lets a district share its name with a settlement", async () => {
    await district("Аврен", "Варна", 43.21, 27.91);
    const rows = await parentsOf("Аврен");
    expect(rows.map((r) => r.parent)).toEqual([null, "Варна"]);
  });

  it("is idempotent and never blanks coordinates already in the database", async () => {
    await district("кв. Виница", "Варна", 43.2419, 27.9603);
    await district("кв. Виница", "Варна", null, null);

    const rows = await parentsOf("кв. Виница");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lat).toBeCloseTo(43.2419);
  });

  // Same silent-drop shape as a street whose settlement is missing, and the same
  // mitigation: generate-seed.mjs warns, and the printed counts are the check.
  it("inserts nothing for a district whose parent has no regions row", async () => {
    await district("кв. Виница", "Несъществуващо село", 43.2419, 27.9603);
    expect(await parentsOf("кв. Виница")).toHaveLength(0);
  });

  // Without `AND settlement_id IS NULL` the lookup would match both rows named
  // "Аврен" and insert the district under each of them.
  it("resolves the parent to the settlement, never to a district of that name", async () => {
    await district("Аврен", "Варна", 43.21, 27.91);
    await district("ул. Тестова махала", "Аврен", 43.11, 27.66);

    const rows = await parentsOf("ул. Тестова махала");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parent).toBe("Аврен");
    // …and it is the settlement's row, not the Varna district's.
    const parent = await env.DB.prepare(
      `SELECT r.settlement_id FROM regions d JOIN regions r ON r.id = d.settlement_id
        WHERE d.region_name = 'ул. Тестова махала'`).first<{ settlement_id: number | null }>();
    expect(parent!.settlement_id).toBeNull();
  });
});
