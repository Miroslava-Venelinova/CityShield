// ISO-local datetime handling: the model-output normalizer, the compact window
// formatter used in push bodies, and the Sofia "today" default.

import { describe, expect, it } from "vitest";
import {
  formatWindow, normalizeDateTime, normalizeSchedule, parseWindows, sofiaToday,
} from "../src/shared/datetime";

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

  // With windows the envelope is not what the alert means, so it is not shown.
  it("renders a daily recurrence as the range plus the repeating window", () => {
    expect(formatWindow("2026-07-30T08:30:00", "2026-07-31T17:00:00", {
      from_date: "2026-07-30", to_date: "2026-07-31",
      daily: [{ start: "08:30", end: "17:00" }],
    })).toBe("30.07–31.07, 08:30 – 17:00 daily");
  });

  it("renders several windows in one day as a list", () => {
    expect(formatWindow("2026-07-30T09:00:00", "2026-07-30T17:00:00", {
      from_date: "2026-07-30", to_date: "2026-07-30",
      daily: [{ start: "09:00", end: "11:00" }, { start: "15:00", end: "17:00" }],
    })).toBe("30.07 09:00 – 11:00, 15:00 – 17:00");
  });
});

// The schedule → (envelope, windows) conversion behind migration 0012.
describe("normalizeSchedule", () => {
  const schedule = (from: string | null, to: string | null, windows: unknown[]) =>
    ({ from_date: from, to_date: to, windows });

  it("leaves a single window on a single day as just the envelope", () => {
    expect(normalizeSchedule(
      schedule("2026-07-27", "2026-07-27", [{ start: "08:00", end: "13:30" }]), TODAY),
    ).toEqual({
      start_time: "2026-07-27T08:00:00",
      end_time: "2026-07-27T13:30:00",
      windows: null,
    });
  });

  // 13 alerts: "От 30.07 до 31.07 В периода 8:30 до 17:00" means 08:30–17:00 on
  // EACH day. The envelope stays the outer bound; the recurrence is the detail.
  it("keeps a window that repeats across a date range", () => {
    expect(normalizeSchedule(
      schedule("2026-07-30", "2026-07-31", [{ start: "08:30", end: "17:00" }]), TODAY),
    ).toEqual({
      start_time: "2026-07-30T08:30:00",
      end_time: "2026-07-31T17:00:00",
      windows: {
        from_date: "2026-07-30",
        to_date: "2026-07-31",
        daily: [{ start: "08:30", end: "17:00" }],
      },
    });
  });

  // 3 alerts: two windows in one day, flattened by the pair into 09:00–17:00.
  it("keeps several windows in one day", () => {
    const out = normalizeSchedule(schedule("2026-07-25", "2026-07-25", [
      { start: "15:00", end: "17:00" },
      { start: "09:00", end: "11:00" },
    ]), TODAY);
    expect(out.start_time).toBe("2026-07-25T09:00:00");
    expect(out.end_time).toBe("2026-07-25T17:00:00");
    // Sorted by start clock, whatever order the model listed them in.
    expect(out.windows!.daily).toEqual([
      { start: "09:00", end: "11:00" },
      { start: "15:00", end: "17:00" },
    ]);
  });

  it("defaults a dateless schedule to today and normalizes the clocks", () => {
    expect(normalizeSchedule(schedule(null, null, [{ start: "9:00", end: "17:5" }]), TODAY))
      .toEqual({ start_time: `${TODAY}T09:00:00`, end_time: null, windows: null });
  });

  it("accepts the Bulgarian day.month.year the model sometimes writes anyway", () => {
    expect(normalizeSchedule(schedule("27.07.2026", "27.07.2026", [{ start: "08:00", end: "10:00" }]), TODAY)
      .start_time).toBe("2026-07-27T08:00:00");
    // A date with no year takes it from today.
    expect(normalizeSchedule(schedule("27.07", null, [{ start: "08:00", end: null }]), TODAY)
      .start_time).toBe("2026-07-27T08:00:00");
  });

  it("rolls a single-day window that crosses midnight onto the next day", () => {
    const out = normalizeSchedule(schedule(TODAY, TODAY, [{ start: "22:00", end: "06:00" }]), TODAY);
    expect(out.start_time).toBe("2026-07-25T22:00:00");
    expect(out.end_time).toBe("2026-07-26T06:00:00");
  });

  it("keeps only the envelope when a window is missing a bound", () => {
    // Half a window cannot be rendered as a repeating one.
    expect(normalizeSchedule(
      schedule("2026-07-30", "2026-07-31", [{ start: "08:30", end: null }]), TODAY).windows,
    ).toBeNull();
  });

  it("collapses a range that ends before it starts", () => {
    const out = normalizeSchedule(
      schedule("2026-07-31", "2026-07-30", [{ start: "08:00", end: "17:00" }]), TODAY);
    expect(out.start_time).toBe("2026-07-31T08:00:00");
    expect(out.end_time).toBe("2026-07-31T17:00:00");
  });

  it("degrades to no time rather than a wrong one", () => {
    for (const bad of [null, undefined, "nope", 42, {}, { windows: "soon" },
      schedule("not-a-date", null, []),
      schedule(null, null, [{ start: "25:00", end: "99:99" }])]) {
      expect(normalizeSchedule(bad, TODAY))
        .toEqual({ start_time: null, end_time: null, windows: null });
    }
  });
});

describe("parseWindows", () => {
  it("round-trips what normalizeSchedule stored", () => {
    const { windows } = normalizeSchedule(
      { from_date: "2026-07-30", to_date: "2026-07-31", windows: [{ start: "08:30", end: "17:00" }] },
      TODAY);
    expect(parseWindows(JSON.stringify(windows))).toEqual(windows);
  });

  it("returns null for NULL, malformed or empty values", () => {
    for (const bad of [null, undefined, "", "{", "[]", '{"from_date":"x"}',
      '{"from_date":"a","to_date":"b","daily":[]}']) {
      expect(parseWindows(bad)).toBeNull();
    }
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
