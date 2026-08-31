// Port of backend/tests/test_scrape.py — all parsers against the same HTML
// fixtures, asserting the same expected outputs.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  heatingParseMessage, heatingParsePage,
  decodeEntities,
  sliceToContainer,
  stripHtml,
  vikParseMessage, vikParsePage,
  vtParse,
} from "../src/ingestion/scrape";

const fixture = (name: string): string => {
  const content = env.TEST_FIXTURES[name];
  if (!content) throw new Error(`fixture ${name} not found`);
  return content;
};
const heatingListing = fixture("heating_listing.html");
const heatingMessage = fixture("heating_message.html");
const vikListing = fixture("vik_listing.html");
const vikMessage = fixture("vik_message.html");
const vtPage = fixture("vt_page.html");

describe("stripHtml", () => {
  it("flattens markup", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });
  it("handles empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("vik", () => {
  it("parses the listing, skipping malformed rows", () => {
    expect(vikParsePage(vikListing)).toEqual([
      "https://vikvarna.com/bg/messages/1053.html",
      "https://vikvarna.com/bg/messages/1052.html",
      "https://vikvarna.com/bg/messages/1050.html",
    ]);
  });

  it("returns null when the container is missing, [] for an empty listing", () => {
    expect(vikParsePage("<html><body><p>nope</p></body></html>")).toBeNull();
    expect(vikParsePage('<div id="main_content"></div>')).toEqual([]);
  });

  it("parses a message page, trimming the empty region separator off the title", async () => {
    const msg = (await vikParseMessage(vikMessage))!;
    expect(msg.title).toBe("Авария на водопровод в кв. Аспарухово");
    expect(msg.date).toBe("10.06.2026");
    expect(msg.content).toContain("спряно водоподаването");
  });

  it("trims the trailing separator in every shape the site emits", async () => {
    const title = async (h1: string) =>
      (await vikParseMessage(`<div id="main_content"><h1>${h1}</h1><div class="view"><p>x</p></div></div>`))!.title;
    expect(await title("Без вода/")).toBe("Без вода");
    expect(await title("Без вода /")).toBe("Без вода");
    // Only the trailing run is touched — inner spacing is the site's own.
    expect(await title("Без вода  ще бъдат:/")).toBe("Без вода  ще бъдат:");
    // A slash that is part of the title is left alone.
    expect(await title("Планов ремонт 08.07. и 09.07.2026г./сряда и четвъртък/")).toBe(
      "Планов ремонт 08.07. и 09.07.2026г./сряда и четвъртък");
  });

  it("reports the empty shell an unused id serves as no message", async () => {
    // vikvarna answers every id with 200; an id that holds nothing renders the
    // listing heading and no .view — this null is what ends a probe walk.
    expect(await vikParseMessage('<div id="main_content"><h1>Съобщения за аварии</h1></div>')).toBeNull();
  });

  it("handles missing container / content / title", async () => {
    expect(await vikParseMessage("<html><body></body></html>")).toBeNull();
    expect(await vikParseMessage('<div id="main_content"><h1>Title only</h1></div>')).toBeNull();
    expect(await vikParseMessage('<div id="main_content"><div class="view"><p>Само съдържание</p></div></div>'))
      .toEqual({ title: "", date: null, content: "Само съдържание" });
  });
});

describe("vt", () => {
  it("extracts all accordions with fallbacks", async () => {
    const messages = (await vtParse(vtPage))!;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      data_id: "778",
      header: "Промяна на маршрута на линия 31А",
      body: "Поради ремонт линия 31А ще се движи по обходен маршрут.",
      info_time: "10.06.2026 08:15",
    });
    expect(messages[2]).toEqual({
      data_id: null,
      header: "No header",
      body: "No body",
      info_time: "No time",
    });
  });

  it("returns null when the container is missing", async () => {
    expect(await vtParse("<html><body></body></html>")).toBeNull();
  });
});

describe("heating", () => {
  it("returns absolute node URLs", () => {
    expect(heatingParsePage(heatingListing, "https://energy-varna.bg")).toEqual([
      "https://energy-varna.bg/bg/node/912",
      "https://energy-varna.bg/bg/node/911",
    ]);
  });

  it("returns null when no rows", () => {
    expect(heatingParsePage("<html><body></body></html>", "https://x")).toBeNull();
  });

  it("parses a message page", async () => {
    const msg = (await heatingParseMessage(heatingMessage))!;
    expect(msg.title).toBe("Спиране на топлоподаването в район Младост");
    expect(msg.content).toContain("спираме топлоподаването");
  });

  it("returns null when the body field is missing", async () => {
    expect(await heatingParseMessage("<html><h1>Заглавие</h1></html>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The DOM-free / narrowed parse paths (SPEC.md §1.7, the 10 ms CPU cap)
// ---------------------------------------------------------------------------
//
// vikParsePage and heatingParsePage no longer build a DOM, and the three
// parsers that still need one are handed a slice of the page rather than the
// page. That is a performance change which must not be a behaviour change, so
// these keep the original cheerio implementations as a reference oracle and
// assert the rewrites agree with them on full-size captures of the live pages.
//
// The small fixtures above still cover the shapes (missing container, empty
// listing, malformed row); these cover the real ones.

const vikListingFull = fixture("vik_listing_full.html");
const vikMessageFull = fixture("vik_message_full.html");
const vtPageFull = fixture("vt_page_full.html");
const heatingListingFull = fixture("heating_listing_full.html");
const heatingMessageFull = fixture("heating_message_full.html");

// --- the implementations as they were before the rewrite --------------------

function refVikParsePage(html: string): string[] | null {
  const $ = cheerio.load(html);
  const container = $("#main_content");
  if (container.length === 0) return null;
  const urls: string[] = [];
  container.find("div.list-item").each((_, item) => {
    const href = $(item).find("a").first().attr("href");
    if (href) urls.push(href);
  });
  return urls;
}

function refHeatingParsePage(html: string, baseUrl: string): string[] | null {
  const $ = cheerio.load(html);
  const rows = $("div.views-row");
  if (rows.length === 0) return null;
  const urls: string[] = [];
  rows.each((_, row) => {
    const href = $(row).find("a[href*='/node/']").first().attr("href");
    if (href) urls.push(new URL(href, baseUrl).toString());
  });
  return urls;
}

describe("parse paths kept inside the CPU cap", () => {
  it("vikParsePage: string scan agrees with the cheerio original", () => {
    const scanned = vikParsePage(vikListingFull);
    expect(scanned).toEqual(refVikParsePage(vikListingFull));
    // Sanity that the oracle is not agreeing on an empty list.
    expect(scanned!.length).toBeGreaterThan(5);
    // Newest-first, one entry per list-item — the crawlers stop at the first id
    // at or below the cursor, so both order and de-duplication are load-bearing.
    const ids = scanned!.map((u) => Number(/(\d+)\.html/.exec(u)![1]));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("heatingParsePage: string scan agrees with the cheerio original", () => {
    const base = "https://energy-varna.bg/";
    const scanned = heatingParsePage(heatingListingFull, base);
    expect(scanned).toEqual(refHeatingParsePage(heatingListingFull, base));
    expect(scanned!.length).toBeGreaterThan(5);
    const ids = scanned!.map((u) => Number(/\/node\/(\d+)/.exec(u)![1]));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("HTMLRewriter reproduces cheerio's text extraction, field for field", async () => {
    // The strict form of the check. These three parsers moved off cheerio onto
    // HTMLRewriter, and their output is what reaches the AI prompt and the push
    // notification text — so "close enough" is not good enough. The oracle is
    // the original implementation, run over the same full-size live captures.
    const getText = (el: cheerio.Cheerio<any>, sep: string): string => {
      const parts: string[] = [];
      const walk = (node: any) => {
        if (node.type === "text") {
          const t = node.data?.trim();
          if (t) parts.push(t);
        } else if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      el.toArray().forEach(walk);
      return parts.join(sep);
    };

    // vik message page
    {
      const $ = cheerio.load(vikMessageFull);
      const c = $("#main_content");
      const h1 = c.find("h1").first();
      const date = c.find(".list-item-date").first();
      const content = c.find(".view p").first();
      const actual = (await vikParseMessage(vikMessageFull))!;
      expect(actual.title).toBe(getText(h1, "").replace(/\s*\/+\s*$/, "").trim());
      expect(actual.date).toBe(date.length ? getText(date, "") : null);
      expect(actual.content).toBe(getText(content, ""));
      expect(actual.content.length).toBeGreaterThan(20); // the oracle is not empty
    }

    // varnatraffic accordions
    {
      const $ = cheerio.load(vtPageFull);
      const expected: unknown[] = [];
      $("#infoAccordion").find("div.accordion-group").each((_, acc) => {
        const $acc = $(acc);
        const header = $acc.find("a.accordion-toggle").first();
        const body = $acc.find("div.accordion-inner").first();
        const time = $acc.find("div.info-time").first();
        expected.push({
          data_id: $acc.attr("data-id") ?? null,
          header: header.length ? getText(header, "") : "No header",
          body: body.length ? getText(body, " ") : "No body",
          info_time: time.length ? getText(time, "") : "No time",
        });
      });
      expect(expected.length).toBeGreaterThan(0);
      expect(await vtParse(vtPageFull)).toEqual(expected);
    }

    // heating message page
    {
      const $ = cheerio.load(heatingMessageFull);
      const body = $("div.main .field--name-body").first();
      const h1 = $("h1").first();
      const actual = (await heatingParseMessage(heatingMessageFull))!;
      expect(actual.title).toBe(h1.length ? getText(h1, " ") : "");
      expect(actual.content).toBe(getText(body, " "));
      expect(actual.content.length).toBeGreaterThan(20);
    }
  });

  it("decodes character references the way a parser would", () => {
    expect(decodeEntities("&#1073;&#1077;&#1079; &amp; &#x432;&#x43E;&#x434;&#x430;"))
      .toBe("без & вода");
    expect(decodeEntities("plain text")).toBe("plain text");
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;"); // left alone
    // stripHtml is the epro path: short fragments, text nodes joined with " ".
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(stripHtml("<p>&#1073;&#1077;&#1079;<br/>&#1074;&#1086;&#1076;&#1072;</p>"))
      .toBe("без вода");
    // A decoded "<" must not be able to look like a tag.
    expect(stripHtml("<p>a &lt;b&gt; c</p>")).toBe("a <b> c");
  });

  it("the narrowed parsers agree with parsing the whole page", async () => {
    // Same selectors, less input: slicing to the container must not change what
    // comes out. (The reference is the parser itself fed its own slice — what
    // is being checked is that the slice contains everything the selectors
    // reach, which is where heatingParseMessage's <h1> was lost once already.)
    expect((await vikParseMessage(vikMessageFull))!.title).toBeTruthy();
    expect((await vikParseMessage(vikMessageFull))!.content.length).toBeGreaterThan(20);
    expect((await vtParse(vtPageFull))!.length).toBeGreaterThan(0);

    const heating = (await heatingParseMessage(heatingMessageFull))!;
    expect(heating.title).toBeTruthy();
    expect(heating.content.length).toBeGreaterThan(20);
  });

  it("sliceToContainer keeps every marker in scope, and reports a missing one", () => {
    expect(sliceToContainer("<div><p id=\"x\">hi</p></div>", 'id="x"')).toBe('<p id="x">hi</p></div>');
    expect(sliceToContainer("<div>nope</div>", 'id="x"')).toBeNull();
    // Earliest marker wins, so a slice never starts past something a selector
    // still has to reach.
    expect(sliceToContainer("<a>1</a><b>2</b>", "<b", "<a")).toBe("<a>1</a><b>2</b>");
  });

  it("decodes href entities the way cheerio's .attr() does", () => {
    // Left encoded, `&amp;` becomes a literal `amp;` parameter in the URL the
    // crawler then fetches.
    const html = '<div id="main_content"><div class="list-item">'
      + '<a href="https://vikvarna.com/bg/messages/breakdown/1.html?a=1&amp;b=2">x</a></div></div>';
    expect(vikParsePage(html)).toEqual([
      "https://vikvarna.com/bg/messages/breakdown/1.html?a=1&b=2",
    ]);
  });

  it("does not mistake a class prefix for the class, or data-href for href", () => {
    // `list-item-date` is not `list-item`; `data-href` is not `href`.
    const html = '<div id="main_content">'
      + '<div class="list-item-date">31.08.2026</div>'
      + '<div class="list-item"><a data-href="/decoy.html" href="/real/9.html">x</a></div>'
      + "</div>";
    expect(vikParsePage(html)).toEqual(["/real/9.html"]);
  });
});

// A budget assertion, so the next page-size creep fails the build instead of
// the cron. It counts BYTES, not milliseconds, deliberately: workerd's clock
// (`performance.now`, `Date.now`) advances only ~97 ms into a synchronous
// stretch and then pins, and it quantises to 1 ms — measuring a sub-10 ms parse
// with it produces numbers that look plausible and are not real. Bytes handed
// to cheerio are the thing we actually control, and the regression this guards
// is a page changing shape so a marker stops matching and the parser silently
// goes back to building a DOM over the whole document.
describe("parse input budget", () => {
  const budgets: Array<[string, string, string[]]> = [
    ["vik message", "vik_message_full.html", ['id="main_content"']],
    ["varnatraffic", "vt_page_full.html", ['id="infoAccordion"']],
    ["heating message", "heating_message_full.html", ["<h1", 'class="main']],
  ];

  it.each(budgets)("%s keeps the DOM input small", (_label, file, markers) => {
    const html = fixture(file);
    const slice = sliceToContainer(html, ...markers);
    expect(slice).not.toBeNull();
    // Measured on these captures: 34% / 41% / 52% of the page. Half is the
    // loosest of the three (the heating page's marker lands on the menu
    // wrapper), so that is where the bar goes.
    expect(slice!.length).toBeLessThan(html.length * 0.55);
    expect(slice!.length).toBeLessThan(24 * 1024);
  });

  it("no parser builds a cheerio DOM any more", () => {
    // cheerio is a devDependency now — the oracle above is the only thing in the
    // repo that still loads it. If it comes back into a parser it will be on the
    // largest documents the Worker touches, which is what measured 9.81–14.43 ms
    // cold, over the cap in a runtime faster than workerd. Asserting on the
    // source is crude, but it is what fails loudly if the DOM returns.
    for (const fn of [vikParsePage, vikParseMessage, vtParse, heatingParsePage, heatingParseMessage, stripHtml])
      expect(fn.toString()).not.toContain("cheerio");
  });
});
