// /api/alerts/* — port of AlertsController.cs. submit-data is kept for manual
// test injection (send_test_alerts.py usage); Phase 3 scrapers call the same
// storeAlert/sendUsersNotification functions directly.

import { Hono } from "hono";
import { getRecentAlerts, sendUsersNotification, storeAlert } from "../core/alert-service";
import { sendPushToUsers } from "../core/onesignal";
import * as q from "../db/queries";
import { KNOWN_CATEGORIES } from "../shared/constants";
import { detach } from "./background";
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
// 15-minute cron, so a 60 s edge TTL is well inside the source's own latency.
const FEED_CACHE_TTL_S = 60;

/** User-independent cache key — never derived from the caller's token. */
const feedCacheKey = (url: string) => new Request(`${new URL(url).origin}/api/alerts/recent`);

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
    // Manual injection has no source message, so no dedup key: pass null and
    // always store a fresh row (the idempotency path is for cursor-driven
    // sources; see ingestAlert).
    const deadline = Date.now() + SUBMIT_BUDGET_MS;
    const { id: alertId } = await storeAlert(
      c.env, category, title, content, startTime, endTime, locations, null, deadline);

    // Never fail the request once the alert is stored: a non-2xx here would
    // make the scraper re-submit a message whose pushes already went out.
    let notifiedIds: string[] = [];
    try {
      ({ recipients: notifiedIds } = await sendUsersNotification(
        c.env, locations, title, content, category, startTime, endTime, cityWide, busLines));
    } catch (e) {
      console.error(`Notification dispatch failed for alert ${alertId}; the alert is stored. ${e}`);
    }

    return c.json({
      alert_id: alertId,
      notified_count: notifiedIds.length,
      user_ids: notifiedIds,
    });
  })

  // Ops tool: verifies push delivery end to end without inventing an alert.
  // Deliberately does *not* go through sendUsersNotification — geo-targeting,
  // bus-line filtering and category preferences would all silently drop the
  // test push, which is the opposite of what a delivery check needs. Nothing
  // is written to D1, so this never shows up in /recent.
  .post("/test-push", requireIngestKey, async (c) => {
    const data = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const title = data?.title;
    const body = data?.body;
    if (typeof title !== "string" || title.length === 0
      || typeof body !== "string" || body.length === 0)
      return c.json({ error: "title and body must be non-empty strings." }, 400);

    const userId = data?.userId;
    if (userId !== undefined && (typeof userId !== "string" || userId.length === 0))
      return c.json({ error: "userId must be a non-empty string when present." }, 400);

    // A single id needs no row lookup: sendPushToUsers only passes it to
    // OneSignal as an external_id alias, which resolves (or doesn't) there.
    const target = userId ? "user" : "broadcast";
    const userIds = userId ? [userId] : await q.getAllUserIds(c.env);

    // `category: "test"` keeps the payload shape the app's push handler
    // expects while marking the notification as not a real alert.
    const { sent, failed } = await sendPushToUsers(c.env, userIds, {
      title, body, data: { category: "test", startTime: "", endTime: "" },
    });

    return c.json({ sent, failed, target });
  })

  // requireAuth still runs on every request — only the D1 read is cached, and
  // the payload carries no per-user data (city alerts are public information).
  .get("/recent", requireAuth, async (c) => {
    const key = feedCacheKey(c.req.url);
    const hit = await caches.default.match(key);
    // Rebuilt rather than returned as-is: a Response handed back by the Cache
    // API guards its headers, and the security-header middleware in app.ts has
    // to be able to write to whatever leaves this route.
    if (hit) return new Response(hit.body, hit);

    const res = c.json(await getRecentAlerts(c.env, RECENT_WINDOW_MS, RECENT_LIMIT));
    // `public` is required for the Cache API to store the response at all;
    // clients honouring it just means fewer requests for the same public data.
    res.headers.set("Cache-Control", `public, max-age=${FEED_CACHE_TTL_S}`);
    detach(c, caches.default.put(key, res.clone()));
    return res;
  });
