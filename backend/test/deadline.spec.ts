// Budget primitives (src/shared/deadline.ts) and the fetch retry policy built
// on them. The cron gets ~30 s of wall clock; these are the guards that keep a
// single stuck subrequest from consuming it.

import { fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchPage } from "../src/ingestion/scrape";
import { abortIn, expired, msLeft, sleepWithin, TimeoutError, withTimeout } from "../src/shared/deadline";

describe("deadline helpers", () => {
  it("treats an absent deadline as unbounded", () => {
    expect(msLeft(undefined)).toBe(Infinity);
    expect(expired(undefined)).toBe(false);
  });

  it("reports a spent budget, including the headroom argument", () => {
    expect(expired(Date.now() - 1)).toBe(true);
    expect(expired(Date.now() + 5_000)).toBe(false);
    // 5 s left but 10 s of work needed: already effectively out of budget.
    expect(expired(Date.now() + 5_000, 10_000)).toBe(true);
  });

  it("caps an abort signal at the deadline when it is nearer than the timeout", async () => {
    const signal = abortIn(60_000, Date.now() + 40);
    await new Promise((r) => setTimeout(r, 120));
    expect(signal.aborted).toBe(true);
  });

  it("rejects with TimeoutError when the wrapped promise outlives its budget", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 30, undefined, "stuck")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("passes a value through untouched when it resolves in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 5_000, undefined, "quick")).resolves.toBe("ok");
  });

  it("refuses a sleep that would cross the deadline", async () => {
    expect(await sleepWithin(1_000, Date.now() + 50)).toBe(false);
    expect(await sleepWithin(10, Date.now() + 5_000)).toBe(true);
  });
});

describe("fetchPage retry policy", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  beforeEach(() => fetchMock.assertNoPendingInterceptors());

  const origin = "https://retry.example";

  it("does not retry a permanent status", async () => {
    // Exactly one interceptor: a second attempt would fail the assertion below
    // with an unmatched request. The old loop burned three retries plus 12 s of
    // backoff on a 404 that was never going to change.
    fetchMock.get(origin).intercept({ path: "/gone" }).reply(404, "nope");
    await expect(fetchPage(`${origin}/gone`)).rejects.toThrow(/404/);
    fetchMock.assertNoPendingInterceptors();
  });

  it("retries a transient status and succeeds on the next attempt", async () => {
    fetchMock.get(origin).intercept({ path: "/flaky" }).reply(503, "later");
    fetchMock.get(origin).intercept({ path: "/flaky" }).reply(200, "<html>ok</html>");

    const res = await fetchPage(`${origin}/flaky`);
    expect(await res.text()).toBe("<html>ok</html>");
    fetchMock.assertNoPendingInterceptors();
  });

  it("gives up without a request when the budget is already spent", async () => {
    // No interceptor registered: reaching the network at all would throw a
    // "no matching interceptor" error rather than the budget message.
    await expect(fetchPage(`${origin}/anything`, undefined, Date.now() - 1))
      .rejects.toThrow(/No time budget/);
  });

  it("skips the backoff sleep when the retry cannot fit the budget", async () => {
    fetchMock.get(origin).intercept({ path: "/slow" }).reply(503, "later");

    const startedAt = Date.now();
    // Enough budget to make the first attempt, but not enough for the 2 s
    // backoff before a second — so this surfaces the 503 immediately rather
    // than sleeping into a mid-flight kill.
    await expect(fetchPage(`${origin}/slow`, undefined, Date.now() + 1_500)).rejects.toThrow(/503/);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    fetchMock.assertNoPendingInterceptors();
  });
});
