// Port of services/common.py's shared tail (SPEC.md §1.7):
// AI parse → validate → polygons → ingest. The old HTTP POST to the ASP.NET
// API becomes a direct call into alert-service.ts, under the same
// store-first / notification-failure-never-fails rule.

import {
  incrementPushAttempts, markAlertNotified, sendUsersNotification, storeAlert,
} from "../core/alert-service";
import type { Env } from "../env";
import { OUTAGE_AI_PROMPT } from "../shared/constants";
import { OUTAGE_JSON_SCHEMA, outageAiSchema, type ProcessedData } from "../shared/schemas";
import { normalizeDateTime, sofiaToday } from "../shared/datetime";
import { expired } from "../shared/deadline";
import { aiParse } from "./ai";
import { buildPolygonForStreets } from "./polygon";

// Overpass round-trip plus the JSTS pipeline; below this there is no point
// starting, and the remaining budget is better spent storing the alert.
const POLYGON_MIN_BUDGET_MS = 6_000;

// A push that fails on every tick would otherwise pin the cursor until the
// message ages off its source — a long block on a low-volume listing. After
// this many failed sends, give up on the push and let the cursor advance past
// it. The alert stays stored (notified_at NULL with push_attempts at the cap
// marks it abandoned), so it still shows in the feed; it just never gets pushed.
export const MAX_PUSH_ATTEMPTS = 3;

/**
 * Store + notify — the direct-call replacement for submit_to_api.
 *
 * Both halves are idempotent per source message, so returning false safely
 * hands retry to the cursor: the next tick re-drives the message, storeAlert
 * no-ops on the source_ref, and — because notified_at is still unset — the push
 * is re-sent. Returns true once the alert is stored AND its push has either
 * landed or is genuinely owed to nobody; false only when the send failed and
 * the cursor must hold so the message comes back around.
 */
export async function ingestAlert(
  env: Env,
  tag: string,
  category: string,
  title: string,
  content: string,
  processed: ProcessedData,
  msgRef: string,
  deadline?: number,
): Promise<boolean> {
  // Stable key from the source message to its stored alert, unique across
  // sources: msgRef alone ("id=17148") is not — two categories can share a
  // numeric id — so prefix the category, e.g. "vik:id=17148".
  const sourceRef = `${category}:${msgRef}`;

  let stored;
  try {
    stored = await storeAlert(
      env, category, title, content, processed.start_time, processed.end_time,
      processed.locations, sourceRef, deadline);
  } catch (e) {
    console.error(`[${tag}] Failed to store alert for ${msgRef}: ${e}`);
    return false;
  }

  // Already delivered on an earlier tick (store found the stored row with its
  // flag set): the push is done, so let the cursor advance without re-sending.
  if (stored.notified_at !== null) {
    console.log(`[${tag}] ${msgRef} already delivered as alert ${stored.id}; skipping push.`);
    return true;
  }

  let delivered = false;
  try {
    ({ delivered } = await sendUsersNotification(
      env, processed.locations, title, content, category,
      processed.start_time, processed.end_time, processed.city_wide,
      processed.bus_lines ?? null));
  } catch (e) {
    console.error(`[${tag}] Notification dispatch errored for alert ${stored.id}; will retry. ${e}`);
    return false;
  }

  if (!delivered) {
    const attempts = await incrementPushAttempts(env, stored.id);
    if (attempts >= MAX_PUSH_ATTEMPTS) {
      // Give up: unblock the cursor rather than pin it forever. The alert stays
      // stored with notified_at NULL — findable as abandoned by push_attempts.
      console.error(
        `[${tag}] Giving up on alert ${stored.id} after ${attempts} failed push attempt(s); advancing past ${msgRef}.`);
      return true;
    }
    // The alert is stored; hold the cursor so the next tick re-drives it. The
    // re-store is a no-op (source_ref) and notified_at is still unset, so the
    // push retries without a duplicate alert.
    console.warn(
      `[${tag}] Push send failed for alert ${stored.id} (attempt ${attempts}/${MAX_PUSH_ATTEMPTS}); holding cursor to retry.`);
    return false;
  }

  await markAlertNotified(env, stored.id);
  console.log(`[${tag}] Ingested ${msgRef} as alert ${stored.id}`);
  return true;
}

/**
 * Deterministic guard for spike 2's known qwen3 deviation: ~1/5 runs the
 * model emits a single location "град Варна" with no sublocations instead of
 * city_wide=true + empty locations. Same shape every time — normalize it.
 */
export function applyCityWideGuard(output: ProcessedData): ProcessedData {
  if (output.locations.length === 1) {
    const only = output.locations[0]!;
    const name = (only.location_name ?? "").trim();
    if (only.sublocations.length === 0 && !only.is_polygon && /^(гр\.\s*|град\s+)?варна$/iu.test(name)) {
      return { ...output, locations: [], city_wide: true };
    }
  }
  return output;
}

/**
 * Full shared tail for one outage-style message (vik, epro, heating):
 * AI parse → city-wide guard → polygons → ingest. Returns true on success.
 */
export async function processOutageMessage(
  env: Env,
  tag: string,
  category: string,
  title: string,
  content: string,
  msgRef: string,
  deadline?: number,
): Promise<boolean> {
  // The date the model defaults to when a message states a time but no date.
  // Pinned once here so both the prompt input and the normalization below agree
  // even if the message is processed across a midnight boundary.
  const today = sofiaToday();
  const msgContent = `CURRENT_DATE: ${today}\n${title}\n${content}`;
  const aiOutput = await aiParse(
    env, OUTAGE_AI_PROMPT, msgContent, OUTAGE_JSON_SCHEMA, outageAiSchema, deadline);
  if (aiOutput === null) {
    console.error(`[${tag}] AI parsing failed (${msgRef}).`);
    return false;
  }

  const processed = applyCityWideGuard({
    ...aiOutput,
    locations: [...aiOutput.locations],
    // Coerce the model's times to canonical ISO local datetimes (or null); a
    // malformed value degrades to "no time" rather than a wrong active window.
    start_time: normalizeDateTime(aiOutput.start_time, today),
    end_time: normalizeDateTime(aiOutput.end_time, today),
  });

  // For every location marked is_polygon, build a GeoJSON polygon from its
  // street list. Polygon failures leave polygon_geojson unset — never fail
  // the message over a polygon (port of build_polygons).
  for (const location of processed.locations) {
    if (!location.is_polygon) continue;
    // A polygon is an enhancement; out of budget just means no polygon, and
    // the store+notify below still has to happen for this message.
    if (expired(deadline, POLYGON_MIN_BUDGET_MS)) {
      console.warn(`[${tag}] Skipping polygon build for ${msgRef} — low on time budget.`);
      continue;
    }
    const polygon = await buildPolygonForStreets(env, location.sublocations, deadline);
    location.polygon_geojson = polygon ?? undefined;
  }

  return ingestAlert(env, tag, category, title, content, processed, msgRef, deadline);
}
