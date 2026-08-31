// Sequential-id crawler — the approach the original ViK spider used, restored
// so the source covers the whole municipality instead of just the city.
//
// Why not crawlIdListing: vikvarna's listing page only exists filtered by
// region, and the URL we were walking (region_id=15) is the city of Varna
// alone — outages in Devnya, Provadia, Dolni Chiflik, Dalgopol were never seen.
// The message pages are NOT filtered: <base><id>.html, with no query string,
// serves the message whatever region it belongs to. So this crawler walks the
// id space forward from the cursor and lets the message parser decide whether
// an id holds anything, rather than following links off a listing.
//
// Cursor semantics carry over from id-listing.ts unchanged and are still
// load-bearing: oldest-first, advance only past successes, a failed message
// blocks newer ones, and the cursor is persisted after EACH success (a
// mid-batch kill must not re-notify — see the long comment there).
//
// New here is the miss. vikvarna answers every id with 200 — an id that holds
// no message just renders the listing shell — so "nothing here" is a parse
// result, not a status code, and the walk simply stops after
// MAX_CONSECUTIVE_MISSES of them. Holes below a message need no handling: a
// success writes the cursor to that id, stepping over anything dead beneath it.

import type { Env } from "../../env";
import { processOutageMessage } from "../pipeline";
import { fetchPage, readCapped, resolveSameHost } from "../scrape";
import {
  claimAttempt, getLastId, getLastIdUpdatedAt, hasStateRow, MAX_PRE_STORE_ATTEMPTS,
  recordSkip, releaseAttempts, writeLastId,
} from "../state";
import { MAX_MESSAGES_PER_TICK } from "./id-listing";

/**
 * How far past the cursor to keep probing before calling it the end of the
 * queue. The id space is dense in practice (a 70-id sweep of vikvarna in July
 * 2026 had zero holes), so three is plenty to cover the normal case; the
 * pathological one is handled by stepOverDeadIds below.
 */
export const MAX_CONSECUTIVE_MISSES = 3;

/**
 * A cursor that has not advanced in this long, with nothing probeable above it,
 * is the symptom of a hole wider than MAX_CONSECUTIVE_MISSES — see
 * stepOverDeadIds. Comfortably longer than any real quiet spell on a source
 * that publishes several messages a day, so the escape hatch stays an escape
 * hatch and idle ticks cost three fetches, not four.
 */
export const STALE_CURSOR_MS = 6 * 60 * 60 * 1000;

export interface IdProbeOptions {
  tag: string;
  category: string;
  /**
   * Message URL for an id. MUST NOT carry query parameters: they are what
   * scopes the page to a sub-region, and on the bare URL the same id serves the
   * message for whichever region it actually belongs to.
   */
  messageUrl: (id: number) => string;
  parseMessage: (html: string) => Promise<{ title: string; content: string } | null>;
  /**
   * Listing page, used ONLY to seed the cursor on the very first run and to
   * recover from a dead id run — never for the ordinary crawl.
   */
  listingUrl: string;
  parsePage: (html: string) => string[] | null;
  idPattern: RegExp;
  /** Injectable for tests; defaults to fetchPage. */
  fetchImpl?: (url: string, headers?: Record<string, string>, deadline?: number) => Promise<Response>;
  /** Injectable for tests; defaults to processOutageMessage. */
  processImpl?: (env: Env, tag: string, category: string, title: string, content: string, msgRef: string, deadline?: number) => Promise<boolean>;
}

export async function crawlIdProbe(env: Env, deadline: number, opts: IdProbeOptions): Promise<void> {
  const { tag, category } = opts;
  const fetchImpl = opts.fetchImpl ?? fetchPage;
  const processImpl = opts.processImpl ?? processOutageMessage;

  const cursor = await getLastId(env, category);
  if (cursor === null) {
    // Treating an unreadable cursor as 0 would walk the id space from the
    // beginning, re-ingesting — and re-notifying — years of messages.
    console.error(`[${tag}] Could not read the stored cursor. Skipping this tick.`);
    return;
  }

  // First run ever: seed the cursor at the newest published id without
  // processing. Probing forward from 0 would otherwise crawl the entire
  // history, and there is no listing link to bound it.
  if (cursor === 0 && !(await hasStateRow(env, category))) {
    const ids = await listedIds(env, deadline, opts, fetchImpl);
    if (ids === null || ids.length === 0) {
      console.error(`[${tag}] First run — could not read the listing to seed the cursor. Retrying next tick.`);
      return;
    }
    const newest = Math.max(...ids);
    console.log(`[${tag}] First run — seeding cursor at ${newest} without processing history.`);
    await writeLastId(env, category, newest);
    return;
  }

  let id = cursor + 1;
  let misses = 0;
  let processed = 0;

  while (processed < MAX_MESSAGES_PER_TICK && misses < MAX_CONSECUTIVE_MISSES) {
    if (Date.now() >= deadline) {
      console.warn(`[${tag}] Deadline reached; id=${id} waits for the next tick.`);
      return;
    }

    let html: string;
    try {
      html = await readCapped(await fetchImpl(opts.messageUrl(id), undefined, deadline));
    } catch (e) {
      // A fetch that failed says nothing about whether the id holds a message,
      // so it must not be counted as a miss — that would let a 503 burn the
      // budget and, worse, look like the end of the queue. It is not counted as
      // an attempt either: the claim below sits after the fetch so transient
      // network trouble cannot spend a message's strikes.
      console.error(`[${tag}] Failed to fetch message (id=${id}): ${e}. Stopping.`);
      return;
    }

    // Claim the attempt BEFORE the parse-and-process, and after the fetch. The
    // ordering is the whole point: whatever kills an isolate mid-message does
    // so from here on, and a counter bumped afterwards would never record the
    // one failure this cap exists to bound (MAX_PRE_STORE_ATTEMPTS). The claim
    // is committed I/O, so it survives the kill.
    const { proceed, attempts } = await claimAttempt(env, category, String(id));
    if (!proceed) {
      console.error(
        `[${tag}] GIVING UP on id=${id} after ${attempts - 1} failed attempts before the store. ` +
        `Advancing the cursor past it — this message is NOT delivered. It is recorded in ` +
        `ingest_attempts (skipped_at) and on /api/health.`);
      await recordSkip(env, category, String(id));
      await writeLastId(env, category, id);
      // Counts against the per-tick cap: giving up is still work, and a long
      // run of poisoned ids must not burn the whole tick in one go.
      processed++;
      id++;
      continue;
    }

    const message = await opts.parseMessage(html);
    if (message === null) {
      // An empty id is not a failure, so it must not keep a claim: the probe
      // walks the same few ids every tick, and left standing they would reach
      // the cap on a merely quiet source and step the cursor over an id that
      // has not been published *yet*.
      await releaseAttempts(env, category, String(id));
      misses++;
      id++;
      continue;
    }
    misses = 0;

    let submitted = false;
    try {
      submitted = await processImpl(env, tag, category, message.title, message.content, `id=${id}`, deadline);
    } catch (e) {
      console.error(`[${tag}] Failed to process message (id=${id}): ${e}.`);
    }

    if (!submitted) {
      console.warn(
        `[${tag}] Stopping at id=${id}; it will be retried next run ` +
        `(attempt ${attempts}/${MAX_PRE_STORE_ATTEMPTS}).`);
      return;
    }
    await releaseAttempts(env, category, String(id));

    // Persist per success, not once at the end — see id-listing.ts. Doubles as
    // the hole handler: this write also moves the cursor past any dead ids
    // that were skipped on the way here.
    await writeLastId(env, category, id);
    processed++;
    id++;
  }

  // Nothing above the cursor for MAX_CONSECUTIVE_MISSES ids running. Almost
  // always that just means no new messages; rarely it means a hole too wide to
  // probe across, which would wedge the source permanently.
  if (processed === 0 && misses >= MAX_CONSECUTIVE_MISSES) {
    await stepOverDeadIds(env, deadline, opts, cursor, fetchImpl);
  }
}

/**
 * Escape hatch for a run of dead ids wider than the probe window, which would
 * otherwise stall the source forever: every tick probes the same few empty ids,
 * finds nothing, and never reaches the messages above them.
 *
 * Distinguishing "wide hole" from the ordinary "no new messages" needs an
 * outside opinion, so this consults the listing — but only once the cursor has
 * been stuck for STALE_CURSOR_MS, which on a source publishing several messages
 * a day never happens in normal operation.
 *
 * Trade-off, and the reason this is a last resort rather than the main path:
 * the listing covers one message type, so jumping the cursor can step over a
 * message of another type sitting inside the hole.
 */
async function stepOverDeadIds(
  env: Env,
  deadline: number,
  opts: IdProbeOptions,
  cursor: number,
  fetchImpl: NonNullable<IdProbeOptions["fetchImpl"]>,
): Promise<void> {
  const { tag, category } = opts;

  const updatedAt = await getLastIdUpdatedAt(env, category);
  if (updatedAt === null) return;
  const age = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(age) || age < STALE_CURSOR_MS) return;

  const ids = await listedIds(env, deadline, opts, fetchImpl);
  if (ids === null) return;

  // Oldest id the listing knows about that we have not passed yet.
  const above = ids.filter((candidate) => candidate > cursor);
  if (above.length === 0) return;
  const target = Math.min(...above);

  // Inside the window we just probed, so it is not a hole — the id was
  // unreadable for some other reason, and jumping would skip a real message.
  if (target <= cursor + MAX_CONSECUTIVE_MISSES) return;

  console.warn(
    `[${tag}] Cursor stuck at ${cursor} for ${Math.round(age / 3600_000)} h with ids ` +
    `${cursor + 1}–${cursor + MAX_CONSECUTIVE_MISSES} empty; stepping over to ${target}.`);
  await writeLastId(env, category, target - 1);
}

/** Every numeric id on the listing page, or null when it could not be read. */
async function listedIds(
  env: Env,
  deadline: number,
  opts: IdProbeOptions,
  fetchImpl: NonNullable<IdProbeOptions["fetchImpl"]>,
): Promise<number[] | null> {
  let html: string;
  try {
    html = await readCapped(await fetchImpl(opts.listingUrl, undefined, deadline));
  } catch (e) {
    console.error(`[${opts.tag}] Failed to fetch listing page: ${e}.`);
    return null;
  }

  const urls = opts.parsePage(html);
  if (urls === null) {
    console.error(`[${opts.tag}] Could not parse message URLs from the listing page.`);
    return null;
  }

  const ids: number[] = [];
  for (const url of urls) {
    // These ids are never fetched — they only feed stepOverDeadIds, which moves
    // the cursor. An off-host link is still worth dropping: an injected
    // `/99999999.html` would jump the cursor past every real message and
    // silently stop the source from ever reporting an outage again.
    const target = resolveSameHost(url, opts.listingUrl);
    if (target === null) {
      console.warn(`[${opts.tag}] Ignoring off-host listing url: ${url}.`);
      continue;
    }
    const match = opts.idPattern.exec(target);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}
