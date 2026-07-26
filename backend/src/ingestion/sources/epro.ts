// ERP Sever / Energo-Pro (erpsever.bg) — planned power interruptions via the
// JSON XHR endpoint its map uses. Port of epro_service.py. Entries carry no
// stable id → SHA-256 content hash (24 hex chars). Seen-ids are persisted
// per-message on success so a mid-run abort never re-broadcasts (§1.7).
//
// Endpoint contract (changed since the Python port): the parameterless call
// returns the area list with every interruption bucket EMPTY. Entries are only
// returned for a queried `region_id` + `type`, inside a single `area_locations`
// array (each item tagged with `location_interruption`). `offset` is ignored —
// one call per type returns the whole list. So we query each active type for the
// configured region and read `area_locations`, rather than the old top-level
// `area_locations_for_next_48_hours` / `_all_active` keys, which are now always
// empty (which is why epro silently delivered nothing).

import type { Env } from "../../env";
import { processOutageMessage } from "../pipeline";
import { DEFAULT_HEADERS, fetchPage, readCapped, stripHtml } from "../scrape";
import { addSeenIds, getSeenIds, hasStateRow } from "../state";
import { MAX_MESSAGES_PER_TICK } from "./id-listing";

const TAG = "EPRO";
const CATEGORY = "epro";
const TITLE = "Прекъсване на електрозахранването";

// Interruption filters queried per region; "archive" is deliberately excluded.
// all_active is largely a superset of the next-48h window, but they don't fully
// overlap, so both are fetched and de-duplicated by content.
const INTERRUPTION_TYPES = ["for_next_48_hours", "all_active"] as const;

/** Injectable for tests; defaults to the real page fetcher. */
export type FetchImpl = (
  url: string, headers?: Record<string, string>, deadline?: number,
) => Promise<Response>;

interface EproEntry {
  location_period?: string;
  location_text?: string;
}

async function entryId(period: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${period}|${text}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function entriesUrl(base: string, regionId: string, type: string): string {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}region_id=${encodeURIComponent(regionId)}&type=${type}`
    + "&offset=0&archive_from_date=&archive_to_date=";
}

/** Exported for tests; see run() for the production entry point. */
export async function fetchVarnaEntries(
  env: Env, deadline?: number, fetchImpl: FetchImpl = fetchPage,
): Promise<EproEntry[] | null> {
  // De-dupe across the two type buckets by raw content; the same interruption
  // appears identically in both, and one AI parse per interruption is enough.
  const byKey = new Map<string, EproEntry>();
  let anyOk = false;

  for (const type of INTERRUPTION_TYPES) {
    let areas: unknown;
    try {
      const res = await fetchImpl(
        entriesUrl(env.EPRO_URL, env.EPRO_REGION_ID, type),
        { ...DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest" },
        deadline);
      // Read through the size cap rather than res.json(), which would buffer
      // whatever the endpoint decides to send (see readCapped).
      areas = JSON.parse(await readCapped(res));
    } catch (e) {
      // One type failing must not discard the other — press on.
      console.error(`[EPRO] Failed to fetch '${type}' interruptions: ${e}.`);
      continue;
    }

    // The endpoint is undocumented and could return anything; an unexpected
    // shape must read as "this type had nothing", not throw out of the runner.
    if (!Array.isArray(areas)) {
      console.error(`[EPRO] '${type}' response was not an array.`);
      continue;
    }

    const area = (areas as Array<Record<string, unknown>>)
      .find((a) => a && typeof a === "object" && String(a.area_id) === env.EPRO_REGION_ID);
    if (!area) {
      console.error(`[EPRO] Region '${env.EPRO_REGION_ID}' not found in '${type}' response.`);
      continue;
    }
    // Soft config sanity check — region_id is the key, but a mismatched name
    // usually means EPRO_REGION_ID points at the wrong region.
    if (typeof area.area_name === "string" && area.area_name !== env.EPRO_AREA_NAME) {
      console.warn(`[EPRO] Region ${env.EPRO_REGION_ID} is '${area.area_name}', expected '${env.EPRO_AREA_NAME}'.`);
    }
    anyOk = true;

    const locations = area.area_locations;
    if (!Array.isArray(locations)) continue;
    for (const item of locations as EproEntry[]) {
      if (!item || typeof item !== "object") continue;
      const key = `${item.location_period ?? ""}|${item.location_text ?? ""}`;
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }

  // Every type query failing is "couldn't read the source", not "no entries":
  // return null so run() skips the tick instead of bootstrapping the real
  // interruptions away or treating a transient outage as an empty listing.
  if (!anyOk) return null;
  return [...byKey.values()];
}

export async function run(env: Env, deadline: number, fetchImpl: FetchImpl = fetchPage): Promise<void> {
  const entries = await fetchVarnaEntries(env, deadline, fetchImpl);
  if (entries === null) return;

  // First run ever: mark everything currently visible as seen without
  // processing (the old system already notified about it). Runs even when
  // the entry list is empty — the state row must exist so interruptions
  // appearing later are processed rather than bootstrapped away.
  if (!(await hasStateRow(env, CATEGORY))) {
    const ids: string[] = [];
    for (const entry of entries) {
      const period = stripHtml(entry.location_period ?? "");
      const text = stripHtml(entry.location_text ?? "").split("Публикувано на")[0]!.trim();
      if (text) ids.push(await entryId(period, text));
    }
    console.log(`[EPRO] First run — bootstrapping ${ids.length} seen id(s) without processing.`);
    await addSeenIds(env, CATEGORY, ids.length > 0 ? ids : ["bootstrap"]);
    return;
  }
  if (entries.length === 0) return;

  const storedSeen = await getSeenIds(env, CATEGORY);
  if (storedSeen === null) {
    // An unreadable seen set looks like "nothing processed yet", which would
    // re-notify every active interruption. Wait for the next tick.
    console.error("[EPRO] Could not read seen ids. Skipping this tick.");
    return;
  }
  const seenIds = new Set(storedSeen);
  let processed = 0;

  for (const entry of entries) {
    if (processed >= MAX_MESSAGES_PER_TICK || Date.now() >= deadline) break;

    const period = stripHtml(entry.location_period ?? "");
    // Drop the boilerplate footer ("Публикувано на ..." + portal link).
    const text = stripHtml(entry.location_text ?? "").split("Публикувано на")[0]!.trim();
    if (!text) continue;

    const id = await entryId(period, text);
    if (seenIds.has(id)) continue;

    const content = period ? `${period}\n${text}` : text;
    processed++;
    if (await processOutageMessage(env, TAG, CATEGORY, TITLE, content, `id=${id}`, deadline)) {
      seenIds.add(id);
      await addSeenIds(env, CATEGORY, [id]);
    }
  }
}
