// Port of backend/tests/test_scrape.py — all parsers against the same HTML
// fixtures, asserting the same expected outputs.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  heatingParseMessage, heatingParsePage,
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

  it("parses a message page, trimming the empty region separator off the title", () => {
    const msg = vikParseMessage(vikMessage)!;
    expect(msg.title).toBe("Авария на водопровод в кв. Аспарухово");
    expect(msg.date).toBe("10.06.2026");
    expect(msg.content).toContain("спряно водоподаването");
  });

  it("trims the trailing separator in every shape the site emits", () => {
    const title = (h1: string) =>
      vikParseMessage(`<div id="main_content"><h1>${h1}</h1><div class="view"><p>x</p></div></div>`)!.title;
    expect(title("Без вода/")).toBe("Без вода");
    expect(title("Без вода /")).toBe("Без вода");
    // Only the trailing run is touched — inner spacing is the site's own.
    expect(title("Без вода  ще бъдат:/")).toBe("Без вода  ще бъдат:");
    // A slash that is part of the title is left alone.
    expect(title("Планов ремонт 08.07. и 09.07.2026г./сряда и четвъртък/")).toBe(
      "Планов ремонт 08.07. и 09.07.2026г./сряда и четвъртък");
  });

  it("reports the empty shell an unused id serves as no message", () => {
    // vikvarna answers every id with 200; an id that holds nothing renders the
    // listing heading and no .view — this null is what ends a probe walk.
    expect(vikParseMessage('<div id="main_content"><h1>Съобщения за аварии</h1></div>')).toBeNull();
  });

  it("handles missing container / content / title", () => {
    expect(vikParseMessage("<html><body></body></html>")).toBeNull();
    expect(vikParseMessage('<div id="main_content"><h1>Title only</h1></div>')).toBeNull();
    expect(vikParseMessage('<div id="main_content"><div class="view"><p>Само съдържание</p></div></div>'))
      .toEqual({ title: "", date: null, content: "Само съдържание" });
  });
});

describe("vt", () => {
  it("extracts all accordions with fallbacks", () => {
    const messages = vtParse(vtPage)!;
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

  it("returns null when the container is missing", () => {
    expect(vtParse("<html><body></body></html>")).toBeNull();
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

  it("parses a message page", () => {
    const msg = heatingParseMessage(heatingMessage)!;
    expect(msg.title).toBe("Спиране на топлоподаването в район Младост");
    expect(msg.content).toContain("спираме топлоподаването");
  });

  it("returns null when the body field is missing", () => {
    expect(heatingParseMessage("<html><h1>Заглавие</h1></html>")).toBeNull();
  });
});
