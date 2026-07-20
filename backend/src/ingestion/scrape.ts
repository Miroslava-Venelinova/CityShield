// Port of scraping/scrape.py onto cheerio (PLAN.MD §1.7). Selector logic is
// kept near-identical; text extraction mirrors BeautifulSoup's
// get_text(" ", strip=True) / get_text(strip=True) semantics.

import * as cheerio from "cheerio";

// Structural node type for the text walker (cheerio's DOM node types live in
// domhandler; this is the minimal shape we touch).
interface DomNode {
  type: string;
  data?: string;
  children?: DomNode[];
}

// Some sources serve empty/blocked responses to non-browser user agents, so
// every fetch identifies as a browser (verified edge-safe in spike 1 —
// byte-identical responses from Cloudflare's ranges).
export const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "bg-BG,bg;q=0.9,en;q=0.8",
};

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a page with retries (GETs are idempotent, so retrying 429/5xx is
 * safe — port of the requests Session retry adapter). Throws on failure.
 */
export async function fetchPage(url: string, headers?: Record<string, string>): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt); // 0s, 2s, 4s, 6s
    try {
      const res = await fetch(url, {
        headers: headers ?? DEFAULT_HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      if (RETRY_STATUS.has(res.status)) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// BeautifulSoup get_text(separator, strip=True): strip each text node, drop
// empties, join with the separator.
function getText($el: { toArray(): unknown[] }, separator: string): string {
  const parts: string[] = [];
  const walk = (node: DomNode) => {
    if (node.type === "text") {
      const trimmed = node.data?.trim();
      if (trimmed) parts.push(trimmed);
    } else if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };
  for (const node of $el.toArray()) walk(node as DomNode);
  return parts.join(separator);
}

/** Reduce an HTML fragment to plain text (single-space separated) — strip_html port. */
export function stripHtml(html: string): string {
  const $ = cheerio.load(html);
  return getText($("body"), " ");
}

// ---------------------------------------------------------------------------
// VIK (vikvarna.com)
// ---------------------------------------------------------------------------

export interface VikMessage {
  title: string;
  date: string | null;
  content: string;
}

/** Parse the VIK listing page → message URLs, or null if the container is missing. */
export function vikParsePage(html: string): string[] | null {
  const $ = cheerio.load(html);
  const container = $("#main_content");
  if (container.length === 0) {
    console.error("[scrape] vikParsePage: #main_content not found.");
    return null;
  }

  const urls: string[] = [];
  container.find("div.list-item").each((_, item) => {
    const href = $(item).find("a").first().attr("href");
    if (href) urls.push(href);
    else console.warn("[scrape] vikParsePage: list-item has no <a> tag. Skipping.");
  });
  return urls;
}

/** Parse a single VIK message page, or null if parsing fails. */
export function vikParseMessage(html: string): VikMessage | null {
  const $ = cheerio.load(html);
  const container = $("#main_content");
  if (container.length === 0) {
    console.error("[scrape] vikParseMessage: #main_content not found.");
    return null;
  }

  const content = container.find(".view p").first();
  if (content.length === 0) {
    console.warn("[scrape] vikParseMessage: .view p not found.");
    return null;
  }

  const title = container.find("h1").first();
  const date = container.find(".list-item-date").first();
  return {
    title: title.length ? getText(title, "") : "",
    date: date.length ? getText(date, "") : null,
    content: getText(content, ""),
  };
}

// ---------------------------------------------------------------------------
// VarnaTraffic (varnatraffic.com)
// ---------------------------------------------------------------------------

export interface VtMessage {
  data_id: string | null;
  header: string;
  body: string;
  info_time: string;
}

/** Parse the VarnaTraffic accordion page, or null if the container is missing. */
export function vtParse(html: string): VtMessage[] | null {
  const $ = cheerio.load(html);
  const container = $("#infoAccordion");
  if (container.length === 0) {
    console.error("[scrape] vtParse: #infoAccordion not found.");
    return null;
  }

  const results: VtMessage[] = [];
  container.find("div.accordion-group").each((_, accordion) => {
    const $acc = $(accordion);
    const header = $acc.find("a.accordion-toggle").first();
    const body = $acc.find("div.accordion-inner").first();
    const time = $acc.find("div.info-time").first();
    results.push({
      // null (not a sentinel string) when missing — the service derives a
      // content-hash id so id-less entries still dedup.
      data_id: $acc.attr("data-id") ?? null,
      header: header.length ? getText(header, "") : "No header",
      body: body.length ? getText(body, " ") : "No body",
      info_time: time.length ? getText(time, "") : "No time",
    });
  });
  return results;
}

// ---------------------------------------------------------------------------
// Veolia Energy Varna — district heating (energy-varna.bg, Drupal)
// ---------------------------------------------------------------------------

/** Parse the Veolia listing page → absolute node URLs (newest first), or null. */
export function heatingParsePage(html: string, baseUrl: string): string[] | null {
  const $ = cheerio.load(html);
  const rows = $("div.views-row");
  if (rows.length === 0) {
    console.error("[scrape] heatingParsePage: no div.views-row found.");
    return null;
  }

  const urls: string[] = [];
  rows.each((_, row) => {
    const href = $(row).find("a[href*='/node/']").first().attr("href");
    if (href) urls.push(new URL(href, baseUrl).toString());
    else console.warn("[scrape] heatingParsePage: views-row has no node link. Skipping.");
  });
  return urls;
}

/** Parse a Veolia node (message) page, or null if parsing fails. */
export function heatingParseMessage(html: string): { title: string; content: string } | null {
  const $ = cheerio.load(html);
  const body = $("div.main .field--name-body").first();
  if (body.length === 0) {
    console.error("[scrape] heatingParseMessage: body field not found.");
    return null;
  }
  const title = $("h1").first();
  return {
    title: title.length ? getText(title, " ") : "",
    content: getText(body, " "),
  };
}
