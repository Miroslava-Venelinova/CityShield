// Port of services/common.py's shared tail (SPEC.md §1.7):
// AI parse → validate → polygons → ingest. The old HTTP POST to the ASP.NET
// API becomes a direct call into alert-service.ts, under the same
// store-first / notification-failure-never-fails rule.

import {
  type AlertPayload, incrementPushAttempts, isHedged, markAlertNotified,
  sendUsersNotification, settlementScope, storeAlert,
} from "../core/alert-service";
import { getRecentAlertsForDedup, getRegions, getStreets } from "../db/queries";
import type { Env } from "../env";
import { OUTAGE_AI_PROMPT } from "../shared/constants";
import { OUTAGE_JSON_SCHEMA, outageAiSchema, type ProcessedData } from "../shared/schemas";
import { normalizeSchedule, sofiaToday } from "../shared/datetime";
import { expired } from "../shared/deadline";
import { aiParse } from "./ai";
import { normalizeParse } from "./normalize";
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

  const alert: AlertPayload = {
    category,
    title,
    content,
    locations: processed.locations,
    startTime: processed.start_time,
    endTime: processed.end_time,
    windows: processed.windows,
    cityWide: processed.city_wide,
    busLines: processed.bus_lines ?? null,
  };

  let stored;
  try {
    stored = await storeAlert(env, alert, sourceRef, deadline);
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

  // §1.6: a hedged restatement of an outage we already pushed is STORED but not
  // pushed a second time. 9 groups in the 08.2026 corpus (18 alerts, 3.8%) were
  // an outage message paired with a "possible disturbances" one for the same
  // area and hours, and both notified — two pushes for one event.
  //
  // Only the hedged one is ever suppressed, and only against a confirmed alert
  // that has ALREADY been delivered. That asymmetry is the safety property: a
  // confirmed outage can never be silenced by a hedge, whichever order they
  // arrive in, and the suppressed alert is still stored and still in the feed.
  const duplicateOf = await findDeliveredDuplicate(env, alert, processed, stored.id);
  if (duplicateOf !== null) {
    console.log(
      `[${tag}] ${msgRef} stored as ${stored.id} but NOT pushed: it restates alert `
      + `${duplicateOf} (same locations and window), which was already delivered.`);
    await markAlertNotified(env, stored.id);
    return true;
  }

  let delivered = false;
  try {
    ({ delivered } = await sendUsersNotification(env, alert));
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
 * Full shared tail for one outage-style message (vik, epro, heating):
 * AI parse → deterministic guards → polygons → ingest. Returns true on success.
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
  const message = `${title}\n${content}`;
  const aiOutput = await aiParse(
    env, OUTAGE_AI_PROMPT, `CURRENT_DATE: ${today}\n${message}`,
    OUTAGE_JSON_SCHEMA, outageAiSchema, deadline);
  if (aiOutput === null) {
    console.error(`[${tag}] AI parsing failed (${msgRef}).`);
    return false;
  }

  // The model gives a schedule (a date range plus the clock windows inside it);
  // the flat start/end pair every reader still uses is the envelope derived from
  // it here, and a malformed field degrades to "no time" rather than a wrong
  // active window.
  const { start_time, end_time, windows } = normalizeSchedule(aiOutput.schedule, today);

  // Deterministic guards over what the model produced, decided from the source
  // text and the seeded rows rather than from the parse (ingestion/normalize.ts).
  // Both reference reads are served by the same 6-hour cache the enrichment and
  // polygon steps below already use, so this costs no extra D1 query.
  const processed = normalizeParse({
    locations: [...aiOutput.locations],
    city_wide: aiOutput.city_wide,
    start_time,
    end_time,
    windows,
  }, message, { regions: await getRegions(env), streets: await getStreets(env) }, category);

  // For every location marked is_polygon, build a GeoJSON polygon from its
  // street list. Polygon failures leave polygon_geojson unset but record WHY —
  // never fail the message over a polygon (port of build_polygons).
  for (const location of processed.locations) {
    if (!location.is_polygon) continue;
    // A polygon is an enhancement; out of budget just means no polygon, and
    // the store+notify below still has to happen for this message.
    if (expired(deadline, POLYGON_MIN_BUDGET_MS)) {
      console.warn(`[${tag}] Skipping polygon build for ${msgRef} — low on time budget.`);
      location.polygon_failure = "out of time budget";
      continue;
    }
    // The settlement is what both halves of the polygon path were missing: the
    // street resolution had no scope, so it picked rows from other towns, and the
    // Overpass query was hardcoded to Варна, so it asked the wrong place about
    // them. Resolved to a row here because polygon.ts needs its centroid, not
    // just its name — see SETTLEMENT_STREET_REACH_KM.
    const scope = settlementScope(location.settlement, location.area, await getRegions(env));
    if (scope === null) {
      const reason = `no seeded settlement for "${location.settlement ?? location.area ?? "?"}"`;
      console.warn(`[${tag}] Skipping polygon build for ${msgRef} — ${reason}.`);
      location.polygon_failure = reason;
      continue;
    }
    const result = await buildPolygonForStreets(env, location.streets, scope, deadline);
    location.polygon_geojson = result.polygon ?? undefined;
    if (!result.polygon) location.polygon_failure = result.reason ?? "unknown";
  }

  return ingestAlert(env, tag, category, title, content, processed, msgRef, deadline);
}


// ── Duplicate pairs (§1.6) ───────────────────────────────────────────────────

/**
 * How far back to look for the alert this one restates.
 *
 * The pairs in the corpus are published minutes apart by the same source, and a
 * short window is what keeps this from suppressing a genuine repeat outage of
 * the same block a day later.
 */
const DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The comparison key: which places, for which hours. */
function dedupKey(
  locations: readonly { settlement: string | null; area: string | null; streets: string[] }[],
  startTime: string | null, endTime: string | null,
): string {
  const places = locations
    .map((l) => [l.settlement ?? "", l.area ?? "", [...l.streets].sort().join("|")].join("~"))
    .sort()
    .join(";");
  return `${places}@${startTime ?? ""}..${endTime ?? ""}`;
}

/**
 * The id of an already-delivered alert this one merely restates, or null.
 *
 * Returns non-null ONLY when the incoming alert is the hedged one. A confirmed
 * outage is never suppressed — if the hedged message happened to arrive first
 * and was pushed, the confirmed one that follows still goes out, because that is
 * the message people actually need.
 *
 * Never throws: this decides whether to send a second push, and a D1 hiccup must
 * degrade to sending it rather than to losing an alert.
 */
async function findDeliveredDuplicate(
  env: Env, alert: AlertPayload, processed: ProcessedData, selfId: string,
): Promise<string | null> {
  if (!isHedged(alert.title, alert.content)) return null;
  // Nothing to compare on: a city-wide alert or one with no locations has no
  // place list, and matching on the window alone would suppress unrelated
  // messages that happen to share their hours. `processed` rather than
  // `alert.locations`, which is deliberately untyped on the payload.
  if (processed.locations.length === 0) return null;

  try {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const recent = await getRecentAlertsForDedup(env, alert.category, since);
    const key = dedupKey(processed.locations, alert.startTime, alert.endTime);

    for (const row of recent) {
      if (row.id === selfId) continue;
      // Only against something already delivered — suppressing against an alert
      // that has not gone out yet could silence the event entirely.
      if (row.notified_at === null) continue;
      if (isHedged(row.title, row.content)) continue; // both hedged: not the pair

      // The stored side is compared on its ENRICHED locations, which carry the
      // same three slots under different key names (AlertLocationDTO).
      const stored = JSON.parse(row.locations_json) as Array<{
        settlement: string | null; area: string | null; sublocations?: string[];
      }>;
      if (!Array.isArray(stored) || stored.length === 0) continue;
      const storedKey = dedupKey(
        stored.map((l) => ({
          settlement: l.settlement ?? null,
          area: l.area ?? null,
          streets: l.sublocations ?? [],
        })),
        row.start_time, row.end_time);
      if (storedKey === key) return row.id;
    }
  } catch (e) {
    console.warn(`[pipeline] Duplicate check failed, sending anyway: ${e}`);
  }
  return null;
}
