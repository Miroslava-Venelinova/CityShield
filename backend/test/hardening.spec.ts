// Guards for the abuse-resistance work: response headers, the bounds on
// caller-supplied input, and the two limits the ingest path puts on what a
// source website is allowed to make the Worker do.
//
// These are all "the code refuses" behaviours. None of them is visible in a
// happy path, so without a test they regress silently — which is exactly how
// the unbounded fields they replace got there.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { crawlIdListing, type IdListingOptions } from "../src/ingestion/sources/id-listing";
import { MAX_RESPONSE_BYTES, readCapped, resolveSameHost } from "../src/ingestion/scrape";
import { getLastId, writeLastId } from "../src/ingestion/state";
import { api, jsonInit, registerAndLogin } from "./helpers";

describe("security headers", () => {
  it("sets them on a JSON API response", async () => {
    const { token } = await registerAndLogin();
    const res = await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("sets them on the HTML pages a mailed link opens", async () => {
    const res = await api("/api/auth/password/reset?token=whatever");
    expect(res.status).toBe(200);
    // The token is in the URL, so this page above all must not leak a Referer.
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    // ...and must not be kept by anything between us and the browser.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // The page has a <style> block and nothing else — scripts are denied.
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  it("leaves a route's own Cache-Control alone", async () => {
    // /recent is deliberately cacheable public data; the no-store default must
    // not quietly undo the edge cache that keeps D1 row reads in budget.
    const { token } = await registerAndLogin();
    const res = await api("/api/alerts/recent", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("request input bounds", () => {
  it("rejects an oversized password instead of hashing it", async () => {
    // Every accepted password is fed to PBKDF2, so the field is a way to spend
    // the request's CPU budget. No account can hold one this long anyway.
    const res = await api("/api/auth/login",
      jsonInit("POST", { email: "someone@example.com", password: "x".repeat(5000) }));
    expect(res.status).toBe(400);
  });

  it("still accepts a normal-length password", async () => {
    const res = await api("/api/auth/login",
      jsonInit("POST", { email: "nobody@example.com", password: "correct horse battery" }));
    expect(res.status).toBe(401); // unknown account, not a validation failure
  });

  it("rejects an oversized bus-line list", async () => {
    const { token } = await registerAndLogin();
    const res = await api("/api/preferences/bus-lines",
      jsonInit("PUT", { busLines: Array.from({ length: 500 }, () => "31A") }, token));
    expect(res.status).toBe(400);
  });

  it("still accepts a real selection", async () => {
    const { token } = await registerAndLogin();
    const res = await api("/api/preferences/bus-lines",
      jsonInit("PUT", { busLines: ["31A", "209B"] }, token));
    expect(res.status).toBe(204);
  });
});

describe("readCapped", () => {
  it("reads a normal body unchanged", async () => {
    expect(await readCapped(new Response("здравей"))).toBe("здравей");
  });

  it("returns empty for a body-less response", async () => {
    expect(await readCapped(new Response(null, { status: 204 }))).toBe("");
  });

  it("refuses a body that declares itself over the cap", async () => {
    const res = new Response("small", {
      headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
    });
    await expect(readCapped(res)).rejects.toThrow(/cap/);
  });

  it("abandons a body that grows past the cap mid-stream", async () => {
    // The case a Content-Length check cannot catch: a source that streams
    // steadily never trips a timeout, it just fills the isolate.
    const chunk = new Uint8Array(1024);
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
    });
    await expect(readCapped(new Response(stream), 4096)).rejects.toThrow(/cap/);
  });
});

describe("resolveSameHost", () => {
  const base = "https://energy-varna.bg/bg/messages";

  it("absolutizes a relative link", () => {
    expect(resolveSameHost("/node/42", base)).toBe("https://energy-varna.bg/node/42");
  });

  it("keeps an absolute link on the same host", () => {
    expect(resolveSameHost("https://energy-varna.bg/node/42", base))
      .toBe("https://energy-varna.bg/node/42");
  });

  it("rejects another host", () => {
    expect(resolveSameHost("https://attacker.example/node/42", base)).toBeNull();
  });

  it("rejects a lookalike subdomain and a scheme change", () => {
    expect(resolveSameHost("https://energy-varna.bg.attacker.example/node/42", base)).toBeNull();
    expect(resolveSameHost("javascript:alert(1)", base)).toBeNull();
  });

  it("rejects an unparseable href", () => {
    expect(resolveSameHost("", "not a url")).toBeNull();
  });
});

describe("crawlIdListing host pinning", () => {
  const LISTING = "https://example.com/listing";
  const deadline = () => Date.now() + 5000;

  beforeEach(async () => {
    // Past the bootstrap branch, so the crawler actually walks the listing.
    await writeLastId(env, "vik", 1050);
  });

  function makeOpts(urls: string[]): { opts: IdListingOptions; fetched: string[] } {
    const fetched: string[] = [];
    return {
      fetched,
      opts: {
        tag: "TEST",
        category: "vik",
        listingUrl: LISTING,
        idPattern: /(\d+)\.html/,
        parsePage: () => urls,
        parseMessage: async (html) => ({ title: `t-${html}`, content: `c-${html}` }),
        fetchImpl: async (url) => {
          if (url !== LISTING) fetched.push(url);
          return new Response(url);
        },
        processImpl: async () => true,
      },
    };
  }

  it("never fetches a message url the listing points off-host", async () => {
    const { opts, fetched } = makeOpts([
      "https://attacker.example/messages/1053.html",
      "https://example.com/messages/1052.html",
    ]);
    await crawlIdListing(env, deadline(), opts);

    expect(fetched).toEqual(["https://example.com/messages/1052.html"]);
    // The off-host entry is dropped, not treated as the newest message — so it
    // cannot drag the cursor forward past real ones either.
    expect(await getLastId(env, "vik")).toBe(1052);
  });

  it("follows a relative link by resolving it against the listing", async () => {
    const { opts, fetched } = makeOpts(["/messages/1051.html"]);
    await crawlIdListing(env, deadline(), opts);
    expect(fetched).toEqual(["https://example.com/messages/1051.html"]);
  });
});
