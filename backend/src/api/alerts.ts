// /api/alerts/* — port of AlertsController.cs. submit-data is kept for manual
// test injection (send_test_alerts.py usage); Phase 3 scrapers call the same
// storeAlert/sendUsersNotification functions directly.

import { Hono } from "hono";
import { getRecentAlerts, sendUsersNotification, storeAlert } from "../core/alert-service";
import { type PushNotification, sendPushToTokens } from "../core/fcm";
import { KNOWN_CATEGORIES } from "../shared/constants";
import type { AppEnv } from "./middleware";
import { requireAuth, requireIngestKey } from "./middleware";

// Alerts older than this are no longer "active" for the app.
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
const RECENT_LIMIT = 100;

// Enrichment on this route makes throttled Nominatim calls, so it gets an
// explicit budget rather than leaning on Cloudflare's request timeout: past it,
// locations resolve without coordinates and the alert is still stored.
const SUBMIT_BUDGET_MS = 20_000;

// /recent is the same payload for every authenticated caller, so one cached
// copy serves all of them. Without this, D1 rows read scale with clients ×
// poll rate (100 rows a poll); with it they scale with time only, which is
// what keeps the free plan's daily row-read budget in reach. Ingest runs on a
// 10-minute cron, so a 60 s edge TTL is well inside the source's own latency.
const FEED_CACHE_TTL_S = 60;

/** User-independent cache key — never derived from the caller's token. */
const feedCacheKey = (url: string) => new Request(`${new URL(url).origin}/api/alerts/recent`);

/** Hono only exposes executionCtx when one was supplied (not via app.request in tests). */
function detach(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise; // no ExecutionContext — the cache write is best-effort anyway
  }
}

/** Test hook: drop the edge-cached feed, which outlives per-test D1 resets. */
export async function clearAlertFeedCache(origin = "http://localhost"): Promise<void> {
  await caches.default.delete(feedCacheKey(origin)).catch(() => false);
}

export const alertRoutes = new Hono<AppEnv>()

  .post("/submit-data", requireIngestKey, async (c) => {
    const data = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const originalMessage = data?.original_message as Record<string, unknown> | undefined;
    const processedData = data?.processed_data as Record<string, unknown> | undefined;
    if (!data || typeof originalMessage !== "object" || !originalMessage
      || typeof processedData !== "object" || !processedData)
      return c.text("Malformed payload", 400);

    const title = typeof originalMessage.title === "string" && originalMessage.title.length > 0
      ? originalMessage.title : "Alert";
    const content = typeof originalMessage.content === "string" ? originalMessage.content : "";

    // Category comes from the scraper payload; default to "vik" for older payloads.
    const category = typeof data.category === "string" ? data.category : "vik";
    if (!KNOWN_CATEGORIES.has(category))
      return c.json({ error: `Unknown category: ${category}` }, 400);

    const startTime = typeof processedData.start_time === "string" ? processedData.start_time : null;
    const endTime = typeof processedData.end_time === "string" ? processedData.end_time : null;

    const locations = processedData.locations;
    if (!Array.isArray(locations))
      return c.json({ error: "processed_data.locations must be an array." }, 400);

    const cityWide = typeof processedData.city_wide === "boolean" ? processedData.city_wide : null;
    const busLines = Array.isArray(processedData.bus_lines)
      ? processedData.bus_lines.filter((l): l is string => typeof l === "string")
      : null;

    // Persist BEFORE notifications go out: if the store fails the scraper
    // gets a 500 and can safely re-submit, because no push has been sent yet.
    const deadline = Date.now() + SUBMIT_BUDGET_MS;
    const alertId = await storeAlert(
      c.env, category, title, content, startTime, endTime, locations, deadline);

    // Never fail the request once the alert is stored: a non-2xx here would
    // make the scraper re-submit a message whose pushes already went out.
    let notifiedIds: string[] = [];
    try {
      const selfUrl = c.env.SELF_URL ?? new URL(c.req.url).origin;
      notifiedIds = await sendUsersNotification(
        c.env, locations, title, content, category, startTime, endTime, cityWide, busLines, selfUrl);
    } catch (e) {
      console.error(`Notification dispatch failed for alert ${alertId}; the alert is stored. ${e}`);
    }

    return c.json({
      alert_id: alertId,
      notified_count: notifiedIds.length,
      user_ids: notifiedIds,
    });
  })

  // requireAuth still runs on every request — only the D1 read is cached, and
  // the payload carries no per-user data (city alerts are public information).
  .get("/recent", requireAuth, async (c) => {
    const key = feedCacheKey(c.req.url);
    const hit = await caches.default.match(key);
    if (hit) return hit;

    const res = c.json(await getRecentAlerts(c.env, RECENT_WINDOW_MS, RECENT_LIMIT));
    // `public` is required for the Cache API to store the response at all;
    // clients honouring it just means fewer requests for the same public data.
    res.headers.set("Cache-Control", `public, max-age=${FEED_CACHE_TTL_S}`);
    detach(c, caches.default.put(key, res.clone()));
    return res;
  });

/** Fan-out chain hop (§1.6): each self-invocation gets a fresh 50-subrequest budget. */
export const internalRoutes = new Hono<AppEnv>()
  .post("/push-batch", requireIngestKey, async (c) => {
    const body = await c.req.json().catch(() => null) as
      { tokens?: unknown; notification?: PushNotification } | null;
    if (!body || !Array.isArray(body.tokens) || !body.notification)
      return c.text("Malformed payload", 400);
    const tokens = body.tokens.filter((t): t is string => typeof t === "string");
    const selfUrl = c.env.SELF_URL ?? new URL(c.req.url).origin;
    return c.json(await sendPushToTokens(c.env, tokens, body.notification, selfUrl));
  });
