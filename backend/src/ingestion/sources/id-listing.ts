// Shared crawler for id-numbered listing sources (vik, heating) — port of
// common.py crawl_id_listing with the §1.7 cron-budget additions: a deadline
// guard and a per-tick message cap. Cursor semantics are preserved verbatim:
// process oldest-first, advance last_id only past successes, a failed message
// blocks newer ones (a retried run must not re-notify), a persistently
// failing message ages off the listing.

import type { Env } from "../../env";
import { processOutageMessage } from "../pipeline";
import { fetchPage } from "../scrape";
import { getLastId, hasStateRow, writeLastId } from "../state";

export const MAX_MESSAGES_PER_TICK = 2;

export interface IdListingOptions {
  tag: string;
  category: string;
  listingUrl: string;
  idPattern: RegExp;
  parsePage: (html: string) => string[] | null;
  parseMessage: (html: string) => { title: string; content: string } | null;
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
    listingHtml = await (await fetchImpl(opts.listingUrl, undefined, deadline)).text();
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
    const match = opts.idPattern.exec(url);
    if (!match) {
      console.warn(`[${tag}] No numeric id found in url: ${url}. Skipping.`);
      continue;
    }
    const messageId = Number(match[1]);
    if (messageId <= storedId) break;
    newMessages.push({ id: messageId, url });
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
  let latestId = storedId;
  const batch = newMessages.reverse().slice(0, MAX_MESSAGES_PER_TICK);
  for (const { id, url } of batch) {
    if (Date.now() >= deadline) {
      console.warn(`[${tag}] Deadline reached; id=${id} waits for the next tick.`);
      break;
    }

    let submitted = false;
    try {
      const message = opts.parseMessage(await (await fetchImpl(url, undefined, deadline)).text());
      if (message === null) {
        console.warn(`[${tag}] Could not parse message content (id=${id}).`);
      } else {
        submitted = await processImpl(env, tag, category, message.title, message.content, `id=${id}`, deadline);
      }
    } catch (e) {
      console.error(`[${tag}] Failed to process message (id=${id}): ${e}.`);
    }

    if (!submitted) {
      console.warn(`[${tag}] Stopping at id=${id}; it will be retried next run.`);
      break;
    }
    latestId = Math.max(latestId, id);
  }

  if (latestId !== storedId) await writeLastId(env, category, latestId);
}
