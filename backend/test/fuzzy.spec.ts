import { describe, expect, it } from "vitest";
import { bestMatch, POLYGON_RESOLVE_THRESHOLD, similarity, trigrams } from "../src/core/fuzzy";

describe("trigrams", () => {
  it("pads each word with two leading spaces and one trailing (pg_trgm)", () => {
    // "ab" → "  ab " → "  a", " ab", "ab "
    expect(trigrams("ab")).toEqual(new Set(["  a", " ab", "ab "]));
  });

  it("splits on non-alphanumerics and lowercases", () => {
    expect(trigrams("ул. Иван")).toEqual(trigrams("УЛ ИВАН"));
  });
});

describe("similarity", () => {
  it("is 1 for identical strings", () => {
    expect(similarity("Аспарухово", "Аспарухово")).toBe(1);
  });

  it("is symmetric", () => {
    expect(similarity("Левски", "кв Левски")).toBeCloseTo(similarity("кв Левски", "Левски"));
  });

  it("is 0 for empty input", () => {
    expect(similarity("", "")).toBe(0);
    expect(similarity("", "Варна")).toBe(0);
  });

  it("scores unrelated names below the 0.3 threshold", () => {
    expect(similarity("Аспарухово", "Младост")).toBeLessThan(0.3);
  });

  it("scores prefixed variants of the same name above threshold", () => {
    expect(similarity("жк Възраждане", "Възраждане")).toBeGreaterThan(0.3);
  });
});

describe("bestMatch", () => {
  const streets = [
    { id: 1, name: "Александър Дякович" },
    { id: 2, name: "Козлодуй" },
    { id: 3, name: "Русе" },
    { id: 4, name: "Бачо Киро" },
  ];

  it("resolves abbreviated Cyrillic street names (spike 3 case)", () => {
    const match = bestMatch("ул.Ал.Дякович", streets, (s) => s.name, POLYGON_RESOLVE_THRESHOLD);
    expect(match?.id).toBe(1);
  });

  it("returns null when nothing clears the threshold", () => {
    expect(bestMatch("Шипка", streets, (s) => s.name)).toBeNull();
  });

  it("returns the highest-scoring candidate", () => {
    const regions = [
      { id: 1, name: "Владислав Варненчик" },
      { id: 2, name: "Варна" },
    ];
    expect(bestMatch("кв. Владислав Варненчик", regions, (r) => r.name)?.id).toBe(1);
  });
});
