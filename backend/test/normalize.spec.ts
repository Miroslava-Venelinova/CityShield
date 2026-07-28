// Deterministic guards over the AI parse (guards A1-A6, SPEC.md §1.7).
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

const refs: ReferenceRows = {
  regions: [
    row("Варна", 43.2073873, 27.9166653),
    row("ж.к. Младост", 43.2309578, 27.879652),
    row("кв. Владиславово", 43.2467981, 27.8505253),
    row("Владислав Варненчик", 43.2467981, 27.8505253), // alias row (migration 0013)
    row("кв. Аспарухово", 43.180493, 27.8970978),
    row("Игнатиево", 43.2495548, 27.7747311),
    row("Припек", 43.1742899, 27.7958142),
    row("Баново", 43.2641622, 27.6770879),
    row("м-т Фичоза", 43.1549663, 27.9393622),
  ],
  streets: [
    row("Пловдив"), row("бул. Чаталджа"), row("Драва"), row("Дубровник"),
    row("Беласица"), row("Девня"), row("Младост"), row("за вододайната зона"),
  ],
};

const location = (name: string | null, subs: string[] = [], poly = false) =>
  ({ location_name: name, sublocations: subs, is_polygon: poly });

const parse = (locations: ProcessedData["locations"], cityWide = false): ProcessedData =>
  ({ locations, start_time: null, end_time: null, windows: null, city_wide: cityWide });

const run = (locations: ProcessedData["locations"], message: string, cityWide = false) =>
  normalizeParse(parse(locations, cityWide), message, refs);

/** location_name + sublocations, the shape the assertions care about. */
const shape = (out: ProcessedData) =>
  out.locations.map((l) => [l.location_name, l.sublocations, l.is_polygon] as const);

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
    expect(out.locations.map((l) => l.location_name))
      .toEqual(["гр. Игнатиево", "с. Припек", "с. Баново"]);
  });

  it("drops a shop but keeps the district beside it", () => {
    const out = run([location("ЖК Възраждане"), location("м-н Бурлекс")],
      "Без вода ще бъдат: ЖК Възраждане, м-н Бурлекс");
    expect(out.locations.map((l) => l.location_name)).toEqual(["ЖК Възраждане"]);
  });

  it("drops only the name when a placeless one carries real streets", () => {
    const out = run([location("карето", ["ул. Пловдив"])], "Ремонт в карето");
    expect(shape(out)).toEqual([[null, ["ул. Пловдив"], false]]);
  });
});

// ── A2 ───────────────────────────────────────────────────────────────────────

describe("A2 · polygon forced from the source text", () => {
  // 83469534 ★ — "в карето между …" with is_polygon=false, so the pin fell back
  // to the centroid of the first street, 1.4 km from the block.
  it("sets is_polygon when the message says карето and ≥3 streets are listed", () => {
    const streets = ["бул. Владислав", "ул. Беласица", "ул. Хан Пресиян", "ул. Девня", "бул. Левски"];
    const out = run([location("карето", streets)],
      "Без вода ще бъдат: в карето между бул. Владислав, ул. Беласица, ул. Хан Пресиян, ул. Девня и бул. Левски");
    expect(shape(out)).toEqual([[null, streets, true]]);
  });

  it("leaves a two-street list alone — that is not a block", () => {
    const out = run([location("Тополи", ["ул. Тракийска", "ул. Дубровник"])],
      "Без вода: Тополи, между ул. Тракийска и ул. Дубровник");
    expect(out.locations[0]!.is_polygon).toBe(false);
  });

  it("does not invent a polygon without a cue in the message", () => {
    const out = run([location("Варна", ["ул. Пловдив", "ул. Дубровник", "ул. Драва"])],
      "Без вода ще бъдат: ул. Пловдив, ул. Дубровник, ул. Драва");
    expect(out.locations[0]!.is_polygon).toBe(false);
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

  it("leaves real locations alone", () => {
    const message = "Прекъсване за всички абонати"; // even with the phrase present
    for (const out of [
      parse([location("Тополи")]),
      parse([location("Варна", ["ул. Дубровник"])]),
      parse([location("Варна"), location("Тополи")]),
    ]) {
      expect(applyCityWideGuard(out, message)).toEqual(out);
    }
  });
});

// ── A4 ───────────────────────────────────────────────────────────────────────

describe("A4 · region-like sublocations", () => {
  // 406268df +8 — epro publishes "гр. Варна - кв. Младост"; the flat schema has
  // no slot for it, so the district landed in the street array and targeted
  // nobody (no street of that name, and the region resolved to plain Варна).
  it("lifts an unprefixed district out from under a bare city", () => {
    const out = run([location("Варна", ["Младост"])],
      "Прекъсване на електрозахранването гр. Варна - кв. Младост");
    expect(shape(out)).toEqual([["Младост", [], false]]);
  });

  it("resolves an alias-only district the same way", () => {
    const out = run([location("Варна", ["Владислав Варненчик"])],
      "Прекъсване гр. Варна - кв. Владислав Варненчик");
    expect(shape(out)).toEqual([["Владислав Варненчик", [], false]]);
  });

  it("lifts a prefixed district out and keeps the streets with the city", () => {
    const out = run([location("Варна", ["кв. Аспарухово", "ул. Пловдив"])],
      "Прекъсване гр. Варна - кв. Аспарухово, ул. Пловдив");
    expect(shape(out)).toEqual([
      ["Варна", ["ул. Пловдив"], false],
      ["кв. Аспарухово", [], false],
    ]);
  });

  it("leaves genuine streets in the street array", () => {
    const out = run([location("гр. Варна", ["ул. Дубровник", "ул. Пловдив"])],
      "Без вода ще бъдат: гр. Варна, ул. Дубровник, ул. Пловдив");
    expect(shape(out)).toEqual([["гр. Варна", ["ул. Дубровник", "ул. Пловдив"], false]]);
  });

  it("does not promote an unprefixed name under a district parent", () => {
    // Only the "гр. X - кв. Y" shape is ambiguous; elsewhere a bare name in the
    // street array is a street, and "Младост" is both.
    const out = run([location("кв. Аспарухово", ["Младост"])],
      "Без вода: кв. Аспарухово, ул. Младост");
    expect(shape(out)).toEqual([["кв. Аспарухово", ["Младост"], false]]);
  });

  it("promotes a … зона name but not the street called one", () => {
    expect(shape(run([location("Варна", ["Западна промишлена зона"])], "Прекъсване гр. Варна")))
      .toEqual([["Западна промишлена зона", [], false]]);
    expect(shape(run([location("Варна", ["за вододайната зона"])], "Прекъсване гр. Варна")))
      .toEqual([["Варна", ["за вододайната зона"], false]]);
  });

  it("leaves a polygon's street list untouched", () => {
    const streets = ["ул. Беласица", "ул. Девня", "Младост"];
    const out = run([location("карето", streets)], "в карето между ул. Беласица, ул. Девня и Младост");
    expect(shape(out)).toEqual([[null, streets, true]]);
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
      [location("кв. Владиславово", ["ул. Пловдив 25", "бул. Чаталджа 20 вх. Б.", "ал. 1"])],
      "Прекъсване в кв. Владиславово, ул. Пловдив 25, бул. Чаталджа 20 вх. Б.");
    expect(out.locations[0]!.sublocations).toEqual(["ул. Пловдив", "бул. Чаталджа", "ал. 1"]);
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
    const out = run([location("кв. Аспарухово", ["ул. Пловдив", "ул. Драва"])], message);
    expect(wide(out)).toEqual([true]);
  });

  it("leaves an enumerated street list alone — that one means the streets", () => {
    const out = run([location("кв. Аспарухово", ["ул. Пловдив", "ул. Драва"])],
      "Без вода ще бъдат: ул. Пловдив, ул. Драва");
    expect(wide(out)).toEqual([false]);
  });

  // A1 already drops the bare noun; the cue must not fire on it either, or every
  // message containing the word "район" would widen.
  it("does not fire on the standalone noun 'района'", () => {
    const out = run([location("кв. Аспарухово", ["ул. Пловдив"])],
      "Без вода ще бъде района: ул. Пловдив");
    expect(wide(out)).toEqual([false]);
  });

  it("does not mark a location that names no streets", () => {
    const out = run([location("кв. Аспарухово")], "Без вода в района на кв. Аспарухово");
    expect(wide(out)).toEqual([false]);
  });

  // A2 is the more specific claim: "между" names a block, and a block is exactly
  // the bounded shape A6 exists to avoid asserting.
  it("does not mark a block polygon", () => {
    const streets = ["бул. Владислав", "ул. Беласица", "ул. Девня"];
    const out = run([location("карето", streets)],
      "Без вода в карето между бул. Владислав, ул. Беласица и ул. Девня, в района на кв. Владиславово");
    expect(out.locations[0]!.is_polygon).toBe(true);
    expect(wide(out)).toEqual([false]);
  });

  // A4 lifts the district out from under the city; the marker belongs on the
  // location that still carries streets, not on the promoted district.
  it("marks only the location left holding streets after A4", () => {
    const out = run([location("Варна", ["Младост", "ул. Пловдив"])],
      "Прекъсване гр. Варна - кв. Младост, в района на ул. Пловдив");
    expect(shape(out)).toEqual([
      ["Варна", ["ул. Пловдив"], false],
      ["Младост", [], false],
    ]);
    expect(wide(out)).toEqual([true, false]);
  });

  it("leaves the streets in place — only targeting widens, not the feed", () => {
    const out = run([location("кв. Аспарухово", ["ул. Пловдив", "ул. Драва"])],
      "Без вода в района на ул. Пловдив и ул. Драва");
    expect(out.locations[0]!.sublocations).toEqual(["ул. Пловдив", "ул. Драва"]);
  });
});

describe("normalizeParse", () => {
  it("does not mutate its input", () => {
    const input = parse([location("Варна", ["Младост", "ул. Пловдив 25"])]);
    const snapshot = JSON.stringify(input);
    normalizeParse(input, "Прекъсване гр. Варна - кв. Младост", refs);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("passes an already-clean parse through unchanged", () => {
    const out = run([location("кв. Аспарухово", ["ул. Пловдив"])],
      "Без вода: кв. Аспарухово, ул. Пловдив");
    expect(shape(out)).toEqual([["кв. Аспарухово", ["ул. Пловдив"], false]]);
  });
});
