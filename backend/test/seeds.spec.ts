// The seed files themselves, checked as data.
//
// Everything else in this suite tests code against fixtures. This tests the
// reference data that ships inside the Worker — regions.json and streets.json
// are bundled (core/place-names.ts reads them at module scope) and generate
// seed.sql — and until the 08.08.2026 review nothing looked at them at all.
//
// It found 420 of 2,974 streets belonging to a different town, because the sweep
// re-resolved each settlement BY NAME with no province bound and Bulgaria has
// two Бяла, two Левски, two Дебелец, four Горица. Бяла's 177 rows carried
// coordinates from Бяла in Русе, 185 km away, while ViK published for the real
// Бяла three times in one window — and targeting proceeded confidently against
// them, because the rows existed and the settlement gate therefore never fired.
//
// The sweep is fixed (it keys each settlement on its own boundary relation id)
// and the bad rows are gone, and this is what keeps both true.

import { describe, expect, it } from "vitest";
import regions from "../seeds/regions.json";
import streets from "../seeds/streets.json";
import { MAX_SEED_DISTANCE_KM, verifySeeds } from "../seeds/verify.mjs";
import { parseName, placeClass } from "../src/core/place-names";

describe("seed data", () => {
  it(`places every street and district within ${MAX_SEED_DISTANCE_KM} km of its parent`, () => {
    const problems = verifySeeds(regions, streets);
    // Named, not counted: a bare count tells you a re-seed regressed and nothing
    // about which settlement to look at.
    expect(problems.map((p) => p.message)).toEqual([]);
  });

  // A street whose settlement has no regions row inserts NOTHING at apply time
  // and says nothing about it (generate-seed.mjs's insertStreets), so a whole
  // village can vanish from a seed that applied "successfully".
  it("files every street under a settlement that exists", () => {
    const settlements = new Set(
      regions.filter((r) => !("settlement" in r) || !r.settlement).map((r) => r.name));
    const orphans = [...new Set(
      streets.map((s) => s.settlement).filter((s) => !settlements.has(s)))];
    expect(orphans).toEqual([]);
  });

  // The other half of §1.3. The seed stores names exactly as OSM has them,
  // because that string is what the Overpass regex has to match — so the fix for
  // "ул.Никола Вапцаров beat Варна's bare row" could NOT be to rewrite the name.
  // It was to stop comparing whole names, which is what matchStreet does and
  // what the polygon path now uses too (F6).
  //
  // What still has to hold is that every stored name parses to a usable core: a
  // row whose kind cannot be split off is a row the matcher scores on the wrong
  // string.
  it("gives every name a non-empty parsed core", () => {
    const broken = [...regions, ...streets]
      .map((r) => r.name)
      .filter((name) => parseName(name).core.trim() === "");
    expect(broken).toEqual([]);
  });

  // Regression guard for the glued-prefix row that won §2.1: it is legal data
  // and it must stay parseable, kind and all.
  it("splits a glued kind prefix off a stored name", () => {
    expect(parseName("ул.Никола Вапцаров")).toEqual({ kind: "ул.", core: "Никола Вапцаров" });
    expect(placeClass(parseName("бул. Княз Борис I").kind)).toBe("street");
  });

  // §1.2, and the diagnosis that turned out to be wrong. Варна province holds
  // TWO places called Припек 10 km apart — the village at 43.255, 27.738 and a
  // suburb of Константиново at 43.174, 27.796 — which is exactly the shape
  // migration 0017 exists to let the table hold. What went wrong was not that
  // the suburb was filed under Константиново (it belongs there); it was that
  // the sweep's authoritative district pass RETIRED the parentless village row
  // for reusing the name, leaving "с. Припек" only the suburb to match, whose
  // parent link then pinned Константиново 1.7 km off.
  //
  // So the invariant is not "one Припек" — it is that the settlement-class row
  // survives a district of the same name.
  it("keeps the village Припек beside the Константиново suburb of that name", () => {
    const rows = regions.filter((r) => r.name === "Припек") as Array<{ settlement?: string }>;
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => !r.settlement).length).toBe(1);
    expect(rows.filter((r) => r.settlement === "Константиново").length).toBe(1);
  });

  // The general form of the same rule: a district batch may never retire a
  // settlement. Every name a district carries must still have its settlement row
  // if it ever had one — checked here as "no settlement-class name was left with
  // only parented rows", which is the shape the bug produced.
  it("never lets a district displace a settlement of the same name", () => {
    const settlements = new Set(
      regions.filter((r) => !("settlement" in r) || !r.settlement).map((r) => r.name));
    const claimed = new Set(streets.map((s) => s.settlement));
    const missing = [...claimed].filter((c) => !settlements.has(c));
    expect(missing).toEqual([]);
  });
});
