// streets.json / regions.json (+ optional aliases.json, street_ways.json)
// → seeds/seed.sql (docs/specification.md §1.2, street geometry §1.9).
//
// Entries are either a bare name (the original hand-maintained form) or
// { name, lat, lng } as written by tools/osm-seed-builder. Both are accepted so
// a partially migrated seed file still generates.
//
// A street entry also carries the `settlement` it belongs to (migration 0015),
// which is a region NAME rather than an id — see insertStreets. An entry without
// one is read as a Варна street, which is what every street in this file was
// before villages could be seeded at all.
//
// Emits an upsert rather than INSERT OR IGNORE: re-running must stay a no-op on
// an already-seeded DB, but it must ALSO be able to backfill coordinates onto
// rows that were seeded before they had any. COALESCE keeps that one-way —
// an entry without coordinates never blanks out coordinates already in the DB.
//
// Apply with: wrangler d1 execute cityshield-db --local|--remote --file=seeds/seed.sql
//
// Reads this directory and writes seed.sql beside the JSON by default. Both are
// overridable so tools/osm-seed-builder can generate SQL from its own output
// directory without touching backend/seeds — one implementation of the upsert,
// two sets of inputs:
//
//   node seeds/generate-seed.mjs --in ../tools/osm-seed-builder/output

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  return value && !value.startsWith("--") ? resolve(value) : fallback;
}

const inDir = flag("--in", here);
const outFile = flag("--out", join(inDir, "seed.sql"));

/** The settlement a street with no `settlement` field belongs to. */
const DEFAULT_SETTLEMENT = "Варна";

/**
 * Read a seed file into deduplicated entries.
 *
 * Both files are keyed on (name, settlement) rather than on the name alone,
 * which is the key each table's UNIQUE constraint was moved to — streets by
 * migration 0015, regions by 0017. "ул. Тича" in Аврен and "ул. Тича" in Варна
 * are two entries here for the same reason they are two rows there, and so are
 * Варна's "Цветен квартал" and Белослав's.
 *
 * `withSettlement` says which sense that field carries, not whether to use it:
 * for a street it is the settlement the street is IN and defaults to Варна; for
 * a region it is the settlement a district sits INSIDE (migration 0016), absent
 * on a settlement row, which is inside none.
 */
function loadEntries(file, withSettlement = false) {
  const data = JSON.parse(readFileSync(join(inDir, file), "utf8"));
  if (!Array.isArray(data)) throw new Error(`${file}: expected a JSON array`);

  // Last entry wins on a duplicate key, so a later row carrying coordinates
  // supersedes an earlier bare one.
  const byKey = new Map();
  for (const item of data) {
    const name = (typeof item === "string" ? item : item?.name ?? "").trim();
    if (!name) continue;
    const lat = typeof item === "object" ? item.lat : null;
    const lng = typeof item === "object" ? item.lng : null;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    const entry = { name, lat: hasCoords ? lat : null, lng: hasCoords ? lng : null };
    if (!withSettlement) {
      const parent = (typeof item === "object" ? item.settlement ?? "" : "").trim();
      const owned = parent !== "" && parent !== name;
      byKey.set(`${owned ? parent : ""}\0${name}`,
        owned ? { ...entry, settlement: parent } : entry);
      continue;
    }
    const settlement = (typeof item === "object" ? item.settlement ?? "" : "").trim()
      || DEFAULT_SETTLEMENT;
    // "\0" cannot occur in either half, so the join is unambiguous.
    byKey.set(`${settlement}\0${name}`, { ...entry, settlement });
  }

  const entries = [...byKey.values()];
  // Sorted by settlement first when there is one, so a diff groups a village's
  // streets together instead of interleaving them with the city's.
  return entries.sort((a, b) =>
    (a.settlement ?? "").localeCompare(b.settlement ?? "")
    || a.name.localeCompare(b.name));
}

const esc = (s) => `'${s.replace(/'/g, "''")}'`;
const num = (n) => (n === null ? "NULL" : String(n));

/**
 * Alternative written forms for a region, as `[{ alias, region }]`.
 *
 * Optional: a seed directory written by an older tool run has no aliases.json,
 * and the file is not part of what tools/osm-seed-builder extracts.
 */
function loadAliases() {
  let data;
  try {
    data = JSON.parse(readFileSync(join(inDir, "aliases.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  if (!Array.isArray(data)) throw new Error("aliases.json: expected a JSON array");

  const byAlias = new Map();
  for (const item of data) {
    const alias = (item?.alias ?? "").trim();
    const region = (item?.region ?? "").trim();
    if (alias && region) byAlias.set(alias, { alias, region });
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Aliases are keyed to their region by NAME, not by id — region ids are
 * autoincrement and differ between the local and the remote database, so a
 * literal id in a checked-in seed file would be wrong on one of them. The
 * SELECT resolves it at apply time and inserts nothing if the region is
 * missing, which is also what makes re-applying safe.
 *
 * Since migration 0017 a name alone can resolve to more than one region, so the
 * lookup carries the parent as well — read out of regions.json, which already
 * says which settlement each district is in, rather than asked for again here.
 * An alias naming a settlement scopes to `settlement_id IS NULL`; one naming a
 * district scopes to that district's parent. Only a region absent from
 * regions.json is left unscoped: that is the pre-0017 behaviour, and the best
 * available when there is nothing to scope by.
 */
function insertAliases(entries, byName) {
  return entries.map((e) => {
    const candidates = byName.get(e.region) ?? [];
    const parent = candidates.length > 0 ? candidates[0].settlement ?? null : undefined;
    const scope = parent === undefined
      ? ""
      : parent === null
        ? " AND settlement_id IS NULL"
        : ` AND settlement_id =` +
          ` (SELECT id FROM regions WHERE region_name = ${esc(parent)}` +
          ` AND settlement_id IS NULL)`;
    return `INSERT INTO region_aliases (alias, region_id)\n` +
      `SELECT ${esc(e.alias)}, id FROM regions` +
      ` WHERE region_name = ${esc(e.region)}${scope}\n` +
      `ON CONFLICT(alias) DO UPDATE SET region_id = excluded.region_id;`;
  }).join("\n");
}

/**
 * Streets, keyed to their settlement by NAME rather than by id — the same
 * reason, and the same shape, as insertAliases above: region ids are
 * autoincrement and differ between the local and the remote database, so a
 * literal id in a checked-in seed file would be wrong on one of them.
 *
 * This is why the batched `VALUES (…),(…)` form insertBatches uses is not
 * available here: every row needs its own lookup against `regions`. ~1,300
 * statements instead of ~14, which the local apply measures at a couple of
 * seconds — cheap enough that the readable form wins until it does not.
 *
 * A street whose settlement is missing from `regions` selects no row and so
 * inserts nothing, silently — the same failure mode insertAliases accepts, but
 * one that matters more here because it can swallow a whole village. The counts
 * this script prints are what that is checked against after applying.
 */
function insertStreets(entries) {
  return entries.map((e) =>
    `INSERT INTO streets (street_name, region_id, lat, lng)\n` +
    `SELECT ${esc(e.name)}, id, ${num(e.lat)}, ${num(e.lng)}\n` +
    `  FROM regions WHERE region_name = ${esc(e.settlement)}\n` +
    `ON CONFLICT(street_name, region_id) DO UPDATE SET\n` +
    `  lat = COALESCE(excluded.lat, streets.lat),\n` +
    `  lng = COALESCE(excluded.lng, streets.lng);`,
  ).join("\n");
}

/**
 * The conflict target every regions upsert names — the expression index
 * migration 0017 keys the table on.
 *
 * It repeats the COALESCE verbatim because it has to: SQLite matches an upsert's
 * target against an index by its expression, not by column list, so
 * `ON CONFLICT(region_name, settlement_id)` would find no index and fail. The
 * fold is what keeps a settlement's NULL parent unique — SQLite treats NULLs in
 * a UNIQUE index as distinct, so without it "Варна" could be seeded twice.
 */
const REGION_CONFLICT = "ON CONFLICT(region_name, COALESCE(settlement_id, 0))";

/**
 * Settlements — the regions that are inside no other region.
 *
 * The only rows that can still use the batched `VALUES (…),(…)` form: they carry
 * no parent to resolve, so nothing in them needs a lookup. ~170 rows in two
 * statements rather than 170.
 */
function insertSettlements(entries, batchSize = 100) {
  const lines = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const rows = entries
      .slice(i, i + batchSize)
      .map((e) => `(${esc(e.name)}, ${num(e.lat)}, ${num(e.lng)})`);
    lines.push(
      `INSERT INTO regions (region_name, lat, lng) VALUES\n${rows.join(",\n")}\n` +
        `${REGION_CONFLICT} DO UPDATE SET\n` +
        `  lat = COALESCE(excluded.lat, regions.lat),\n` +
        `  lng = COALESCE(excluded.lng, regions.lng);`,
    );
  }
  return lines.join("\n");
}

/**
 * Districts — a region that sits inside a settlement (migration 0016).
 *
 * The parent is resolved by NAME at apply time, for the reason insertStreets and
 * insertAliases do the same: region ids are autoincrement and differ between the
 * local and the remote database, so a literal id in a checked-in seed file would
 * be wrong on one of them.
 *
 * That lookup is what makes this a statement per row rather than part of the
 * batch above, and it replaces the separate link pass this file used to emit.
 * The link cannot be a second pass any more: since migration 0017 the parent is
 * half of the key, so a district inserted without one would land on the
 * settlement slot for its name — Белослав's "Цветен квартал" would collide with
 * Варна's instead of joining it.
 *
 * `AND settlement_id IS NULL` is what makes the lookup single-valued: a name is
 * unique among settlements, not among all regions. Without it a district whose
 * name is also a district's elsewhere would resolve to two parents and insert
 * under both.
 *
 * A district whose parent is missing from `regions` selects no row and so
 * inserts nothing, silently — the same failure mode as insertStreets, and the
 * counts this script prints are what it is checked against.
 */
function insertDistricts(entries) {
  return entries.map((e) =>
    `INSERT INTO regions (region_name, lat, lng, settlement_id)\n` +
    `SELECT ${esc(e.name)}, ${num(e.lat)}, ${num(e.lng)}, id\n` +
    `  FROM regions WHERE region_name = ${esc(e.settlement)} AND settlement_id IS NULL\n` +
    `${REGION_CONFLICT} DO UPDATE SET\n` +
    `  lat = COALESCE(excluded.lat, regions.lat),\n` +
    `  lng = COALESCE(excluded.lng, regions.lng);`,
  ).join("\n");
}

/**
 * Street geometry, as `[{ settlement, name, ways: [[[lon, lat], …], …] }]`
 * (migration 0020). Optional, like aliases.json: a seed directory written before
 * the sweep kept geometry has none, and then nothing about street_ways is
 * emitted at all — not even the DELETE, so applying an old seed cannot wipe
 * geometry a newer one put there.
 *
 * Entries whose street is not in streets.json are counted and left out: the
 * INSERT below would select no street for them anyway, silently.
 */
function loadStreetWays(streetEntries) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(inDir, "street_ways.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (!Array.isArray(data)) throw new Error("street_ways.json: expected a JSON array");

  const known = new Set(streetEntries.map((e) => `${e.settlement}\0${e.name}`));
  const entries = [];
  let orphans = 0;
  for (const item of data) {
    const name = (item?.name ?? "").trim();
    const settlement = (item?.settlement ?? "").trim() || DEFAULT_SETTLEMENT;
    const ways = (item?.ways ?? []).filter((w) => Array.isArray(w) && w.length >= 2);
    if (!name || ways.length === 0) continue;
    if (!known.has(`${settlement}\0${name}`)) {
      orphans++;
      continue;
    }
    entries.push({ name, settlement, ways });
  }
  entries.sort((a, b) => a.settlement.localeCompare(b.settlement) || a.name.localeCompare(b.name));
  return { entries, orphans };
}

/**
 * D1 refuses a single SQL statement over 100 KB. A street's ways are batched
 * into one statement up to this size — Сливница's 84 ways fit in one — and a
 * longer street simply gets more than one.
 */
const MAX_STATEMENT_BYTES = 90_000;

/**
 * Street ways, keyed to their street by NAME for the same reason insertStreets
 * keys streets to their settlement by name: ids are autoincrement and differ
 * between the local and the remote database.
 *
 * `settlement_id IS NULL` pins the lookup to the settlement row, the only kind
 * of region `streets.region_id` points at (migration 0015): a district may share
 * a settlement's name since 0017, and without it a street of that name in the
 * district's settlement would collect these ways too.
 *
 * Replaced wholesale rather than upserted. A way has no natural key, and the
 * sweep is each settlement's complete answer — a way OSM deleted must disappear
 * here, or the builder keeps drawing a road that is gone. Re-applying stays
 * idempotent: the same rows come back, under new ids nothing refers to.
 */
function insertStreetWays(entries) {
  const lines = ["DELETE FROM street_ways;"];
  for (const e of entries) {
    const head =
      `INSERT INTO street_ways (street_id, coords)\n` +
      `SELECT s.id, w.column1 FROM (VALUES `;
    const tail =
      `) AS w\n` +
      `  JOIN streets s ON s.street_name = ${esc(e.name)}\n` +
      `  JOIN regions r ON r.id = s.region_id\n` +
      `   AND r.region_name = ${esc(e.settlement)} AND r.settlement_id IS NULL;`;
    const budget = MAX_STATEMENT_BYTES - Buffer.byteLength(head + tail);
    let rows = [];
    let size = 0;
    const flush = () => {
      lines.push(head + rows.join(",") + tail);
      rows = [];
      size = 0;
    };
    for (const way of e.ways) {
      const row = `(${esc(JSON.stringify(way))})`;
      const bytes = Buffer.byteLength(row);
      if (bytes > budget) {
        throw new Error(`street_ways.json: one way of ${e.settlement}/${e.name} is ` +
          `${bytes} bytes, over D1's statement limit on its own`);
      }
      if (rows.length > 0 && size + bytes + 1 > budget) flush();
      rows.push(row);
      size += bytes + 1;
    }
    if (rows.length > 0) flush();
  }
  return lines;
}

/**
 * Local D1 (miniflare) stalls on a single `--file` much over 1 MB — measured
 * 26.10.2026: the 1.6 MB of street ways hung for five minutes and threw, while
 * the same statements in two halves applied in 2 s each. So the geometry goes
 * into numbered files next to seed.sql, each under this size, applied in order
 * by seeds/apply.mjs. seed.sql itself stays exactly what it was.
 */
const MAX_FILE_BYTES = 700_000;

/** `seed.sql` → `seed.ways.<n>.sql`, beside it. Read by seeds/apply.mjs too. */
const chunkPrefix = (file) => `${basename(file, ".sql")}.ways.`;

/**
 * Write the ways statements as chunk files, first removing every chunk a
 * previous run left: a stale `seed.ways.3.sql` applied after a shorter run's
 * two would re-insert ways the DELETE in chunk 1 had just cleared.
 */
function writeWayChunks(statements, file) {
  const dir = dirname(file);
  const prefix = chunkPrefix(file);
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix) && name.endsWith(".sql")) rmSync(join(dir, name));
  }
  const chunks = [];
  let current = [];
  let size = 0;
  for (const statement of statements) {
    const bytes = Buffer.byteLength(statement) + 1;
    if (current.length > 0 && size + bytes > MAX_FILE_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(statement);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk, i) => {
    const path = join(dir, `${prefix}${i + 1}.sql`);
    writeFileSync(path, "-- Generated by seeds/generate-seed.mjs — do not edit by hand.\n" +
      chunk.join("\n") + "\n", "utf8");
    return path;
  });
}

const regions = loadEntries("regions.json");
const streets = loadEntries("streets.json", true);
const aliases = loadAliases();
const streetWays = loadStreetWays(streets);

const linked = regions.filter((e) => e.settlement);
const settlements0 = regions.filter((e) => !e.settlement);

// Every region a name can mean, for the alias lookups. A district name is only
// unique within its settlement since migration 0017, so this is a list.
const regionsByName = new Map();
for (const e of regions) {
  const list = regionsByName.get(e.name);
  if (list) list.push(e);
  else regionsByName.set(e.name, [e]);
}

const sql = [
  "-- Generated by seeds/generate-seed.mjs — do not edit by hand.",
  // Settlements first and alone. Everything below resolves a settlement by name,
  // so those rows have to exist before anything points at them — the districts
  // included, which is why the two are separate statements rather than one
  // batch. Within a group the order is free; across them it is not.
  insertSettlements(settlements0),
  ...(linked.length > 0 ? [insertDistricts(linked)] : []),
  insertStreets(streets),
  ...(aliases.length > 0 ? [insertAliases(aliases, regionsByName)] : []),
  "",
].join("\n");

writeFileSync(outFile, sql, "utf8");
// Applied after seed.sql, whose streets the ways resolve against by name.
const wayFiles = streetWays ? writeWayChunks(insertStreetWays(streetWays.entries), outFile) : [];

const withCoords = (entries) => entries.filter((e) => e.lat !== null).length;

// Every settlement a street claims, checked against the regions being seeded
// alongside it. A street whose settlement has no regions row inserts nothing at
// apply time and says nothing about it, so the one chance to notice is here.
const settlements = new Set(streets.map((e) => e.settlement));
// Settlement-class rows only: since migration 0017 a district may share a name
// with one, and a district is not somewhere a street can be filed.
const seededSettlements = new Set(settlements0.map((e) => e.name));
const unknown = [...settlements].filter((s) => !seededSettlements.has(s));
// Same check for the parent links: a district pointing at a settlement that is
// not being seeded updates nothing and says nothing about it.
const unknownParents = [...new Set(linked.map((e) => e.settlement))]
  .filter((s) => !seededSettlements.has(s));

console.log(
  `${outFile} written: ${regions.length} regions (${withCoords(regions)} with coordinates, ` +
    `${linked.length} linked to a settlement), ` +
    `${streets.length} streets (${withCoords(streets)} with coordinates) ` +
    `across ${settlements.size} settlement(s), ${aliases.length} region aliases` +
    (streetWays
      ? `, ${streetWays.entries.reduce((n, e) => n + e.ways.length, 0)} street ways for ` +
        `${streetWays.entries.length} streets in ${wayFiles.length} file(s) beside it`
      : ", no street_ways.json (street geometry left as it is)"),
);
if (streetWays && streetWays.orphans > 0) {
  console.warn(
    `WARNING: ${streetWays.orphans} street(s) in street_ways.json have no entry in ` +
      `streets.json, so their ways were left out. Promote the sweep's streets with them.`,
  );
}
if (unknownParents.length > 0) {
  console.warn(
    `WARNING: ${unknownParents.length} settlement(s) named as a region's parent have no row ` +
      `in regions.json, so those links will be left NULL: ${unknownParents.join(", ")}`,
  );
}
// A district-looking name with no parent is keyed as a SETTLEMENT since
// migration 0017 — (name, 0) rather than (name, <city>). Applying such a row
// over a database that already holds the linked copy therefore INSERTS a second
// region rather than upserting the first, and nothing downstream complains: the
// duplicate simply sits there splitting the name's audience.
//
// It is the shape a pre-sweep seed file has, so the warning is aimed squarely at
// applying a stale one. Heuristic by necessity — 203 of the seeded names carry no
// kind prefix at all — so it names the rows rather than refusing to write them.
// Anchored on the separator rather than \b: JS word boundaries are
// ASCII-only even under /u, so \b never matches at the end of a
// Cyrillic prefix and the check silently passed everything.
const DISTRICT_KINDS = /^(кв|ж\.к|м-т|местност|с\.о|со|вз|к\.к)[.\s]/u;
const unparented = settlements0.filter((e) => DISTRICT_KINDS.test(e.name));
if (unparented.length > 0) {
  const shown = unparented.slice(0, 8).map((e) => e.name).join(", ");
  console.warn(
    `WARNING: ${unparented.length} region(s) are written like a district but carry no ` +
      `settlement, so they will be seeded as settlements. If the database already holds ` +
      `them linked to a city, this INSERTS A SECOND ROW for each rather than updating it ` +
      `(migration 0017 keys regions on name + settlement). Promote a sweep's output first, ` +
      `or add the parent: ${shown}${unparented.length > 8 ? ", …" : ""}`,
  );
}
if (unknown.length > 0) {
  console.warn(
    `WARNING: ${unknown.length} settlement(s) named by streets.json have no row in ` +
      `regions.json, so their streets will insert NOTHING unless the database ` +
      `already holds the region: ${unknown.join(", ")}`,
  );
}
