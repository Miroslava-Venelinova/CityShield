// Port of services/common.py's shared tail (PLAN.MD §1.7):
// AI parse → validate → polygons → ingest. The old HTTP POST to the ASP.NET
// API becomes a direct call into alert-service.ts, under the same
// store-first / notification-failure-never-fails rule.

import { sendUsersNotification, storeAlert } from "../core/alert-service";
import type { Env } from "../env";
import { OUTAGE_AI_PROMPT } from "../shared/constants";
import { OUTAGE_JSON_SCHEMA, outageAiSchema, type ProcessedData } from "../shared/schemas";
import { expired } from "../shared/deadline";
import { aiParse } from "./ai";
import { buildPolygonForStreets } from "./polygon";

// Overpass round-trip plus the JSTS pipeline; below this there is no point
// starting, and the remaining budget is better spent storing the alert.
const POLYGON_MIN_BUDGET_MS = 6_000;

/**
 * Store + notify — the direct-call replacement for submit_to_api. Returns
 * true when the alert was stored (a notification failure does not fail the
 * message; retrying it would duplicate the alert AND the pushes).
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
  let alertId: string;
  try {
    alertId = await storeAlert(
      env, category, title, content, processed.start_time, processed.end_time,
      processed.locations, deadline);
  } catch (e) {
    console.error(`[${tag}] Failed to store alert for ${msgRef}: ${e}`);
    return false;
  }

  try {
    await sendUsersNotification(
      env, processed.locations, title, content, category,
      processed.start_time, processed.end_time, processed.city_wide,
      processed.bus_lines ?? null);
  } catch (e) {
    console.error(`[${tag}] Notification dispatch failed for alert ${alertId}; the alert is stored. ${e}`);
  }

  console.log(`[${tag}] Ingested ${msgRef} as alert ${alertId}`);
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
  const msgContent = `${title}\n${content}`;
  const aiOutput = await aiParse(
    env, OUTAGE_AI_PROMPT, msgContent, OUTAGE_JSON_SCHEMA, outageAiSchema, deadline);
  if (aiOutput === null) {
    console.error(`[${tag}] AI parsing failed (${msgRef}).`);
    return false;
  }

  const processed = applyCityWideGuard({ ...aiOutput, locations: [...aiOutput.locations] });

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
