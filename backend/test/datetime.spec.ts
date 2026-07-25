// ISO-local datetime handling: the model-output normalizer, the compact window
// formatter used in push bodies, and the Sofia "today" default.

import { describe, expect, it } from "vitest";
import { formatWindow, normalizeDateTime, sofiaToday } from "../src/shared/datetime";

const TODAY = "2026-07-25";

describe("normalizeDateTime", () => {
  it("keeps a full ISO datetime, forcing seconds to 00", () => {
    expect(normalizeDateTime("2026-07-27T08:00:00", TODAY)).toBe("2026-07-27T08:00:00");
    expect(normalizeDateTime("2026-07-27T08:00", TODAY)).toBe("2026-07-27T08:00:00");
    expect(normalizeDateTime("2026-07-27T08:00:45", TODAY)).toBe("2026-07-27T08:00:00");
    expect(normalizeDateTime("2026-07-29T17:30:00", TODAY)).toBe("2026-07-29T17:30:00");
  });

  it("zero-pads a single-digit hour", () => {
    expect(normalizeDateTime("2026-07-27T8:05", TODAY)).toBe("2026-07-27T08:05:00");
    expect(normalizeDateTime("2026-07-27 8:05", TODAY)).toBe("2026-07-27T08:05:00");
  });

  it("dates a bare HH:MM to today (Sofia)", () => {
    expect(normalizeDateTime("09:00", TODAY)).toBe("2026-07-25T09:00:00");
    expect(normalizeDateTime("9:00", TODAY)).toBe("2026-07-25T09:00:00");
  });

  it("rejects garbage and out-of-range fields as null (never a wrong window)", () => {
    for (const bad of [null, undefined, "", "  ", "soon", "25:00", "2026-13-01T08:00", "12:99", "2026/07/27 8:00"]) {
      expect(normalizeDateTime(bad, TODAY)).toBeNull();
    }
  });
});

describe("formatWindow", () => {
  it("renders same-day windows without repeating the date", () => {
    expect(formatWindow("2026-07-27T08:00:00", "2026-07-27T17:00:00")).toBe("27.07 08:00 – 17:00");
  });

  it("shows the end date when the window spans days", () => {
    expect(formatWindow("2026-07-27T08:00:00", "2026-07-29T17:00:00")).toBe("27.07 08:00 – 29.07 17:00");
  });

  it("handles open-ended bounds", () => {
    expect(formatWindow("2026-07-27T08:00:00", null)).toBe("from 27.07 08:00");
    expect(formatWindow(null, "2026-07-27T17:00:00")).toBe("until 27.07 17:00");
    expect(formatWindow(null, null)).toBe("");
  });

  it("renders legacy bare clock times as just the time", () => {
    expect(formatWindow("09:00", "17:00")).toBe("09:00 – 17:00");
  });
});

describe("sofiaToday", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(sofiaToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses the Sofia calendar day across the UTC-midnight boundary", () => {
    // 22:30 UTC on 2026-07-24 is already 01:30 on 2026-07-25 in Sofia (UTC+3, DST).
    expect(sofiaToday(new Date("2026-07-24T22:30:00Z"))).toBe("2026-07-25");
    // 00:30 UTC is 03:30 Sofia, same date.
    expect(sofiaToday(new Date("2026-07-25T00:30:00Z"))).toBe("2026-07-25");
  });
});
