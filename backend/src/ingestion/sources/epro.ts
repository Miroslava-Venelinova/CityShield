// ERP Sever / Energo-Pro (erpsever.bg) — planned power interruptions via the
// JSON XHR endpoint its map uses. Port of epro_service.py. Entries carry no
// stable id → SHA-256 content hash (24 hex chars). Seen-ids are persisted
// per-message on success so a mid-run abort never re-broadcasts (§1.7).

import type { Env } from "../../env";
import { processOutageMessage } from "../pipeline";
import { DEFAULT_HEADERS, fetchPage, stripHtml } from "../scrape";
import { addSeenIds, getSeenIds, hasStateRow } from "../state";
import { MAX_MESSAGES_PER_TICK } from "./id-listing";

const TAG = "EPRO";
const CATEGORY = "epro";
const TITLE = "Прекъсване на електрозахранването";

// Interruption buckets published per area; "archive" is deliberately excluded.
const ACTIVE_KEYS = ["area_locations_for_next_48_hours", "area_locations_all_active"] as const;

interface EproEntry {
  location_period?: string;
  location_text?: string;
}

async function entryId(period: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${period}|${text}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function fetchVarnaEntries(env: Env): Promise<EproEntry[] | null> {
  let areas: Array<Record<string, unknown>>;
  try {
    const res = await fetchPage(env.EPRO_URL, { ...DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest" });
    areas = await res.json();
  } catch (e) {
    console.error(`[EPRO] Failed to fetch interruptions endpoint: ${e}.`);
    return null;
  }

  const area = areas.find((a) => a.area_name === env.EPRO_AREA_NAME);
  if (!area) {
    console.error(`[EPRO] Area '${env.EPRO_AREA_NAME}' not found in endpoint response.`);
    return null;
  }

  const entries: EproEntry[] = [];
  for (const key of ACTIVE_KEYS) {
    const raw = area[key] ?? "[]";
    try {
      const items = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(items)) entries.push(...items);
    } catch (e) {
      console.warn(`[EPRO] Could not decode '${key}': ${e}. Skipping bucket.`);
    }
  }
  return entries;
}

export async function run(env: Env, deadline: number): Promise<void> {
  const entries = await fetchVarnaEntries(env);
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

  const seenIds = new Set(await getSeenIds(env, CATEGORY));
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
    if (await processOutageMessage(env, TAG, CATEGORY, TITLE, content, `id=${id}`)) {
      seenIds.add(id);
      await addSeenIds(env, CATEGORY, [id]);
    }
  }
}
