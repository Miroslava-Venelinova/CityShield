// Kind-aware place-name matching (fix-plan Phase B).
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

// The real seeded rows behind the review's name-ambiguity findings.
const regions: NamedRow[] = [
  row("Варна", 43.2073873, 27.9166653),
  row("с. Аспарухово (Дългопол)", 42.9789532, 27.3211773),
  row("кв. Аспарухово", 43.180493, 27.8970978),
  row("к.к. Чайка", 43.2547343, 28.0283004),
  row("кв. Чайка", 43.2159044, 27.9397023),
  row("ж.к. Младост (Белослав)", 43.1921995, 27.712998),
  row("ж.к. Младост", 43.2309578, 27.879652),
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
  it("resolves Младост to the district in Varna", () => {
    expect(name("ж.к. Младост")).toBe("ж.к. Младост");
    expect(name('ж.к "Младост"')).toBe("ж.к. Младост");
    expect(name("Младост")).toBe("ж.к. Младост");
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
