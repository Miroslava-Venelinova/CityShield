import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVAL_MINUTES,
  SOURCE_INTERVAL_MINUTES,
  TICK_MINUTES,
  isDue,
  ticksFor,
} from "../src/ingestion/schedule";

const TICK_MS = TICK_MINUTES * 60 * 1000;
/** Wall-clock time in the middle of tick `n`, so results don't hinge on boundaries. */
const atTick = (n: number) => n * TICK_MS + TICK_MS / 2;

describe("ticksFor", () => {
  it("converts minutes to ticks", () => {
    // Non-null: the map is a Record<string, number>, so noUncheckedIndexedAccess
    // widens every lookup to `| undefined` — and "vt" missing from the table is
    // itself a failure this test would catch.
    expect(ticksFor("vt")).toBe(SOURCE_INTERVAL_MINUTES.vt! / TICK_MINUTES);
  });

  it("falls back to the default for an unknown source", () => {
    expect(ticksFor("nope")).toBe(DEFAULT_INTERVAL_MINUTES / TICK_MINUTES);
  });

  it("rounds a non-multiple up to the next whole tick", () => {
    // The cron can't fire more precisely than TICK_MINUTES.
    SOURCE_INTERVAL_MINUTES.__test__ = TICK_MINUTES * 2 + 1;
    expect(ticksFor("__test__")).toBe(3);
    delete SOURCE_INTERVAL_MINUTES.__test__;
  });

  it("never returns less than one tick", () => {
    SOURCE_INTERVAL_MINUTES.__test__ = 0;
    expect(ticksFor("__test__")).toBe(1);
    delete SOURCE_INTERVAL_MINUTES.__test__;
  });
});

describe("isDue", () => {
  it("is true on every tick for a source at the tick rate", () => {
    SOURCE_INTERVAL_MINUTES.__test__ = TICK_MINUTES;
    for (let t = 0; t < 6; t++) expect(isDue("__test__", 0, atTick(t))).toBe(true);
    delete SOURCE_INTERVAL_MINUTES.__test__;
  });

  it("fires vik and epro four times an hour", () => {
    const perHour = (s: string, phase: number) => {
      let n = 0;
      for (let t = 0; t < 60 / TICK_MINUTES; t++) if (isDue(s, phase, atTick(t))) n++;
      return n;
    };
    expect(perHour("vik", 0)).toBe(4);
    expect(perHour("epro", 2)).toBe(4);
  });

  it("fires once per interval for a slower source", () => {
    const every = ticksFor("heating");
    const fired = [];
    for (let t = 0; t < every * 3; t++) if (isDue("heating", 0, atTick(t))) fired.push(t);
    expect(fired).toEqual([0, every, every * 2]);
  });

  it("staggers sources that share an interval", () => {
    SOURCE_INTERVAL_MINUTES.__a__ = TICK_MINUTES * 3;
    SOURCE_INTERVAL_MINUTES.__b__ = TICK_MINUTES * 3;
    let collisions = 0;
    for (let t = 0; t < 9; t++) {
      if (isDue("__a__", 0, atTick(t)) && isDue("__b__", 1, atTick(t))) collisions++;
    }
    expect(collisions).toBe(0);
    delete SOURCE_INTERVAL_MINUTES.__a__;
    delete SOURCE_INTERVAL_MINUTES.__b__;
  });

  it("handles a phase larger than the interval without going negative", () => {
    SOURCE_INTERVAL_MINUTES.__test__ = TICK_MINUTES * 2;
    // phase 5 on a 2-tick interval is equivalent to phase 1.
    for (let t = 0; t < 6; t++) {
      expect(isDue("__test__", 5, atTick(t))).toBe(isDue("__test__", 1, atTick(t)));
    }
    delete SOURCE_INTERVAL_MINUTES.__test__;
  });
});
