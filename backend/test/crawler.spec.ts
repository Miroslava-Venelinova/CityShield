// Crawl-state repository + the cursor semantics test_common.py encodes:
// oldest-first, advance only past successes, a failure blocks newer messages,
// the per-tick cap, the deadline guard.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { crawlIdListing, type IdListingOptions } from "../src/ingestion/sources/id-listing";
import { crawlIdProbe, STALE_CURSOR_MS, type IdProbeOptions } from "../src/ingestion/sources/id-probe";
import {
  addSeenIds, getLastId, getLastIdUpdatedAt, getSeenIds, MAX_SEEN_IDS, mergeSeenIds, writeLastId,
} from "../src/ingestion/state";

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

  it("reports when the cursor last moved, null before there is a row", async () => {
    expect(await getLastIdUpdatedAt(env, "cursor-age")).toBeNull();
    await writeLastId(env, "cursor-age", 1);
    const updatedAt = await getLastIdUpdatedAt(env, "cursor-age");
    expect(Date.now() - Date.parse(updatedAt!)).toBeLessThan(5000);
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

describe("crawlIdProbe cursor semantics", () => {
  const CATEGORY = "probe";
  const messageUrl = (id: number) => `https://example.com/messages/${id}.html`;
  const LISTING_URL = "https://example.com/listing";

  /**
   * Fake site: `pages` lists the ids that hold a message. Every other id
   * answers 200 with the empty shell vikvarna serves for an unused id, which
   * the parser reports as a miss.
   */
  function makeOpts(
    pages: number[],
    { outcomes = {}, listed = [], failing = [] }: {
      outcomes?: Record<number, boolean>;
      listed?: number[];
      failing?: number[];
    } = {},
  ): { opts: IdProbeOptions; processedIds: number[]; fetched: string[] } {
    const processedIds: number[] = [];
    const fetched: string[] = [];
    const opts: IdProbeOptions = {
      tag: "TEST",
      category: CATEGORY,
      messageUrl,
      listingUrl: LISTING_URL,
      idPattern: /(\d+)\.html/,
      parsePage: () => listed.map(messageUrl),
      parseMessage: (html) => (html === "" ? null : { title: `t-${html}`, content: `c-${html}` }),
      fetchImpl: async (url) => {
        fetched.push(url);
        if (url === LISTING_URL) return new Response("listing");
        const id = Number(/(\d+)\.html/.exec(url)![1]);
        if (failing.includes(id)) throw new Error(`HTTP 503 for ${url}`);
        return new Response(pages.includes(id) ? `body-${id}` : "");
      },
      processImpl: async (_env, _tag, _cat, _title, _content, msgRef) => {
        const id = Number(msgRef.replace("id=", ""));
        processedIds.push(id);
        return outcomes[id] ?? true;
      },
    };
    return { opts, processedIds, fetched };
  }

  const deadline = () => Date.now() + 5000;
  /** Backdate the cursor without moving it, to age it past STALE_CURSOR_MS. */
  const ageCursor = (ms: number) =>
    env.DB.prepare("UPDATE crawl_state SET updated_at = ? WHERE source = ?")
      .bind(new Date(Date.now() - ms).toISOString(), CATEGORY).run();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM crawl_state WHERE source = ?").bind(CATEGORY).run();
  });

  it("first run seeds the cursor from the listing without processing history", async () => {
    const { opts, processedIds } = makeOpts([1050, 1051, 1052], { listed: [1052, 1051, 1050] });
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([]); // nothing ingested, nothing notified
    expect(await getLastId(env, CATEGORY)).toBe(1052);
  });

  it("first run leaves the cursor unset when the listing cannot be read", async () => {
    const { opts } = makeOpts([1050], { listed: [] });
    await crawlIdProbe(env, deadline(), opts);
    // No row written, so the next tick retries the seed rather than walking
    // the id space from 1.
    expect(await getLastIdUpdatedAt(env, CATEGORY)).toBeNull();
  });

  it("walks ids forward from the cursor, oldest-first", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, processedIds } = makeOpts([1051, 1052]);
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([1051, 1052]);
    expect(await getLastId(env, CATEGORY)).toBe(1052);
  });

  it("stops after 3 consecutive empty ids, leaving the cursor where it was", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, processedIds, fetched } = makeOpts([]);
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([]);
    expect(fetched).toEqual([1051, 1052, 1053].map(messageUrl));
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });

  it("steps over a hole under a message — the success writes the cursor past it", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, processedIds } = makeOpts([1053]); // 1051, 1052 are dead
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([1053]);
    expect(await getLastId(env, CATEGORY)).toBe(1053);
  });

  it("caps work at 2 messages per tick; the rest wait for the next tick", async () => {
    await writeLastId(env, CATEGORY, 1000);
    const pages = [1001, 1002, 1003, 1004];
    const first = makeOpts(pages);
    await crawlIdProbe(env, deadline(), first.opts);
    expect(first.processedIds).toEqual([1001, 1002]);
    expect(await getLastId(env, CATEGORY)).toBe(1002);

    const second = makeOpts(pages);
    await crawlIdProbe(env, deadline(), second.opts);
    expect(second.processedIds).toEqual([1003, 1004]);
    expect(await getLastId(env, CATEGORY)).toBe(1004);
  });

  it("a failed message blocks newer ones and holds the cursor", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, processedIds } = makeOpts([1051, 1052], { outcomes: { 1051: false } });
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([1051]); // 1052 must wait — re-running can't re-notify
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });

  it("a mid-walk failure keeps the earlier success in the cursor", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, processedIds } = makeOpts([1051, 1052], { outcomes: { 1052: false } });
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([1051, 1052]);
    expect(await getLastId(env, CATEGORY)).toBe(1051);
  });

  it("a fetch failure stops the walk instead of counting as an empty id", async () => {
    await writeLastId(env, CATEGORY, 1050);
    // 1051 is unreachable; 1052 holds a message. Treating the 503 as a miss
    // would ingest 1052 and strand 1051 below the cursor forever.
    const { opts, processedIds, fetched } = makeOpts([1052], { failing: [1051] });
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([]);
    expect(fetched).toEqual([messageUrl(1051)]);
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });

  it("stops cleanly when the deadline is already exceeded", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, processedIds, fetched } = makeOpts([1051, 1052]);
    await crawlIdProbe(env, Date.now() - 1, opts);
    expect(processedIds).toEqual([]);
    expect(fetched).toEqual([]);
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });

  it("does not consult the listing while the cursor is fresh", async () => {
    await writeLastId(env, CATEGORY, 1050);
    const { opts, fetched } = makeOpts([], { listed: [1060] });
    await crawlIdProbe(env, deadline(), opts);
    expect(fetched).not.toContain(LISTING_URL);
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });

  it("steps over a dead run wider than the probe window once the cursor goes stale", async () => {
    // 1051–1059 are dead, so probing alone never reaches 1060 and the source
    // would be wedged for good.
    await writeLastId(env, CATEGORY, 1050);
    await ageCursor(STALE_CURSOR_MS + 60_000);
    const { opts, processedIds, fetched } = makeOpts([1060], { listed: [1060] });
    await crawlIdProbe(env, deadline(), opts);
    expect(processedIds).toEqual([]); // this tick only unwedges the cursor
    expect(fetched).toContain(LISTING_URL);
    expect(await getLastId(env, CATEGORY)).toBe(1059); // next tick lands on 1060

    const next = makeOpts([1060], { listed: [1060] });
    await crawlIdProbe(env, deadline(), next.opts);
    expect(next.processedIds).toEqual([1060]);
    expect(await getLastId(env, CATEGORY)).toBe(1060);
  });

  it("will not jump a stale cursor into the window it just probed", async () => {
    // 1051 is listed but came back empty — a transient fault, not a hole.
    // Jumping to it would skip it for good.
    await writeLastId(env, CATEGORY, 1050);
    await ageCursor(STALE_CURSOR_MS + 60_000);
    const { opts } = makeOpts([], { listed: [1051] });
    await crawlIdProbe(env, deadline(), opts);
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });

  it("will not move a stale cursor backwards when the listing lags behind it", async () => {
    await writeLastId(env, CATEGORY, 1050);
    await ageCursor(STALE_CURSOR_MS + 60_000);
    const { opts } = makeOpts([], { listed: [1040, 1030] });
    await crawlIdProbe(env, deadline(), opts);
    expect(await getLastId(env, CATEGORY)).toBe(1050);
  });
});
