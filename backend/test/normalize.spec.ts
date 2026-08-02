// Deterministic guards over the AI parse (guards A1-A9, SPEC.md §1.7).
//
// Each block replays a parse the pipeline really stored, from the review of
// 28.07.2026, against the source text it came from. Pure functions, no D1.

import { describe, expect, it } from "vitest";
import type { NamedRow } from "../src/db/queries";
import type { ProcessedData } from "../src/shared/schemas";
import {
  applyCityWideGuard, isPlaceless, normalizeParse, type ReferenceRows, stripAddressDetail,
} from "../src/ingestion/normalize";

let nextId = 0;
const row = (name: string, lat: number | null = null, lng: number | null = null): NamedRow =>
  ({ id: ++nextId, name, lat, lng });

/** A region that migration 0016 knows sits inside another. */
const inside = (parent: NamedRow, r: NamedRow): NamedRow => ({ ...r, settlement_id: parent.id });

const refs: ReferenceRows = {
  regions: [
    row("Варна", 43.2073873, 27.9166653),
    row("ж.к. Младост", 43.2309578, 27.879652),
    row("кв. Владиславово", 43.2467981, 27.8505253),
    row("Владислав Варненчик", 43.2467981, 27.8505253), // alias row (migration 0013)
    row("кв. Аспарухово", 43.180493, 27.8970978),
    row("кв. Виница", 43.2419122, 27.9603219),
    row("Игнатиево", 43.2495548, 27.7747311),
    row("Припек", 43.1742899, 27.7958142),
    row("Баново", 43.2641622, 27.6770879),
    row("м-т Фичоза", 43.1549663, 27.9393622),
    row("с. Аврен", 43.1032817, 27.6766949), // 22.6 km out — A9's far settlement
  ],
  streets: [
    row("Пловдив"), row("бул. Чаталджа"), row("Драва"), row("Дубровник"),
    row("Беласица"), row("Девня"), row("Младост"), row("за вододайната зона"),
  ],
};

/** One AI entry: the settlement, the area inside it, and that entry's streets. */
const location = (
  settlement: string | null, area: string | null = null, streets: string[] = [], poly = false,
) => ({ settlement, area, streets, is_polygon: poly });

/** The common shape where the message names no settlement — "кв. Аспарухово, ул. X". */
const inArea = (area: string | null, streets: string[] = [], poly = false) =>
  location(null, area, streets, poly);

const parse = (locations: ProcessedData["locations"], cityWide = false): ProcessedData =>
  ({ locations, start_time: null, end_time: null, windows: null, city_wide: cityWide });

const run = (locations: ProcessedData["locations"], message: string, cityWide = false) =>
  normalizeParse(parse(locations, cityWide), message, refs);

/** All three slots, the shape the assertions care about. */
const shape = (out: ProcessedData) =>
  out.locations.map((l) => [l.settlement, l.area, l.streets, l.is_polygon] as const);

// ── A1 ───────────────────────────────────────────────────────────────────────

describe("A1 · placeless names", () => {
  it.each([
    "м-т", "местност", "м.", "кв.", "квартал", "карето", "зона", "улица",
    "м-н Бурлекс", "ТП 726", "Строител ООД", "  ",
  ])("treats %s as no place at all", (name) => {
    expect(isPlaceless(name)).toBe(true);
  });

  it.each([
    "кв. Аспарухово", "с. Баново", "Вилна зона", "м-т Фичоза", "ул. Пловдив",
    "Западна промишлена зона", "Бурлекс",
  ])("keeps %s", (name) => {
    expect(isPlaceless(name)).toBe(false);
  });

  // c921a48e ★ / fc2f2837 ★ — "местност"/"м-т" left over from "с. Баново,
  // м-т и прилежащите улици" scored 0.364 on "м-т Фичоза" and dropped a pin
  // 40 km from the villages the outage was in.
  it("drops a lone kind abbreviation from a village list", () => {
    const out = run(
      [location("гр. Игнатиево"), location("с. Припек"), location("с. Баново"), location("м-т")],
      "Прекъсване в гр. Игнатиево, с. Припек, с. Баново, м-т и прилежащите улици");
    expect(out.locations.map((l) => l.settlement))
      .toEqual(["гр. Игнатиево", "с. Припек", "с. Баново"]);
  });

  it("drops a shop but keeps the district beside it", () => {
    const out = run([inArea("ЖК Възраждане"), inArea("м-н Бурлекс")],
      "Без вода ще бъдат: ЖК Възраждане, м-н Бурлекс");
    expect(out.locations.map((l) => l.area)).toEqual(["ЖК Възраждане"]);
  });

  it("drops only the name when a placeless one carries real streets", () => {
    const out = run([inArea("карето", ["ул. Пловдив"])], "Ремонт в карето");
    expect(shape(out)).toEqual([[null, null, ["ул. Пловдив"], false]]);
  });

  // The slots are cleaned independently: a placeless area under a real
  // settlement must not take the settlement down with it.
  it("clears a placeless area and keeps the settlement", () => {
    const out = run([location("гр. Варна", "карето", ["ул. Пловдив"])], "Ремонт в карето");
    expect(shape(out)).toEqual([["гр. Варна", null, ["ул. Пловдив"], false]]);
  });
});

// ── A2 ───────────────────────────────────────────────────────────────────────

describe("A2 · polygon forced from the source text", () => {
  // 83469534 ★ — "в карето между …" with is_polygon=false, so the pin fell back
  // to the centroid of the first street, 1.4 km from the block.
  it("sets is_polygon when the message says карето and ≥3 streets are listed", () => {
    const streets = ["бул. Владислав", "ул. Беласица", "ул. Хан Пресиян", "ул. Девня", "бул. Левски"];
    const out = run([inArea("карето", streets)],
      "Без вода ще бъдат: в карето между бул. Владислав, ул. Беласица, ул. Хан Пресиян, ул. Девня и бул. Левски");
    expect(shape(out)).toEqual([[null, null, streets, true]]);
  });

  it("leaves a two-street list alone — that is not a block", () => {
    const out = run([location("Тополи", null, ["ул. Тракийска", "ул. Дубровник"])],
      "Без вода: Тополи, между ул. Тракийска и ул. Дубровник");
    expect(out.locations[0]!.is_polygon).toBe(false);
  });

  it("does not invent a polygon without a cue in the message", () => {
    const out = run([location("Варна", null, ["ул. Пловдив", "ул. Дубровник", "ул. Драва"])],
      "Без вода ще бъдат: ул. Пловдив, ул. Дубровник, ул. Драва");
    expect(out.locations[0]!.is_polygon).toBe(false);
  });

  // The keep-test is the street list alone. Under the flat schema this arrived
  // as location_name "карето", A1 nulled it and the entry was dropped; now the
  // settlement survives A1, so keeping the entry would leave a polygon with no
  // geometry to build — which enrichLocations demotes to a region-wide push to
  // the whole city.
  it("drops a polygon left with no streets to build from", () => {
    const out = run([location("гр. Варна", "карето", [], true)],
      "Без вода в карето между улиците");
    expect(out.locations).toEqual([]);
  });
});

// ── A3 ───────────────────────────────────────────────────────────────────────

describe("A3 · city-wide guard", () => {
  const guard = (name: string, message: string) =>
    applyCityWideGuard(parse([location(name)]), message);

  it.each(["град Варна", "гр. Варна", "Варна", "гр.Варна"])(
    "still normalizes a lone '%s' when the message says city-wide", (name) => {
      const fixed = guard(name, "Прекъсване за всички абонати на територията на гр. Варна");
      expect(fixed.city_wide).toBe(true);
      expect(fixed.locations).toEqual([]);
    });

  it.each([
    "Без вода ще остане цялата Варна",
    "Спиране на водата в целия град",
    "Прекъсване за всички клиенти",
  ])("recognises '%s' as city-wide", (message) => {
    expect(guard("Варна", message).city_wide).toBe(true);
  });

  // 02a87cbf +4 — the model lost "кв. Владислав Варненчик" from
  // "гр. Варна - кв. Владислав Варненчик" and emitted just "Варна". The old
  // guard turned that into city_wide, and sendUsersNotification answers
  // city_wide with getAllUserIds: five extraction failures were broadcast.
  it("does NOT broadcast a lone Варна the message never called city-wide", () => {
    const fixed = guard("Варна", "Прекъсване на електрозахранването гр. Варна - кв. Владислав Варненчик");
    expect(fixed.city_wide).toBe(false);
    expect(fixed.locations).toHaveLength(1);
  });

  // The guard tests `area ?? settlement`, which is what the flat schema held in
  // location_name. Testing the settlement alone would break here: the prompt
  // used to suppress the city, so "Варна and nothing else" only came out of a
  // failed extraction — now it is on every Varna entry, and this correctly
  // parsed district would become a broadcast on a stray phrase in the
  // boilerplate.
  it("does NOT broadcast a district that named its city, phrase or not", () => {
    const fixed = applyCityWideGuard(
      parse([location("гр. Варна", "кв. Виница")]),
      "Прекъсване за всички абонати в кв. Виница");
    expect(fixed.city_wide).toBe(false);
    expect(fixed.locations).toHaveLength(1);
  });

  it("leaves real locations alone", () => {
    const message = "Прекъсване за всички абонати"; // even with the phrase present
    for (const out of [
      parse([location("Тополи")]),
      parse([location("Варна", null, ["ул. Дубровник"])]),
      parse([location("Варна"), location("Тополи")]),
    ]) {
      expect(applyCityWideGuard(out, message)).toEqual(out);
    }
  });
});

// ── A8 ───────────────────────────────────────────────────────────────────────

describe("A8 · city-wide demotion", () => {
  const guard = (cityWide: boolean, message: string) =>
    applyCityWideGuard(parse([], cityWide), message);

  // A3 only ever promoted INTO city-wide, so a city_wide the model invented
  // outright reached sendUsersNotification unchecked — and an empty location
  // list there is answered with a broadcast. The widest action in the system
  // was running on the prompt's word alone.
  it("demotes a city_wide the message never claims", () => {
    const fixed = guard(true, "Прекъсване на водоснабдяването в кв. Аспарухово");
    expect(fixed.city_wide).toBe(false);
    expect(fixed.locations).toEqual([]);
  });

  it.each([
    "Без вода ще остане цялата Варна",
    "Прекъсване за всички абонати",
    "Авария на територията на цялата община",
  ])("keeps a city_wide the message does claim: '%s'", (message) => {
    expect(guard(true, message).city_wide).toBe(true);
  });

  // Demotion must not become a way to turn a store-only alert into a broadcast.
  it("never promotes an empty parse that was already false", () => {
    expect(guard(false, "Прекъсване за всички абонати").city_wide).toBe(false);
  });

  it("runs as part of normalizeParse, not just standalone", () => {
    const out = normalizeParse(parse([], true), "Авария на ул. Дубровник", refs);
    expect(out.city_wide).toBe(false);
  });
});

// ── A4 ───────────────────────────────────────────────────────────────────────

describe("A4 · region-like entries in the street list", () => {
  // 406268df +8 — epro publishes "гр. Варна - кв. Младост"; the flat schema had
  // no slot for it, so the district landed in the street array and targeted
  // nobody (no street of that name, and the region resolved to plain Варна).
  // There is a slot now, so it moves into it and the city stays where it is.
  it("moves an unprefixed district into the empty area slot", () => {
    const out = run([location("Варна", null, ["Младост"])],
      "Прекъсване на електрозахранването гр. Варна - кв. Младост");
    expect(shape(out)).toEqual([["Варна", "Младост", [], false]]);
  });

  it("resolves an alias-only district the same way", () => {
    const out = run([location("Варна", null, ["Владислав Варненчик"])],
      "Прекъсване гр. Варна - кв. Владислав Варненчик");
    expect(shape(out)).toEqual([["Варна", "Владислав Варненчик", [], false]]);
  });

  // Street FIRST, then the districts: a flat list of siblings, so the street is
  // not theirs and the city keeps it. See the ordering block for the other order.
  it("keeps a leading street with the city when several districts follow", () => {
    const out = run([location("Варна", null, ["ул. Пловдив", "кв. Аспарухово", "м-т Фичоза"])],
      "Прекъсване гр. Варна - част от: ул. Пловдив, кв. Аспарухово и м-т Фичоза");
    expect(shape(out)).toEqual([
      ["Варна", null, ["ул. Пловдив"], false],
      ["Варна", "кв. Аспарухово", [], false],
      ["Варна", "м-т Фичоза", [], false],
    ]);
  });

  it("leaves genuine streets in the street array", () => {
    const out = run([location("гр. Варна", null, ["ул. Дубровник", "ул. Пловдив"])],
      "Без вода ще бъдат: гр. Варна, ул. Дубровник, ул. Пловдив");
    expect(shape(out)).toEqual([["гр. Варна", null, ["ул. Дубровник", "ул. Пловдив"], false]]);
  });

  it("does not lift an unprefixed name when no settlement was named", () => {
    // Only the "гр. X - кв. Y" shape is ambiguous; elsewhere a bare name in the
    // street array is a street, and "Младост" is both.
    const out = run([inArea("кв. Аспарухово", ["Младост"])],
      "Без вода: кв. Аспарухово, ул. Младост");
    expect(shape(out)).toEqual([[null, "кв. Аспарухово", ["Младост"], false]]);
  });

  // Once the model has STATED an area, the ambiguity is gone: the message
  // already named its district, so a bare "Младост" beside it is the street.
  it("does not lift an unprefixed name when the area slot is already filled", () => {
    const out = run([location("гр. Варна", "кв. Виница", ["Младост"])],
      "Прекъсване гр. Варна - кв. Виница, ул. Младост");
    expect(shape(out)).toEqual([["гр. Варна", "кв. Виница", ["Младост"], false]]);
  });

  // The slot is taken, so the second district cannot go in it — it becomes its
  // own entry, repeating the settlement, and the streets stay where they were.
  it("splits a district off when the area slot is occupied", () => {
    const out = run([location("гр. Варна", "кв. Виница", ["ул. Пловдив", "м-т Фичоза"])],
      "Прекъсване гр. Варна - кв. Виница, ул. Пловдив и м-т Фичоза");
    expect(shape(out)).toEqual([
      ["гр. Варна", "кв. Виница", ["ул. Пловдив"], false],
      ["гр. Варна", "м-т Фичоза", [], false],
    ]);
  });

  // The shape this whole rule exists to stop needing: correctly slotted input
  // has to survive untouched.
  it("passes a correctly slotted entry through unchanged", () => {
    const out = run([location("гр. Варна", "кв. Виница", ["ул. Дубровник", "ул. Пловдив"])],
      "Прекъсване гр. Варна - кв. Виница, ул. Дубровник, ул. Пловдив");
    expect(shape(out)).toEqual([["гр. Варна", "кв. Виница", ["ул. Дубровник", "ул. Пловдив"], false]]);
  });

  it("lifts a … зона name but not the street called one", () => {
    expect(shape(run([location("Варна", null, ["Западна промишлена зона"])], "Прекъсване гр. Варна")))
      .toEqual([["Варна", "Западна промишлена зона", [], false]]);
    expect(shape(run([location("Варна", null, ["за вододайната зона"])], "Прекъсване гр. Варна")))
      .toEqual([["Варна", null, ["за вододайната зона"], false]]);
  });

  it("leaves a polygon's street list untouched", () => {
    const streets = ["ул. Беласица", "ул. Девня", "Младост"];
    const out = run([inArea("карето", streets)], "в карето между ул. Беласица, ул. Девня и Младост");
    expect(shape(out)).toEqual([[null, null, streets, true]]);
  });
});

// ── A4 · ordering ────────────────────────────────────────────────────────────

describe("A4 · ordering decides whether the district owns the streets", () => {
  // 72a4eff6 — "гр. Варна - кв. Виница, ул. Свети Пророк Илия, …". The district
  // is stated before its own streets, so it takes the area slot and keeps them.
  it("hands the streets listed after a district to that district", () => {
    const out = run([location("Варна", null, ["кв. Аспарухово", "ул. Пловдив", "ул. Драва"])],
      "Прекъсване гр. Варна - кв. Аспарухово, ул. Пловдив, ул. Драва, електрозахранени от ТП 1650.");
    expect(shape(out)).toEqual([["Варна", "кв. Аспарухово", ["ул. Пловдив", "ул. Драва"], false]]);
  });

  it("works for an unprefixed district too", () => {
    const out = run([location("гр. Варна", null, ["Младост", "ул. Пловдив"])],
      "Прекъсване гр. Варна - кв. Младост, ул. Пловдив");
    expect(shape(out)).toEqual([["гр. Варна", "Младост", ["ул. Пловдив"], false]]);
  });

  // aafa1f67 — "гр. Варна - част от: ул. Арх. Стоян Доков, м-ст Ваялар и м-ст
  // Свети Никола". Siblings, not ownership: filling the area slot here would
  // attach that street to the locality and narrow it to that one street.
  //
  // This is why the ordering test survived the three-slot split. Without it the
  // district would take the empty area slot and swallow the leading street.
  it("declines when a street precedes the district", () => {
    const out = run([location("град Варна", null, ["ул. Пловдив", "м-т Фичоза"])],
      "Прекъсване град Варна - част от: ул. Пловдив и м-т Фичоза");
    expect(shape(out)).toEqual([
      ["град Варна", null, ["ул. Пловдив"], false],
      ["град Варна", "м-т Фичоза", [], false],
    ]);
  });

  // Which of the two owns them is unknowable from a flat list, and guessing
  // wrong silences everyone in the district that did not get them.
  it("declines when more than one district was lifted", () => {
    const out = run([location("Варна", null, ["кв. Аспарухово", "м-т Фичоза", "ул. Пловдив"])],
      "Прекъсване гр. Варна - кв. Аспарухово, м-т Фичоза, ул. Пловдив");
    expect(shape(out)).toEqual([
      ["Варна", null, ["ул. Пловдив"], false],
      ["Варна", "кв. Аспарухово", [], false],
      ["Варна", "м-т Фичоза", [], false],
    ]);
  });

  // 42b91cf8 — the shape with no district at all. The city stays: area-first
  // pinning keeps the marker off an arbitrary street, and getUserIdsInRange
  // still targets by street id within Варна rather than city-wide.
  it("leaves a street-only city alone", () => {
    const out = run([location("гр. Варна", null, ["ул. Пловдив 25", "ул. Драва 2А"])],
      "Прекъсване гр. Варна – ул. Пловдив 25; ул. Драва 2А, електрозахранени от ТП 450.");
    expect(shape(out)).toEqual([["гр. Варна", null, ["ул. Пловдив", "ул. Драва"], false]]);
  });

  // Only a bare settlement introduces its districts. Under a stated area the
  // streets are already where they belong, and a nested lift would move them
  // somewhere worse.
  it("does not fire when no settlement was named", () => {
    const out = run([inArea("кв. Владиславово", ["м-т Фичоза", "ул. Пловдив"])],
      "Без вода: кв. Владиславово, м-т Фичоза, ул. Пловдив");
    expect(shape(out)).toEqual([
      [null, "кв. Владиславово", ["ул. Пловдив"], false],
      [null, "м-т Фичоза", [], false],
    ]);
  });
});

// ── A5 ───────────────────────────────────────────────────────────────────────

describe("A5 · trailing address detail", () => {
  it.each([
    ["ул. Пловдив 25", "ул. Пловдив"],
    ["бул. Чаталджа 20 вх. Б.", "бул. Чаталджа"],
    ["ул. Драва бл 66 до бл 70", "ул. Драва"],
    ["ул. Христо Ботев 3", "ул. Христо Ботев"],
    ["ул. Драва 2А", "ул. Драва"],
    ["ул. Ген. Колев ет. 3", "ул. Ген. Колев"],
  ])("strips %s to %s", (raw, want) => {
    expect(stripAddressDetail(raw)).toBe(want);
  });

  it.each([
    "ул.7",                 // a truncated ordinal, not a house number
    "ул. 25-та",            // every numeric street name is an ordinal
    "ул. 8-ми Ноември",
    "ул. Иван Етърски",     // must not be read as "ул. Иван" + ет. + "ърски"
    "ал. 1",                // only ул./бул. carry house numbers
    "ж.к. Възраждане 1",    // a district's number is part of its name
    "Зеленика 9",
    "бул. Владислав Варненчик",
  ])("leaves %s alone", (raw) => {
    expect(stripAddressDetail(raw)).toBe(raw);
  });

  it("strips through the whole street list of an alert", () => {
    const out = run(
      [inArea("кв. Владиславово", ["ул. Пловдив 25", "бул. Чаталджа 20 вх. Б.", "ал. 1"])],
      "Прекъсване в кв. Владиславово, ул. Пловдив 25, бул. Чаталджа 20 вх. Б.");
    expect(out.locations[0]!.streets).toEqual(["ул. Пловдив", "бул. Чаталджа", "ал. 1"]);
  });
});

// ── A6 ───────────────────────────────────────────────────────────────────────

describe("A6 · hedged street lists target the region", () => {
  const wide = (out: ProcessedData) => out.locations.map((l) => l.region_wide === true);

  it.each([
    "Без вода ще бъдат абонатите в района на ул. Пловдив и ул. Драва",
    "Без вода: района около ул. Пловдив и ул. Драва",
    "Прекъсване в близост до ул. Пловдив и ул. Драва",
    "Ремонт на ул. Пловдив и прилежащите улици",
    "Ремонт на ул. Пловдив и околните улици",
  ])("marks the location region-wide for %s", (message) => {
    const out = run([inArea("кв. Аспарухово", ["ул. Пловдив", "ул. Драва"])], message);
    expect(wide(out)).toEqual([true]);
  });

  it("leaves an enumerated street list alone — that one means the streets", () => {
    const out = run([inArea("кв. Аспарухово", ["ул. Пловдив", "ул. Драва"])],
      "Без вода ще бъдат: ул. Пловдив, ул. Драва");
    expect(wide(out)).toEqual([false]);
  });

  // A1 already drops the bare noun; the cue must not fire on it either, or every
  // message containing the word "район" would widen.
  it("does not fire on the standalone noun 'района'", () => {
    const out = run([inArea("кв. Аспарухово", ["ул. Пловдив"])],
      "Без вода ще бъде района: ул. Пловдив");
    expect(wide(out)).toEqual([false]);
  });

  it("does not mark a location that names no streets", () => {
    const out = run([inArea("кв. Аспарухово")], "Без вода в района на кв. Аспарухово");
    expect(wide(out)).toEqual([false]);
  });

  // A2 is the more specific claim: "между" names a block, and a block is exactly
  // the bounded shape A6 exists to avoid asserting.
  it("does not mark a block polygon", () => {
    const streets = ["бул. Владислав", "ул. Беласица", "ул. Девня"];
    const out = run([inArea("карето", streets)],
      "Без вода в карето между бул. Владислав, ул. Беласица и ул. Девня, в района на кв. Владиславово");
    expect(out.locations[0]!.is_polygon).toBe(true);
    expect(wide(out)).toEqual([false]);
  });

  // The district took the area slot and kept the streets, so the marker lands on
  // it — the marker belongs on whichever entry carries streets.
  it("marks the district that took the streets", () => {
    const out = run([location("Варна", null, ["Младост", "ул. Пловдив"])],
      "Прекъсване гр. Варна - кв. Младост, в района на ул. Пловдив");
    expect(shape(out)).toEqual([["Варна", "Младост", ["ул. Пловдив"], false]]);
    expect(wide(out)).toEqual([true]);
  });

  // The flat-list order, where the city keeps the street: the marker stays on it.
  it("marks the city when it is left holding the streets", () => {
    const out = run([location("Варна", null, ["ул. Пловдив", "кв. Аспарухово", "м-т Фичоза"])],
      "Прекъсване гр. Варна - част от ул. Пловдив, кв. Аспарухово и м-т Фичоза и прилежащите улици");
    expect(wide(out)).toEqual([true, false, false]);
  });

  it("leaves the streets in place — only targeting widens, not the feed", () => {
    const out = run([inArea("кв. Аспарухово", ["ул. Пловдив", "ул. Драва"])],
      "Без вода в района на ул. Пловдив и ул. Драва");
    expect(out.locations[0]!.streets).toEqual(["ул. Пловдив", "ул. Драва"]);
  });
});

// ── A9 ───────────────────────────────────────────────────────────────────────

describe("A9 · settlement/area coherence", () => {
  // The two slots disagreeing is silent and expensive: targeting follows the
  // area, street scope follows the settlement, so the alert reaches one
  // settlement while its streets are looked up in another. `regions` holds no
  // parent link to check containment with, so the coordinates decide.
  it("drops a settlement that cannot contain its area", () => {
    const out = run([location("с. Аврен", "кв. Виница", ["ул. Пловдив"])],
      "Без вода: с. Аврен, кв. Виница, ул. Пловдив");
    expect(shape(out)).toEqual([[null, "кв. Виница", ["ул. Пловдив"], false]]);
  });

  it("keeps a settlement that does contain its area", () => {
    const out = run([location("гр. Варна", "кв. Виница", ["ул. Пловдив"])],
      "Без вода: гр. Варна, кв. Виница, ул. Пловдив");
    expect(shape(out)).toEqual([["гр. Варна", "кв. Виница", ["ул. Пловдив"], false]]);
  });

  // Only a measured contradiction drops the slot. A name we hold no row for
  // proves nothing, and dropping it there would silently re-scope the streets.
  it("keeps both when either name is unknown to us", () => {
    const out = run([location("с. Аврен", "кв. Незнаен")], "Без вода: с. Аврен, кв. Незнаен");
    expect(shape(out)).toEqual([["с. Аврен", "кв. Незнаен", [], false]]);
  });

  // Migration 0016's link answers containment outright, and outranks the
  // distance estimate — these two are 4 km apart, well inside the 20 km band
  // that would otherwise have kept the pair.
  describe("with the settlement link populated (migration 0016)", () => {
    const varna = row("Варна", 43.2073873, 27.9166653);
    const beloslav = row("Белослав", 43.1958, 27.7042);
    const linked: ReferenceRows = {
      regions: [varna, beloslav, inside(beloslav, row("кв. Виница", 43.2419122, 27.9603219))],
      streets: [],
    };
    const runLinked = (locs: ProcessedData["locations"], message: string) =>
      normalizeParse(parse(locs), message, linked);

    it("drops a settlement the link says does not contain the area", () => {
      const out = runLinked([location("гр. Варна", "кв. Виница")], "Без вода: гр. Варна, кв. Виница");
      expect(shape(out)).toEqual([[null, "кв. Виница", [], false]]);
    });

    it("keeps the settlement the link agrees with", () => {
      const out = runLinked([location("Белослав", "кв. Виница")], "Без вода: Белослав, кв. Виница");
      expect(shape(out)).toEqual([["Белослав", "кв. Виница", [], false]]);
    });
  });

  // Migration 0017 lets two settlements hold a district of the same name, which
  // is what Варна and Белослав really do with "Цветен квартал" — two OSM nodes
  // 17.5 km apart. A9 has to look the area up INSIDE the settlement being
  // tested, or it answers with whichever row it finds first and then judges a
  // perfectly coherent pair incoherent.
  describe("with two districts sharing a name (migration 0017)", () => {
    const varna = row("Варна", 43.2073873, 27.9166653);
    const beloslav = row("Белослав", 43.1958, 27.7042);
    const shared: ReferenceRows = {
      regions: [
        varna, beloslav,
        // A settlement holding no district of that name — the negative case
        // below. It has to be a row A9 can resolve, or the rule bails out for
        // "settlement unknown" and proves nothing.
        row("с. Аврен", 43.1032817, 27.6766949),
        inside(varna, row("Цветен квартал", 43.2238681, 27.9138306)),
        inside(beloslav, row("Цветен квартал", 43.1816837, 27.7038)),
      ],
      streets: [],
    };
    const runShared = (locs: ProcessedData["locations"], message: string) =>
      normalizeParse(parse(locs), message, shared);

    it("keeps Белослав for the Белослав one", () => {
      const out = runShared(
        [location("гр. Белослав", "Цветен квартал")], "Без вода: гр. Белослав, Цветен квартал");
      expect(shape(out)).toEqual([["гр. Белослав", "Цветен квартал", [], false]]);
    });

    it("keeps Варна for the Варна one", () => {
      const out = runShared(
        [location("гр. Варна", "Цветен квартал")], "Без вода: гр. Варна, Цветен квартал");
      expect(shape(out)).toEqual([["гр. Варна", "Цветен квартал", [], false]]);
    });

    // The rule still has to fire: a settlement that holds NEITHER of them is
    // still incoherent, and scoping must not turn A9 into a no-op.
    it("still drops a settlement that holds no district of that name", () => {
      const out = runShared(
        [location("с. Аврен", "Цветен квартал")], "Без вода: с. Аврен, Цветен квартал");
      expect(shape(out)).toEqual([[null, "Цветен квартал", [], false]]);
    });
  });
});
