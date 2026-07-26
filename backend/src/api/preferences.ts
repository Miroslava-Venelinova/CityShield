// /api/preferences/* — port of NotificationPreferencesController.cs +
// NotificationPreferencesService.cs. Categories default to enabled (opt-out).

import { Hono } from "hono";
import { z } from "zod";
import { BUS_LINES, isKnownBusLine, normalizeBusLine } from "../core/bus-lines";
import * as q from "../db/queries";
import { KNOWN_CATEGORIES } from "../shared/constants";
import type { AppEnv } from "./middleware";
import { requireAuth } from "./middleware";

const setPreferenceSchema = z.object({ isEnabled: z.boolean() });

/**
 * Bounded because every element is normalized and set-matched before anything
 * is rejected, so an unbounded array is a free way to spend the request's CPU
 * budget. The catalog holds 38 lines and the longest is 4 characters, so a
 * legitimate client never comes close to either cap.
 */
const setBusLinesSchema = z.object({
  busLines: z.array(z.string().max(16)).max(64),
});

export const preferenceRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", async (c) => {
    const existing = new Map(
      (await q.getPreferenceRows(c.env, c.get("userId")))
        .map((row) => [row.category, row.is_enabled === 1]),
    );
    const prefs = [...KNOWN_CATEGORIES].map(([category, label]) => ({
      category,
      label,
      isEnabled: existing.get(category) ?? true,
    }));
    return c.json(prefs);
  })

  // Must be registered before PUT /:category so "bus-lines" isn't captured.
  .get("/bus-lines", async (c) => {
    const user = await q.getUserById(c.env, c.get("userId"));
    let selected: string[] = [];
    try {
      const parsed = JSON.parse(user?.subscribed_bus_lines ?? "[]");
      if (Array.isArray(parsed)) selected = parsed.filter((x) => typeof x === "string");
    } catch { /* corrupt JSON → empty selection */ }
    return c.json({ available: [...BUS_LINES], selected });
  })

  .put("/bus-lines", async (c) => {
    const parsed = setBusLinesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid bus-lines data", 400);

    const normalized = [...new Set(
      parsed.data.busLines
        .map(normalizeBusLine)
        .filter((line): line is string => line !== null),
    )];

    const unknown = normalized.filter((line) => !isKnownBusLine(line));
    if (unknown.length > 0)
      return c.text(`Unknown bus line(s): ${unknown.join(", ")}`, 400);

    const user = await q.getUserById(c.env, c.get("userId"));
    if (!user) return c.text(`Unknown user: ${c.get("userId")}`, 400);

    await q.updateUserBusLines(c.env, user.user_id, normalized);
    return c.body(null, 204);
  })

  .put("/:category", async (c) => {
    const category = c.req.param("category");
    if (!KNOWN_CATEGORIES.has(category))
      return c.text(`Unknown category: ${category}`, 400);

    const parsed = setPreferenceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid preference data", 400);

    await q.upsertPreference(c.env, c.get("userId"), category, parsed.data.isEnabled);
    return c.body(null, 204);
  });
