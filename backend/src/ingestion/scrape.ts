// Port of scraping/scrape.py (SPEC.md §1.7). Selector logic is kept
// near-identical; text extraction mirrors BeautifulSoup's
// get_text(" ", strip=True) / get_text(strip=True) semantics.
//
// Originally built on cheerio. It no longer is, anywhere — see the CPU-cap
// note below. cheerio remains a devDependency, where the tests keep the
// original implementations as a reference oracle to check these against.

import { abortIn, expired, sleepWithin } from "../shared/deadline";

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

/** Per-attempt socket timeout; the caller's deadline can shorten it further. */
const ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * Ceiling on a scraped response body. The real pages are tens of kilobytes; a
 * megabyte is already absurd for any of them.
 *
 * `Response.text()` buffers whatever arrives, and the deadline does not help
 * here — a source that streams steadily never trips a timeout, it just fills
 * the isolate's 128 MB until workerd kills the invocation, taking the rest of
 * the tick's sources with it. That needs a hostile or badly broken source, but
 * the whole ingest path is built on the assumption that the far end can behave
 * arbitrarily, and this is the one resource it could otherwise exhaust.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Body as text, abandoned once it passes `maxBytes`.
 *
 * Decodes as UTF-8 unconditionally, which is what `Response.text()` does inside
 * workerd regardless of the charset the source declares — so swapping this in
 * changes nothing about how any page is read.
 */
export async function readCapped(res: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`Response declares ${declared} bytes, over the ${maxBytes}-byte cap`);
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new Error(`Response exceeded the ${maxBytes}-byte cap`);
      chunks.push(value);
    }
  } finally {
    // Releases the connection whether we finished or bailed out mid-stream.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Absolute form of `href`, but only when it stays on `base`'s host — otherwise
 * null.
 *
 * Every message URL a crawler fetches is read out of the HTML of the page
 * before it, which means the source decides what we go and fetch next. A
 * listing that has been tampered with (or a compromised CDN, or an injected
 * link on a site that accepts user content) can hand back an absolute URL to
 * anywhere and have the Worker retrieve it, parse it, and publish it to users
 * as a utility outage. Pinning the host keeps a source able to say what its own
 * messages are and nothing more.
 */
export function resolveSameHost(href: string, base: string): string | null {
  try {
    const resolved = new URL(href, base);
    return resolved.host === new URL(base).host ? resolved.toString() : null;
  } catch {
    return null; // unparseable href, or a base that is not a URL at all
  }
}

class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
  /** A 404 will still be a 404 in six seconds; only transient statuses retry. */
  get retryable(): boolean {
    return RETRY_STATUS.has(this.status);
  }
}

/**
 * Fetch a page with retries (GETs are idempotent, so retrying 429/5xx is
 * safe — port of the requests Session retry adapter). Throws on failure.
 *
 * Every attempt is capped by both its own timeout and the caller's remaining
 * budget, and a retry that cannot fit in the budget is skipped rather than
 * slept through: an unbudgeted worst case here was ~92 s (4 attempts × 20 s
 * plus 12 s of backoff), three times the cron's entire wall clock.
 */
export async function fetchPage(
  url: string, headers?: Record<string, string>, deadline?: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (expired(deadline, 500)) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`No time budget left to fetch ${url}`);
    }
    try {
      const res = await fetch(url, {
        headers: headers ?? DEFAULT_HEADERS,
        signal: abortIn(ATTEMPT_TIMEOUT_MS, deadline),
      });
      if (res.ok) return res;
      // A permanent answer (404, 403, 410) used to cost three pointless
      // retries plus their backoff before surfacing.
      const httpError = new HttpError(res.status, url);
      if (!httpError.retryable) throw httpError;
      lastError = httpError;
    } catch (e) {
      if (e instanceof HttpError && !e.retryable) throw e;
      lastError = e;
    }
    // Linear backoff (2 s, 4 s), skipped when it would not fit the budget.
    if (attempt < MAX_ATTEMPTS && !(await sleepWithin(2000 * attempt, deadline))) break;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Keeping the parse inside the 10 ms CPU cap (SPEC.md §1.7)
// ---------------------------------------------------------------------------
//
// The 10 ms bounds ONE uninterrupted synchronous stretch, and `cheerio.load()`
// is exactly that. A 15-minute cron is always a cold isolate, so it never gets
// the JIT-warmed path a test suite sees. Measured cold in Node v24 — workerd is
// slower, so read these as a floor — on full-size captures of the live pages:
//
//   call site            page      cheerio, whole page   cheerio, narrowed
//   vikParsePage         17.3 K            9.81 ms              0.34 ms *
//   vikParseMessage       9.9 K            7.76 ms              6.15 ms
//   vtParse              42.5 K           11.60 ms              8.96 ms
//   heatingParsePage     51.4 K           14.43 ms              0.46 ms *
//   heatingParseMessage  39.5 K           12.32 ms             10.69 ms
//   (* = no DOM built at all)
//
// Three of the five were over the cap in a runtime FASTER than workerd, and
// three consecutive ticks died at exactly 10 ms on 28.08.2026 with their logs
// discarded. Note what the middle column says about narrowing: feeding cheerio
// ~60% fewer bytes bought only ~20%, because the cold cost is dominated by a
// fixed floor (module init plus JIT of the parse path), not by byte count.
// Warming cheerio at module scope, where the 400 ms startup budget would have
// paid for it, was measured too and did not reliably help either.
//
// So there are two shapes here, and neither is cheerio:
//
//  1. **No parser at all** where only ids are wanted (`vikParsePage`,
//     `heatingParsePage`). A listing page is read for its message links; a
//     string scan gets them. Scoping to the container first is not cosmetic —
//     the crawlers stop at the first id at or below the cursor, so one stray
//     older link from elsewhere on the page would truncate the list and stall
//     the source.
//  2. **HTMLRewriter** where the structure is genuinely needed. It is
//     Cloudflare's native streaming parser: it processes the body in chunks
//     interleaved with I/O, so the work never forms a single burst for the cap
//     to catch. This is why those three parsers are async.
//
// Splitting a burst across `await`s by hand does not work — there is no yield
// point inside one `cheerio.load()`. Either the work gets smaller, or it stops
// being one stretch.

/**
 * `html` from the element carrying `marker` onwards, or null when it is absent.
 *
 * Deliberately does NOT hunt for the matching close tag — depth-counting is
 * more code and more ways to be wrong than it buys, and the trailing markup is
 * harmless: every caller selects *within* the container, so a footer that rides
 * along is never looked at. Dropping the head is where the saving is.
 *
 * A missing marker returns null rather than the whole document, so the caller's
 * existing "container not found" path still fires instead of silently parsing
 * a page whose shape has changed.
 */
export function sliceToContainer(html: string, ...markers: string[]): string | null {
  // Earliest marker wins. Parsers that select more than one thing pass more
  // than one marker, because the slice has to start ahead of all of them —
  // heatingParseMessage reads an <h1> that is a sibling of the body field, not
  // a descendant, and slicing to the field alone silently emptied the title.
  let at = -1;
  for (const marker of markers) {
    const found = html.indexOf(marker);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return null;
  // Back up to the '<' of the tag holding the marker, so the slice starts on a
  // well-formed opening tag rather than mid-attribute.
  const open = html.lastIndexOf("<", at);
  return open < 0 ? null : html.slice(open);
}

/** Whether a class attribute carries `name` as a whole token (not `list-item-date`). */
function hasClassToken(classAttr: string, name: string): boolean {
  for (const token of classAttr.split(/\s+/)) if (token === name) return true;
  return false;
}

const OPEN_TAG = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
// `\b` is NOT enough to anchor an attribute name: in `data-href` the hyphen is
// itself a word boundary, so /\bhref=/ matches inside it and a decoy attribute
// becomes the message URL we go and fetch. Exclude a preceding hyphen or word
// character explicitly.
const CLASS_ATTR = /(?<![-\w])class\s*=\s*("([^"]*)"|'([^']*)')/;
const HREF_ATTR = /(?<![-\w])href\s*=\s*("([^"]*)"|'([^']*)')/;

/**
 * The document split into one slice per element carrying `className`, in
 * document order — the string-scan equivalent of `container.find(".x").each()`.
 *
 * Each slice runs from its own opening tag to the next match (or the end), so
 * "the first href inside this row" is a plain search within the slice. That
 * matters: both listing sources link the same message twice per row (the
 * heading and a "read more"), and taking the first href per row is what the
 * cheerio version did with `.find("a").first()`.
 */
function sectionsByClass(html: string, className: string): string[] {
  const starts: number[] = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(html); m !== null; m = OPEN_TAG.exec(html)) {
    const cls = CLASS_ATTR.exec(m[2]!);
    if (cls && hasClassToken(cls[2] ?? cls[3] ?? "", className)) starts.push(m.index);
  }
  return starts.map((from, i) => html.slice(from, starts[i + 1] ?? html.length));
}

/**
 * First `href` in `section`, optionally required to contain `must`.
 *
 * Entities are decoded because cheerio's `.attr()` does: the sources write
 * `?region_id=0&amp;sub_region_id=0`, and left encoded the `&amp;` becomes a
 * literal `amp;` parameter in the URL we go on to fetch.
 */
function firstHref(section: string, must?: string): string | null {
  let rest = section;
  for (;;) {
    const m = HREF_ATTR.exec(rest);
    if (!m) return null;
    const href = (m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").trim();
    if (href && (must === undefined || href.includes(must))) return href;
    rest = rest.slice(m.index + m[0].length);
  }
}

// ---------------------------------------------------------------------------
// Text extraction without a DOM
// ---------------------------------------------------------------------------
//
// Every parser below reproduces BeautifulSoup's
// `get_text(separator, strip=True)`: strip each text node, drop the empties,
// join what is left with the separator. That is the contract the Python
// scrapers set and the AI prompt and notification text still depend on, so it
// is preserved exactly — only the machinery underneath changed.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  laquo: "«", raquo: "»", ndash: "–", mdash: "—",
  hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”",
};

/**
 * Decode the character references a parser would have decoded for us.
 *
 * Only needed on the string-scan paths — HTMLRewriter hands back decoded text
 * already. The sources write Cyrillic as numeric references often enough
 * (`&#1073;`) that dropping this would put raw `&#1073;` into a push
 * notification.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text; // the overwhelmingly common case
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * Reduce an HTML fragment to plain text (single-space separated) — strip_html
 * port, used by epro on the short HTML fragments inside its JSON payload.
 *
 * A plain string scan rather than a parser: the fragments are a sentence or two
 * each, and epro runs on every tick, so building a DOM for them meant paying
 * cheerio's cold-isolate cost on the busiest path in the Worker for no reason.
 * Text nodes are exactly the runs between tags, which is all this needs.
 */
export function stripHtml(html: string): string {
  const parts: string[] = [];
  for (const run of html.split(/<[^>]*>/)) {
    const trimmed = decodeEntities(run).trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join(" ");
}

/**
 * Text of the FIRST element matching a selector, accumulated as HTMLRewriter
 * streams past it.
 *
 * HTMLRewriter is Cloudflare's native streaming parser: it processes the body
 * in chunks interleaved with I/O, so it never forms the one uninterrupted
 * synchronous stretch that the 10 ms CPU limit actually bounds. That is the
 * whole reason the parsers below are async — the cost does not go away, it
 * stops being a single burst.
 *
 * Two things about HTMLRewriter that the reference oracle in the tests caught,
 * because both produce plausible-looking output rather than an error:
 *
 *  - A `text` handler on a selector fires for every text node ANYWHERE inside
 *    the matched element, nested ones included. Also registering `sel *` — on
 *    the assumption it fired only for direct children, as some DOM APIs do —
 *    collects every nested text node twice.
 *  - It does NOT decode character references. `lol-html` streams source bytes
 *    through, so `&quot;` and `&#1073;` arrive verbatim where a DOM parser
 *    would have resolved them. They are decoded here, once per text node and
 *    before trimming, so a reference split across two chunks still resolves and
 *    a decoded `&nbsp;` is trimmed like the whitespace it is.
 */
class FirstElementText {
  /** Whether the element was present at all — distinct from it being empty. */
  opened = false;
  private active = false;
  private chunks: string[] = [];
  private parts: string[] = [];

  constructor(private readonly separator: string) {}

  /** `element` handler for the selector itself. */
  readonly onElement = (el: Element): void => {
    // Only the first match, mirroring cheerio's `.first()`. A later sibling
    // must not reopen collection.
    if (this.opened) { this.active = false; return; }
    this.opened = true;
    this.active = true;
    // Void or unclosed elements never fire this; `opened` above is what stops
    // collection running away in that case.
    el.onEndTag(() => { this.active = false; });
  };

  /** `text` handler. One registration on the selector covers nested text too. */
  readonly onText = (chunk: Text): void => {
    if (!this.active) return;
    // One text node can arrive as several chunks; `lastInTextNode` is the only
    // place the strip-per-text-node rule can be applied.
    this.chunks.push(chunk.text);
    if (!chunk.lastInTextNode) return;
    const value = decodeEntities(this.chunks.join("")).trim();
    this.chunks = [];
    if (value) this.parts.push(value);
  };

  get value(): string { return this.parts.join(this.separator); }
}

/** Wire a collector into a rewriter under `selector`, descendants included. */
function collect(
  rewriter: HTMLRewriter, selector: string, sink: FirstElementText,
): HTMLRewriter {
  return rewriter.on(selector, { element: sink.onElement, text: sink.onText });
}

/**
 * Drive the rewriter over an in-memory document and discard the output.
 *
 * Consuming the transformed body is what makes the parse happen; HTMLRewriter
 * does the work as the stream is read, in chunks, which is the whole point.
 */
async function driveRewriter(html: string, rewriter: HTMLRewriter): Promise<void> {
  await rewriter.transform(new Response(html)).arrayBuffer();
}

// ---------------------------------------------------------------------------
// VIK (vikvarna.com)
// ---------------------------------------------------------------------------

export interface VikMessage {
  title: string;
  date: string | null;
  content: string;
}

/**
 * Parse the VIK listing page → message URLs, or null if the container is
 * missing.
 *
 * String scan, no DOM: the listing is read for its links and nothing else, and
 * building a 17 KB document to get them cost 6.21 ms cold — over half the CPU
 * cap for a job `indexOf` can do. Scoping to `#main_content` first is not
 * cosmetic: the crawlers stop at the first id at or below the cursor, so a
 * stray older link from a sidebar would truncate the list and stall the source.
 */
export function vikParsePage(html: string): string[] | null {
  const container = sliceToContainer(html, 'id="main_content"');
  if (container === null) {
    console.error("[scrape] vikParsePage: #main_content not found.");
    return null;
  }

  const urls: string[] = [];
  for (const item of sectionsByClass(container, "list-item")) {
    const href = firstHref(item);
    if (href) urls.push(href);
    else console.warn("[scrape] vikParsePage: list-item has no <a> tag. Skipping.");
  }
  return urls;
}

/**
 * The heading on an unfiltered message page is built as "<title>/<region>", and
 * with no region_id in the URL the second half comes out empty — every title
 * arrives as "Без вода/" or "Без вода /". Left in, the stray separator reaches
 * the AI prompt and the notification text, so trim it off. Only a trailing run
 * is touched; a slash anywhere else in the title is the site's own.
 */
function stripTitleSeparator(title: string): string {
  return title.replace(/\s*\/+\s*$/, "").trim();
}

/**
 * Parse a single VIK message page, or null if parsing fails.
 *
 * The parse a ViK tick pays every 15 minutes, and the one that had to stop
 * being a synchronous burst.
 */
export async function vikParseMessage(html: string): Promise<VikMessage | null> {
  const fragment = sliceToContainer(html, 'id="main_content"');
  if (fragment === null) {
    console.error("[scrape] vikParseMessage: #main_content not found.");
    return null;
  }

  const title = new FirstElementText("");
  const date = new FirstElementText("");
  const content = new FirstElementText("");
  let container = false;

  let rewriter = new HTMLRewriter()
    .on("#main_content", { element: () => { container = true; } });
  rewriter = collect(rewriter, "#main_content h1", title);
  rewriter = collect(rewriter, "#main_content .list-item-date", date);
  rewriter = collect(rewriter, "#main_content .view p", content);
  await driveRewriter(fragment, rewriter);

  if (!container) {
    console.error("[scrape] vikParseMessage: #main_content not found.");
    return null;
  }
  // An unused id renders the listing shell with no .view — this null is what
  // ends a probe walk, so "the element was absent" and "the element was empty"
  // must stay distinguishable.
  if (!content.opened) {
    console.warn("[scrape] vikParseMessage: .view p not found.");
    return null;
  }

  return {
    title: title.opened ? stripTitleSeparator(title.value) : "",
    date: date.opened ? date.value : null,
    content: content.value,
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
export async function vtParse(html: string): Promise<VtMessage[] | null> {
  // 42 KB page, 17 KB of it from #infoAccordion on.
  const fragment = sliceToContainer(html, 'id="infoAccordion"');
  if (fragment === null) {
    console.error("[scrape] vtParse: #infoAccordion not found.");
    return null;
  }

  interface Group {
    data_id: string | null;
    header: FirstElementText;
    body: FirstElementText;
    time: FirstElementText;
  }
  const groups: Group[] = [];
  let container = false;
  // HTMLRewriter walks in document order, so "the group currently open" is
  // simply the last one started — the streaming equivalent of `.each()`.
  const current = (): Group | undefined => groups[groups.length - 1];

  const field = (pick: (g: Group) => FirstElementText) => ({
    element: (el: Element) => { const g = current(); if (g) pick(g).onElement(el); },
    text: (chunk: Text) => { const g = current(); if (g) pick(g).onText(chunk); },
  });
  const wire = (rw: HTMLRewriter, selector: string, pick: (g: Group) => FirstElementText) =>
    rw.on(selector, field(pick));

  let rewriter = new HTMLRewriter()
    .on("#infoAccordion", { element: () => { container = true; } })
    .on("div.accordion-group", {
      element: (el) => {
        groups.push({
          // null (not a sentinel string) when missing — the service derives a
          // content-hash id so id-less entries still dedup.
          data_id: el.getAttribute("data-id"),
          header: new FirstElementText(""),
          body: new FirstElementText(" "),
          time: new FirstElementText(""),
        });
      },
    });
  rewriter = wire(rewriter, "div.accordion-group a.accordion-toggle", (g) => g.header);
  rewriter = wire(rewriter, "div.accordion-group div.accordion-inner", (g) => g.body);
  rewriter = wire(rewriter, "div.accordion-group div.info-time", (g) => g.time);
  await driveRewriter(fragment, rewriter);

  if (!container) {
    console.error("[scrape] vtParse: #infoAccordion not found.");
    return null;
  }

  return groups.map((g) => ({
    data_id: g.data_id,
    header: g.header.opened ? g.header.value : "No header",
    body: g.body.opened ? g.body.value : "No body",
    info_time: g.time.opened ? g.time.value : "No time",
  }));
}

// ---------------------------------------------------------------------------
// Veolia Energy Varna — district heating (energy-varna.bg, Drupal)
// ---------------------------------------------------------------------------

/**
 * Parse the Veolia listing page → absolute node URLs (newest first), or null.
 *
 * String scan, no DOM — and the one that most needed it: this listing is 51 KB
 * and measured 10.61 ms cold in Node, already over the 10 ms cap in a runtime
 * faster than workerd.
 */
export function heatingParsePage(html: string, baseUrl: string): string[] | null {
  const rows = sectionsByClass(html, "views-row");
  if (rows.length === 0) {
    console.error("[scrape] heatingParsePage: no div.views-row found.");
    return null;
  }

  const urls: string[] = [];
  for (const row of rows) {
    // Drupal writes these rows relative ("/bg/node/718"), and every row links
    // its node twice (title and "read more") — first match per row, as before.
    const href = firstHref(row, "/node/");
    if (href) urls.push(new URL(href, baseUrl).toString());
    else console.warn("[scrape] heatingParsePage: views-row has no node link. Skipping.");
  }
  return urls;
}

/** Parse a Veolia node (message) page, or null if parsing fails. */
export async function heatingParseMessage(
  html: string,
): Promise<{ title: string; content: string } | null> {
  // The <h1> is a SIBLING of the body field, not a descendant, so the slice has
  // to start ahead of both — passing only the body marker silently emptied the
  // title once already.
  const fragment = sliceToContainer(html, "<h1", 'class="main') ?? html;

  const title = new FirstElementText(" ");
  const body = new FirstElementText(" ");
  let rewriter = collect(new HTMLRewriter(), "h1", title);
  rewriter = collect(rewriter, "div.main .field--name-body", body);
  await driveRewriter(fragment, rewriter);

  if (!body.opened) {
    console.error("[scrape] heatingParseMessage: body field not found.");
    return null;
  }
  return { title: title.opened ? title.value : "", content: body.value };
}
