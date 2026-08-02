// Kind-aware place-name matching (SPEC.md §1.3).
//
// Every case here is a name the pipeline has actually produced, matched against
// a fixture that reproduces the collision from seeds/regions.json — the district
// in Varna and the like-named village or resort outside it, with their real
// seeded coordinates, since the in-city tie-break is decided on those.

import { describe, expect, it } from "vitest";
import type { NamedRow } from "../src/db/queries";
import {
  cleanName, kindsCompatible, matchRegion, matchStreet, parseName, placeClass,
} from "../src/core/place-names";

let nextId = 0;
const row = (name: string, lat: number | null = null, lng: number | null = null): NamedRow =>
  ({ id: ++nextId, name, lat, lng });

const MLADOST_BELOSLAV = row("ж.к. Младост", 43.1921995, 27.712998);
const MLADOST_VARNA = row("ж.к. Младост", 43.2309578, 27.879652);

// The real seeded rows behind the review's name-ambiguity findings.
const regions: NamedRow[] = [
  row("Варна", 43.2073873, 27.9166653),
  row("с. Аспарухово (Дългопол)", 42.9789532, 27.3211773),
  row("кв. Аспарухово", 43.180493, 27.8970978),
  row("к.к. Чайка", 43.2547343, 28.0283004),
  row("кв. Чайка", 43.2159044, 27.9397023),
  // Two districts, one name, 17 km apart — what migration 0014 had to rename by
  // hand and 0017 lets the table hold as it really is. Neither carries a parent
  // link here on purpose: that is the state of every row seeded before the
  // province sweep, and it is what leaves the in-city tie-break to do the work.
  MLADOST_BELOSLAV,
  MLADOST_VARNA,
  row("ж.к. Младост 1", 43.2319111, 27.8738485),
  row("ж.к. Младост 2", 43.2300044, 27.8854555),
  row("кв. Владиславово", 43.2467981, 27.8505253),
  row("Константиново", 43.1619425, 27.782844),
  row("к.к. Св. св. Константин и Елена", 43.2330874, 28.0110003),
  row("Баново", 43.2641622, 27.6770879),
  row("м-т Фичоза", 43.1549663, 27.9393622),
];

const streets: NamedRow[] = [
  row("Александър Дякович"),
  row("Пловдив"),
  row("бул. Чаталджа"),
  row("Боровец"),
  row("Бул. Боровец"),
  row("Младост"),
];

describe("parseName", () => {
  it.each([
    ["кв. Аспарухово", "кв.", "Аспарухово"],
    ['кв."Аспарухово"', "кв.", "Аспарухово"],
    ["ж.к. Младост", "ж.к.", "Младост"],
    ['ж.к "Младост"', "ж.к.", "Младост"],
    ["ЖК Възраждане", "ж.к.", "Възраждане"],
    ["м-т Фичоза", "м-т", "Фичоза"],
    ["м. Соук Су", "м-т", "Соук Су"],
    ["м-ст Планова", "м-т", "Планова"],
    ["к.к. Чайка", "к.к.", "Чайка"],
    ["к.к-с Чайка", "к.к.", "Чайка"],
    ["с. Баново", "с.", "Баново"],
    ["гр. Варна", "гр.", "Варна"],
    ["ул.7", "ул.", "7"],
    ["ул. Пловдив", "ул.", "Пловдив"],
    ["бул. Чаталджа", "бул.", "Чаталджа"],
    ["с.о. Ален Мак", "с.о.", "Ален Мак"],
    ["со Курудере", "с.о.", "Курудере"],
  ])("reads %s as %s + %s", (raw, kind, core) => {
    expect(parseName(raw)).toEqual({ kind, core });
  });

  it.each([
    // A bare abbreviation names a kind and no place.
    ["м-т", "м-т"], ["местност", "м-т"], ["кв.", "кв."], ["квартал", "кв."],
  ])("gives %s an empty core", (raw, kind) => {
    expect(parseName(raw)).toEqual({ kind, core: "" });
  });

  // JavaScript's \b is defined over ASCII \w, so it never fires between two
  // Cyrillic letters — these all used to be silently truncated by a spelled-out
  // kind pattern that relied on it.
  it.each([
    "Градинарово", "Булаир", "Пловдив", "Младост", "Селце", "Селска",
    "Соколово", "Кичево", "Аспарухово", "Възраждане", "Гроздьово", "Комарево",
  ])("leaves %s alone — it only starts like an abbreviation", (name) => {
    expect(parseName(name)).toEqual({ kind: null, core: name });
  });

  it("does not read с. Осеново as с.о. + сеново", () => {
    expect(parseName("с. Осеново")).toEqual({ kind: "с.", core: "Осеново" });
  });

  it("collapses quotes and whitespace", () => {
    expect(cleanName('  кв.  „Чайка”  ')).toBe("кв. Чайка");
  });
});

describe("kind compatibility", () => {
  it("treats кв. and ж.к. as the same kind of place", () => {
    expect(kindsCompatible(placeClass("кв."), placeClass("ж.к."))).toBe(true);
  });

  it("keeps a resort apart from a district", () => {
    expect(kindsCompatible(placeClass("к.к."), placeClass("кв."))).toBe(false);
  });

  it("lets an unstated kind match anything", () => {
    expect(kindsCompatible(null, placeClass("с."))).toBe(true);
    expect(kindsCompatible(placeClass("ул."), null)).toBe(true);
  });
});

describe("matchRegion", () => {
  const name = (raw: string) => matchRegion(raw, regions)?.name ?? null;

  // 27057824 ★ — the model dropped "кв." and the bare name scored 1.000 on a
  // village 55 km away, so the district was pinned there AND, because users
  // carry the district's region_id, notified nobody.
  it("prefers the district in the city over a like-named village", () => {
    expect(name("Аспарухово")).toBe("кв. Аспарухово");
    expect(name("кв. Аспарухово")).toBe("кв. Аспарухово");
    expect(name('кв."Аспарухово"')).toBe("кв. Аспарухово");
  });

  // 584f1445 — "ж.к. Чайка" pinned the resort. The kind now decides.
  it("separates ж.к. Чайка from к.к. Чайка", () => {
    expect(name("ж.к. Чайка")).toBe("кв. Чайка");
    expect(name("Чайка")).toBe("кв. Чайка");
    expect(name("к.к. Чайка")).toBe("к.к. Чайка");
  });

  // 2f891a6b — "ж.к. Младост" resolved to the one in Белослав, 17 km out.
  //
  // Compared by ID, not by name. Since migration 0017 both rows are called
  // "ж.к. Младост" — before it, one of them had to be "ж.к. Младост (Белослав)"
  // and a name comparison could tell them apart. It no longer can, and asserting
  // on the name here would pass whichever row won.
  it("resolves Младост to the district in Varna", () => {
    const id = (raw: string) => matchRegion(raw, regions)?.id ?? null;
    expect(id("ж.к. Младост")).toBe(MLADOST_VARNA.id);
    expect(id('ж.к "Младост"')).toBe(MLADOST_VARNA.id);
    expect(id("Младост")).toBe(MLADOST_VARNA.id);
    expect(MLADOST_BELOSLAV.id).not.toBe(MLADOST_VARNA.id);
  });

  // 0f8c45b5 — 0.385 on the whole names, which the old 0.3 threshold accepted.
  it("no longer confuses Св. св. Константин и Елена with Константиново", () => {
    expect(name("Св.св.Константин и Елена")).toBe("к.к. Св. св. Константин и Елена");
  });

  it("returns null for a bare kind abbreviation", () => {
    expect(name("м-т")).toBeNull();
    expect(name("местност")).toBeNull();
  });

  it("never answers a street name with a region", () => {
    expect(name("ул. Пловдив")).toBeNull();
    expect(name("бул. Чаталджа")).toBeNull();
  });

  it("matches a village named with its kind against a kindless seeded row", () => {
    expect(name("с. Баново")).toBe("Баново");
    expect(name("гр. Варна")).toBe("Варна");
  });

  it("keeps the far-away row when it is the only compatible kind", () => {
    // "с." rules out the district, so distance never gets a say.
    expect(name("с. Аспарухово")).toBe("с. Аспарухово (Дългопол)");
  });

  it("returns null rather than the nearest thing when nothing is close", () => {
    expect(name("Несъществуващо място")).toBeNull();
  });
});

describe("matchStreet", () => {
  const name = (raw: string) => matchStreet(raw, streets)?.name ?? null;

  it("resolves abbreviated Cyrillic street names (spike 3 case)", () => {
    expect(name("ул.Ал.Дякович")).toBe("Александър Дякович");
  });

  it("matches a prefixed name against the unprefixed seeded row", () => {
    expect(name("ул. Пловдив")).toBe("Пловдив");
  });

  it("prefers the row written the same way when the cores tie", () => {
    // The seed carries the street twice, with and without its kind.
    expect(name("бул. Боровец")).toBe("Бул. Боровец");
    expect(name("Боровец")).toBe("Боровец");
  });

  it("never answers a district name with a street", () => {
    // "Младост" is both a district and a street; the kind settles which.
    expect(name("кв. Младост")).toBeNull();
    expect(name("Младост")).toBe("Младост");
  });
});

// Migration 0015: street names repeat across settlements — 52% of the names
// around Тополи, Аврен and Долни чифлик are also Varna street names — so a
// street row is only a candidate inside its own settlement.
describe("matchStreet scoped to a settlement", () => {
  const VARNA = 100;
  const AVREN = 200;
  const scoped = (name: string, regionId: number): NamedRow =>
    ({ ...row(name), region_id: regionId });

  const rows: NamedRow[] = [
    { ...scoped("ул. Тича", VARNA), lat: 43.2166, lng: 27.9166 },
    { ...scoped("ул. Тича", AVREN), lat: 43.1138, lng: 27.6658 },
    scoped("Александър Дякович", VARNA),
    scoped("Черно море", AVREN),
  ];

  it("answers with the row in the named settlement, not the like-named one", () => {
    const inCity = matchStreet("ул. Тича", rows, VARNA);
    const inVillage = matchStreet("ул. Тича", rows, AVREN);

    expect(inCity!.region_id).toBe(VARNA);
    expect(inVillage!.region_id).toBe(AVREN);
    // Different rows, and — the point of seeding them — different pins, 25 km
    // apart. Unscoped, this pair was a coin toss decided by seed order.
    expect(inVillage!.id).not.toBe(inCity!.id);
    expect(inVillage!.lng).not.toBeCloseTo(inCity!.lng!);
  });

  it("does not reach a street that exists only in another settlement", () => {
    expect(matchStreet("Черно море", rows, VARNA)).toBeNull();
    expect(matchStreet("Александър Дякович", rows, AVREN)).toBeNull();
    // Both are perfectly good matches once the scope is dropped, which is what
    // makes forgetting to pass one a silent bug rather than a loud one.
    expect(matchStreet("Черно море", rows)).not.toBeNull();
    expect(matchStreet("Александър Дякович", rows)).not.toBeNull();
  });
});

describe("region aliases (migration 0013)", () => {
  // getRegions unions the alias table in as ordinary rows carrying the target's
  // id and coordinates, so an alternative spelling resolves to the SAME region.
  const canonical = regions.find((r) => r.name === "кв. Владиславово")!;
  const withAliases: NamedRow[] = [
    ...regions,
    { id: canonical.id, name: "Владислав Варненчик", lat: canonical.lat, lng: canonical.lng },
  ];

  it("resolves an alias to the canonical region id", () => {
    // Comparing cores scores this pair 0.375 — under the threshold — so the
    // alias is what makes it reachable at all.
    expect(matchRegion("Владислав Варненчик", withAliases)?.id).toBe(canonical.id);
    expect(matchRegion("кв. Владислав Варненчик", withAliases)?.id).toBe(canonical.id);
    expect(matchRegion("кв. Владиславово", withAliases)?.id).toBe(canonical.id);
  });
});

describe("matchRegion scoped to a settlement (migration 0017)", () => {
  // Since 0017 dropped the global UNIQUE on region_name, two settlements can
  // each hold a district of the same name. Nothing in the name separates them —
  // an outage message says "Цветен квартал" and never which town's — so the
  // settlement the message DID name is the only thing that can.
  const VARNA = regions.find((r) => r.name === "Варна")!;
  const BELOSLAV: NamedRow = { id: 9001, name: "Белослав", lat: 43.1958, lng: 27.7042 };
  const IN_VARNA: NamedRow = {
    id: 9002, name: "Цветен квартал", lat: 43.2238681, lng: 27.9138306, settlement_id: VARNA.id,
  };
  const IN_BELOSLAV: NamedRow = {
    id: 9003, name: "Цветен квартал", lat: 43.1816837, lng: 27.7038, settlement_id: BELOSLAV.id,
  };
  // A district carrying no parent — every row seeded before the province sweep,
  // which is 181 of the 261 in the real table.
  const UNLINKED: NamedRow = { id: 9004, name: "кв. Несвързан", lat: 43.22, lng: 27.91 };
  const rows: NamedRow[] = [...regions, BELOSLAV, IN_VARNA, IN_BELOSLAV, UNLINKED];

  it("picks the district belonging to the settlement that was named", () => {
    expect(matchRegion("Цветен квартал", rows, undefined, BELOSLAV.id)?.id).toBe(IN_BELOSLAV.id);
    expect(matchRegion("Цветен квартал", rows, undefined, VARNA.id)?.id).toBe(IN_VARNA.id);
  });

  it("resolves the settlement's own row inside its own scope", () => {
    // The scope is "this settlement and everything in it", so the settlement
    // itself has to be in it — settlementScope resolves names this way.
    expect(matchRegion("Белослав", rows, undefined, BELOSLAV.id)?.id).toBe(BELOSLAV.id);
  });

  it("falls back to an unscoped match when the scope holds nothing", () => {
    // The guarantee that makes scoping safe to switch on everywhere: a district
    // we hold no link for is still found, exactly as it was before 0017. A hard
    // filter would turn a correct answer into no answer for most of the table.
    expect(matchRegion("кв. Несвързан", rows, undefined, BELOSLAV.id)?.id).toBe(UNLINKED.id);
  });

  it("scopes to settlement-class rows when asked for null", () => {
    // How a settlement slot is resolved. "Баново" is a village in the seed; a
    // district of that name must not be able to take the lookup, because the id
    // it yields becomes a street scope and streets.region_id (0015) never points
    // at a district — every street lookup under it would silently find nothing.
    const village = regions.find((r) => r.name === "Баново")!;
    const impostor: NamedRow = {
      id: 9005, name: "Баново", lat: 43.21, lng: 27.91, settlement_id: VARNA.id,
    };
    expect(matchRegion("Баново", [...rows, impostor], undefined, null)?.id).toBe(village.id);
    // Unscoped, the impostor is a live candidate — which is what the scope is for.
    expect(matchRegion("Баново", [...rows, impostor])?.id).toBe(impostor.id);
  });

  // The in-city band separates most same-named pairs by itself — Белослав's
  // district is 16.5 km out and never survives the filter. It cannot separate a
  // pair on the SAME side of the threshold, and identical names score identically
  // in the literal tie-break, so without a further rule the answer is whichever
  // row the seed listed first. Two `с.о.` villa zones out among the villages are
  // exactly that shape.
  it("answers the same whatever order two identically-named rows are seeded in", () => {
    const near: NamedRow = { id: 9101, name: "с.о. Спорна", lat: 43.30, lng: 27.99 };  // ~12 km
    const far: NamedRow = { id: 9102, name: "с.о. Спорна", lat: 43.18, lng: 27.44 };   // ~39 km
    const varna = regions.find((r) => r.name === "Варна")!;

    expect(matchRegion("с.о. Спорна", [varna, near, far])?.id).toBe(near.id);
    expect(matchRegion("с.о. Спорна", [varna, far, near])?.id).toBe(near.id);
  });

  it("is unchanged when no scope is given", () => {
    // Every pre-0017 caller passes nothing, and must keep getting what it got.
    expect(matchRegion("Аспарухово", rows)?.name).toBe("кв. Аспарухово");
    expect(matchRegion("Цветен квартал", rows)).not.toBeNull();
  });
});
