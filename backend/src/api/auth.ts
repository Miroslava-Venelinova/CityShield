// /api/auth/* — port of AuthController.cs + AuthService.cs (PLAN.MD §1.4).
// Contract parity: exact routes, status codes, text bodies, camelCase DTOs.

import { Hono } from "hono";
import { z } from "zod";
import { bestMatch, SIMILARITY_THRESHOLD } from "../core/fuzzy";
import { reverseGeocode } from "../core/geocoding";
import { signToken } from "../core/jwt";
import { hashPassword, verifyPassword } from "../core/password";
import * as q from "../db/queries";
import type { AppEnv } from "./middleware";
import { requireAuth } from "./middleware";
import { clientIp, isOverLimit, perUserRateLimit, tooManyRequests } from "./rate-limit";

// Mirrors RegisterRequest.cs data annotations.
const registerSchema = z.object({
  email: z.string().min(5).max(50).email(),
  password: z.string().min(8).max(50),
});

const loginSchema = z.object({
  email: z.string(),
  password: z.string(),
});

/** Budget for the one outbound Nominatim call behind PUT /location. */
const LOCATION_BUDGET_MS = 10_000;

// Mirrors UpdateLocationRequest.cs [Range] annotations.
const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const authRoutes = new Hono<AppEnv>()

  .post("/register", async (c) => {
    // Signup is the cheapest endpoint to abuse: it both writes rows and, via
    // the 409 below, discloses whether an address is registered.
    const ip = clientIp(c.req.raw.headers);
    if (await isOverLimit(c.env.RL_REGISTER_IP, ip, "RL_REGISTER_IP")) return tooManyRequests(60);

    const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid registration data", 400);
    const { email, password } = parsed.data;

    if (await q.getUserByEmail(c.env, email))
      return c.text("An account with this email already exists", 409);

    await q.insertUser(c.env, crypto.randomUUID(), email, await hashPassword(password));
    return c.text("User successfully registered", 200);
  })

  .post("/login", async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid login data", 400);
    const { email, password } = parsed.data;

    // Two independent limiters, because one key cannot catch both attack
    // shapes. The previous (email, ip) composite key caught neither: password
    // spraying varies the email, and a botnet varies the IP, so each attempt
    // landed in a fresh bucket that never filled.
    const ip = clientIp(c.req.raw.headers);
    if (await isOverLimit(c.env.RL_LOGIN_IP, ip, "RL_LOGIN_IP")) return tooManyRequests(60);
    if (await isOverLimit(c.env.RL_LOGIN_EMAIL, email.toLowerCase(), "RL_LOGIN_EMAIL"))
      return tooManyRequests(60);

    const user = await q.getUserByEmail(c.env, email);
    if (!user || !(await verifyPassword(password, user.password_hash)))
      return c.text("Invalid email or password", 401);

    return c.json({ token: await signToken(c.env, user.user_id, user.email) });
  })

  .get("/me", requireAuth, async (c) => {
    const user = await q.getUserById(c.env, c.get("userId"));
    if (!user) return c.text("User does not exist", 404);
    return c.json({
      email: user.email,
      latitude: user.latitude,
      longitude: user.longitude,
      hasLocation: user.region_id !== null,
      regionName: user.region_name,
      streetName: user.street_name,
      createdOnUTC: user.created_on_utc,
      updatedOnUTC: user.updated_on_utc,
    });
  })

  // ── GDPR (§1.10 / §2.3) ──────────────────────────────────────────────────

  .delete("/me", requireAuth, async (c) => {
    // Erasure (Art. 17): cascades to device tokens + preferences.
    // Log only a non-identifying event.
    await q.deleteUser(c.env, c.get("userId"));
    console.log("Account deleted (GDPR erasure request).");
    return c.body(null, 204);
  })

  .get("/me/export", requireAuth, async (c) => {
    // Portability (Art. 20): all stored personal data as JSON.
    const user = await q.getUserById(c.env, c.get("userId"));
    if (!user) return c.text("User does not exist", 404);

    let subscribedBusLines: string[] = [];
    try {
      const parsed = JSON.parse(user.subscribed_bus_lines);
      if (Array.isArray(parsed)) subscribedBusLines = parsed;
    } catch { /* corrupt JSON → empty list */ }

    const preferences = (await q.getPreferenceRows(c.env, user.user_id))
      .map((p) => ({ category: p.category, isEnabled: p.is_enabled === 1 }));
    const devices = (await q.getDeviceTokenMetadata(c.env, user.user_id))
      .map((d) => ({ platform: d.platform, deviceName: d.device_name, createdAt: d.created_at, lastSeenAt: d.last_seen_at }));

    return c.json({
      profile: {
        email: user.email,
        latitude: user.latitude,
        longitude: user.longitude,
        regionName: user.region_name,
        streetName: user.street_name,
        receivesAllAlerts: user.receives_all_alerts === 1,
        subscribedBusLines,
        createdOnUTC: user.created_on_utc,
        updatedOnUTC: user.updated_on_utc,
      },
      notificationPreferences: preferences,
      devices,
    });
  })

  .delete("/location", requireAuth, async (c) => {
    // Withdraw location consent: clear lat/lng + region/street.
    await q.clearUserLocation(c.env, c.get("userId"));
    return c.body(null, 204);
  })

  // Rate limited per user: each call makes an outbound Nominatim request, and
  // OSMF's usage policy (≤1 req/s) is a commitment we make in the privacy
  // policy (§2.2). Without this, one client in a retry loop can get the
  // Worker's egress IPs blocked for every user.
  .put("/location", requireAuth, perUserRateLimit((e) => e.RL_GEOCODE_USER, "RL_GEOCODE_USER", 60), async (c) => {
    const parsed = locationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid location data", 400);
    const { latitude, longitude } = parsed.data;

    const user = await q.getUserById(c.env, c.get("userId"));
    if (!user) return c.text("User does not exist", 404);

    // Reverse-geocode, then fuzzy-match region (and street) — port of
    // AuthService.UpdateLocationAsync. Geocoding failure (including a Nominatim
    // that never answers) just means no region/street match; the coordinates
    // are still saved.
    const address = await reverseGeocode(c.env, latitude, longitude, Date.now() + LOCATION_BUDGET_MS);

    const region = address.regionName
      ? bestMatch(address.regionName, await q.getRegions(c.env), (r) => r.name, SIMILARITY_THRESHOLD)
      : null;
    const street = address.streetName
      ? bestMatch(address.streetName, await q.getStreets(c.env), (s) => s.name, SIMILARITY_THRESHOLD)
      : null;

    await q.updateUserLocation(
      c.env, user.user_id, latitude, longitude, region?.id ?? null, street?.id ?? null);
    return c.body(null, 204);
  });
