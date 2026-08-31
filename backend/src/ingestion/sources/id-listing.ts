// Shared crawler for id-numbered listing sources (vik, heating) — port of
// common.py crawl_id_listing with the §1.7 cron-budget additions: a deadline
// guard and a per-tick message cap. Cursor semantics are preserved verbatim:
// process oldest-first, advance last_id only past successes, a failed message
// blocks newer ones (a retried run must not re-notify), a persistently
// failing message ages off the listing.

import type { Env } from "../../env";
import { processOutageMessage } from "../pipeline";
import { fetchPage, readCapped, resolveSameHost } from "../scrape";
import {
  claimAttempt, getLastId, hasStateRow, MAX_PRE_STORE_ATTEMPTS, recordSkip, releaseAttempts, writeLastId,
} from "../state";

export const MAX_MESSAGES_PER_TICK = 2;

export interface IdListingOptions {
  tag: string;
  category: string;
  listingUrl: string;
  idPattern: RegExp;
  parsePage: (html: string) => string[] | null;
  parseMessage: (html: string) => Promise<{ title: string; content: string } | null>;
  /** Injectable for tests; defaults to fetchPage. */
  fetchImpl?: (url: string, headers?: Record<string, string>, deadline?: number) => Promise<Response>;
  /** Injectable for tests; defaults to processOutageMessage. */
  processImpl?: (env: Env, tag: string, category: string, title: string, content: string, msgRef: string, deadline?: number) => Promise<boolean>;
}

export async function crawlIdListing(env: Env, deadline: number, opts: IdListingOptions): Promise<void> {
  const { tag, category } = opts;
  const fetchImpl = opts.fetchImpl ?? fetchPage;
  const processImpl = opts.processImpl ?? processOutageMessage;

  const storedId = await getLastId(env, category);
  if (storedId === null) {
    // Treating an unreadable cursor as 0 would reprocess — and re-notify —
    // messages already delivered. Wait for the next tick instead.
    console.error(`[${tag}] Could not read the stored cursor. Skipping this tick.`);
    return;
  }

  let listingHtml: string;
  try {
    listingHtml = await readCapped(await fetchImpl(opts.listingUrl, undefined, deadline));
  } catch (e) {
    console.error(`[${tag}] Failed to fetch listing page: ${e}. Stopping.`);
    return;
  }

  const msgUrls = opts.parsePage(listingHtml);
  if (msgUrls === null) {
    console.error(`[${tag}] Could not parse message URLs from the page. Stopping.`);
    return;
  }

  // Collect everything newer than the cursor (listing is newest-first).
  const newMessages: Array<{ id: number; url: string }> = [];
  for (const url of msgUrls) {
    // The links come out of the listing's own HTML, so the source chooses what
    // we fetch next. Confine that choice to the source's own host — see
    // resolveSameHost.
    const target = resolveSameHost(url, opts.listingUrl);
    if (target === null) {
      console.warn(`[${tag}] Ignoring off-host message url: ${url}.`);
      continue;
    }
    const match = opts.idPattern.exec(target);
    if (!match) {
      console.warn(`[${tag}] No numeric id found in url: ${target}. Skipping.`);
      continue;
    }
    const messageId = Number(match[1]);
    if (messageId <= storedId) break;
    newMessages.push({ id: messageId, url: target });
  }

  if (newMessages.length === 0) return;

  // First run ever: initialize the cursor at the newest visible id without
  // processing — don't ingest (and notify about) the listing's history.
  if (storedId === 0 && !(await hasStateRow(env, category))) {
    const newest = Math.max(...newMessages.map((m) => m.id));
    console.log(`[${tag}] First run — bootstrapping cursor to ${newest} without processing history.`);
    await writeLastId(env, category, newest);
    return;
  }

  // Oldest-first; cap work per tick — anything left is picked up next tick
  // because the cursor only advances past successes.
  const batch = newMessages.reverse().slice(0, MAX_MESSAGES_PER_TICK);
  for (const { id, url } of batch) {
    if (Date.now() >= deadline) {
      console.warn(`[${tag}] Deadline reached; id=${id} waits for the next tick.`);
      break;
    }

    let html: string;
    try {
      html = await readCapped(await fetchImpl(url, undefined, deadline));
    } catch (e) {
      // Outside the attempt cap on purpose: a 503 or a dropped connection says
      // nothing about the message, and transient network trouble must not spend
      // a real message's strikes.
      console.error(`[${tag}] Failed to fetch message (id=${id}): ${e}. Stopping.`);
      break;
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
      continue;
    }

    let submitted = false;
    try {
      const message = await opts.parseMessage(html);
      if (message === null) {
        console.warn(`[${tag}] Could not parse message content (id=${id}).`);
      } else {
        submitted = await processImpl(env, tag, category, message.title, message.content, `id=${id}`, deadline);
      }
    } catch (e) {
      console.error(`[${tag}] Failed to process message (id=${id}): ${e}.`);
    }

    if (!submitted) {
      console.warn(
        `[${tag}] Stopping at id=${id}; it will be retried next run ` +
        `(attempt ${attempts}/${MAX_PRE_STORE_ATTEMPTS}).`);
      break;
    }
    await releaseAttempts(env, category, String(id));

    // Persist the cursor after EACH success, not once after the whole batch.
    // A trailing write never runs when the invocation is killed mid-batch —
    // and it routinely is: the next message's AI parse can burn the remaining
    // budget, so the runner's deadline guard aborts source.run() before the
    // post-loop write is reached. The already-notified message then looks new
    // on every following tick, re-storing and re-pushing it until the cursor
    // finally advances. Writing per success commits delivered work immediately.
    // Ids are ascending (batch is oldest-first), so the cursor only ever moves
    // forward, and writeLastId is an idempotent upsert.
    await writeLastId(env, category, id);
  }
}
