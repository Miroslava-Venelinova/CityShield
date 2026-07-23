// Crawl-state repository + the cursor semantics test_common.py encodes:
// oldest-first, advance only past successes, a failure blocks newer messages,
// the per-tick cap, the deadline guard.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { crawlIdListing, type IdListingOptions } from "../src/ingestion/sources/id-listing";
import { addSeenIds, getLastId, getSeenIds, MAX_SEEN_IDS, mergeSeenIds, writeLastId } from "../src/ingestion/state";

describe("crawl state", () => {
  it("defaults: last_id 0, seen_ids []", async () => {
    expect(await getLastId(env, "nope")).toBe(0);
    expect(await getSeenIds(env, "nope")).toEqual([]);
  });

  it("round-trips the numeric cursor", async () => {
    await writeLastId(env, "vik", 1052);
    expect(await getLastId(env, "vik")).toBe(1052);
    await writeLastId(env, "vik", 1053);
    expect(await getLastId(env, "vik")).toBe(1053);
  });

  it("appends seen ids without duplicates", async () => {
    await addSeenIds(env, "vt", ["a", "b"]);
    await addSeenIds(env, "vt", ["b", "c"]);
    expect(await getSeenIds(env, "vt")).toEqual(["a", "b", "c"]);
  });

  it("caps merged seen ids at MAX_SEEN_IDS, dropping the oldest", () => {
    const existing = Array.from({ length: MAX_SEEN_IDS }, (_, i) => `id${i}`);
    const merged = mergeSeenIds(existing, ["new1", "new2"]);
    expect(merged).toHaveLength(MAX_SEEN_IDS);
    expect(merged.at(-1)).toBe("new2");
    expect(merged).not.toContain("id0");
    expect(merged).not.toContain("id1");
  });
});

describe("crawlIdListing cursor semantics", () => {
  const listing = (ids: number[]) => ids.map((id) => `https://example.com/messages/${id}.html`);

  function makeOpts(urls: string[], outcomes: Record<number, boolean>): {
    opts: IdListingOptions;
    processedIds: number[];
  } {
    const processedIds: number[] = [];
    const opts: IdListingOptions = {
      tag: "TEST",
      category: "vik",
      listingUrl: "https://example.com/listing",
      idPattern: /(\d+)\.html/,
      parsePage: () => urls,
      parseMessage: (html) => ({ title: `t-${html}`, content: `c-${html}` }),
      fetchImpl: async (url) => new Response(url),
      processImpl: async (_env, _tag, _cat, _title, _content, msgRef) => {
        const id = Number(msgRef.replace("id=", ""));
        processedIds.push(id);
        return outcomes[id] ?? true;
      },
    };
    return { opts, processedIds };
  }

  const deadline = () => Date.now() + 5000;

  it("first run bootstraps the cursor to the newest id without processing history", async () => {
    const { opts, processedIds } = makeOpts(listing([1053, 1052, 1050]), {});
    await crawlIdListing(env, deadline(), opts);
    expect(processedIds).toEqual([]); // nothing ingested, nothing notified
    expect(await getLastId(env, "vik")).toBe(1053);

    // A later message is processed normally.
    const second = makeOpts(listing([1054, 1053, 1052]), {});
    await crawlIdListing(env, deadline(), second.opts);
    expect(second.processedIds).toEqual([1054]);
    expect(await getLastId(env, "vik")).toBe(1054);
  });

  it("processes new messages oldest-first and advances the cursor", async () => {
    await writeLastId(env, "vik", 1050);
    const { opts, processedIds } = makeOpts(listing([1053, 1052, 1050]), {});
    await crawlIdListing(env, deadline(), opts);
    expect(processedIds).toEqual([1052, 1053]);
    expect(await getLastId(env, "vik")).toBe(1053);
  });

  it("a failed message blocks newer ones and holds the cursor", async () => {
    await writeLastId(env, "vik", 1050);
    const { opts, processedIds } = makeOpts(listing([1053, 1052, 1050]), { 1052: false });
    await crawlIdListing(env, deadline(), opts);
    expect(processedIds).toEqual([1052]); // 1053 must wait — re-running can't re-notify
    expect(await getLastId(env, "vik")).toBe(1050);
  });

  it("a mid-run failure keeps earlier successes in the cursor", async () => {
    await writeLastId(env, "vik", 1050);
    const { opts, processedIds } = makeOpts(listing([1052, 1051, 1050]), { 1052: false });
    await crawlIdListing(env, deadline(), opts);
    expect(processedIds).toEqual([1051, 1052]);
    expect(await getLastId(env, "vik")).toBe(1051);
  });

  it("caps work at 2 messages per tick; the rest wait for the next tick", async () => {
    await writeLastId(env, "vik", 1000);
    const { opts, processedIds } = makeOpts(listing([1004, 1003, 1002, 1001]), {});
    await crawlIdListing(env, deadline(), opts);
    expect(processedIds).toEqual([1001, 1002]);
    expect(await getLastId(env, "vik")).toBe(1002);

    // Next tick picks up where the cursor left off.
    const second = makeOpts(listing([1004, 1003, 1002, 1001]), {});
    await crawlIdListing(env, deadline(), second.opts);
    expect(second.processedIds).toEqual([1003, 1004]);
    expect(await getLastId(env, "vik")).toBe(1004);
  });

  it("persists the cursor per success, so a mid-batch kill can't re-notify", async () => {
    // Reproduces the production incident: message 1051 is stored + pushed, then
    // 1052's processing hangs (a slow AI parse) until the runner's withTimeout
    // aborts source.run() — before any post-loop write could run. The cursor
    // MUST already reflect 1051, or the next tick re-notifies it.
    await writeLastId(env, "vik", 1050);
    const processedIds: number[] = [];
    const opts: IdListingOptions = {
      tag: "TEST",
      category: "vik",
      listingUrl: "https://example.com/listing",
      idPattern: /(\d+)\.html/,
      parsePage: () => listing([1052, 1051, 1050]),
      parseMessage: (html) => ({ title: `t-${html}`, content: `c-${html}` }),
      fetchImpl: async (url) => new Response(url),
      processImpl: async (_env, _tag, _cat, _title, _content, msgRef) => {
        const id = Number(msgRef.replace("id=", ""));
        processedIds.push(id);
        if (id === 1051) return true; // stored + pushed
        await new Promise(() => {}); // 1052 hangs forever
        return true;
      },
    };

    // Race the crawl against a short timeout, exactly like runner.ts does.
    await Promise.race([
      crawlIdListing(env, Date.now() + 5000, opts),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);

    expect(processedIds).toEqual([1051, 1052]);
    expect(await getLastId(env, "vik")).toBe(1051); // 1051's delivery is committed
  });

  it("stops cleanly when the deadline is already exceeded", async () => {
    await writeLastId(env, "vik", 1050);
    const { opts, processedIds } = makeOpts(listing([1052, 1051]), {});
    await crawlIdListing(env, Date.now() - 1, opts);
    expect(processedIds).toEqual([]);
    expect(await getLastId(env, "vik")).toBe(1050);
  });

  it("ignores urls without a numeric id and stops at the cursor", async () => {
    await writeLastId(env, "vik", 1052);
    const urls = ["https://example.com/about", ...listing([1053, 1052, 1051])];
    const { opts, processedIds } = makeOpts(urls, {});
    await crawlIdListing(env, deadline(), opts);
    expect(processedIds).toEqual([1053]);
    expect(await getLastId(env, "vik")).toBe(1053);
  });
});
