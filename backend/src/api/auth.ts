// /api/auth/* — port of AuthController.cs + AuthService.cs (PLAN.MD §1.4).
// Contract parity: exact routes, status codes, text bodies, camelCase DTOs.

import { Hono } from "hono";
import { z } from "zod";
import {
  issueToken, consumeToken, RESET_TTL_MINUTES, VERIFY_TTL_MINUTES,
} from "../core/auth-tokens";
import { bestMatch, SIMILARITY_THRESHOLD } from "../core/fuzzy";
import { reverseGeocode } from "../core/geocoding";
import { signToken } from "../core/jwt";
import {
  issueRefreshToken, revokeAllRefreshTokens, revokeRefreshToken, rotateRefreshToken,
} from "../core/refresh-tokens";
import { passwordResetMail, sendMail, verificationMail } from "../core/mailer";
import { hashPassword, verifyPassword } from "../core/password";
import * as q from "../db/queries";
import type { Env } from "../env";
import { resetFormPage, resultPage } from "./auth-pages";
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

const forgotSchema = z.object({ email: z.string().email() });

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

/** Same bounds as registration, so a reset cannot install a password signup would reject. */
const newPasswordSchema = z.string().min(8).max(50);

/**
 * Public origin for links we mail out. `SELF_URL` when configured (cron has no
 * request to derive one from), otherwise the origin of the request itself.
 */
function publicOrigin(env: Env, requestUrl: string): string {
  return env.SELF_URL?.replace(/\/$/, "") ?? new URL(requestUrl).origin;
}

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

    const userId = crypto.randomUUID();
    await q.insertUser(c.env, userId, email, await hashPassword(password));

    // Verification is a nudge, not a gate (see /verify below), so the mail goes
    // out in the background: a mail-provider outage must not fail a signup.
    const token = await issueToken(c.env, userId, "verify_email", VERIFY_TTL_MINUTES);
    const link = `${publicOrigin(c.env, c.req.url)}/api/auth/verify?token=${token}`;
    c.executionCtx.waitUntil(sendMail(c.env, verificationMail(email, link)));

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

    return c.json({
      token: await signToken(c.env, user.user_id, user.email),
      refreshToken: await issueRefreshToken(c.env, user.user_id),
    });
  })

  /**
   * Trade a refresh token for a fresh access token (and a fresh refresh token —
   * rotation, see core/refresh-tokens.ts). Unauthenticated by design: the
   * caller's access token is expected to be expired, which is the whole reason
   * they are here. The refresh token is the credential.
   *
   * Rate limited per IP, because this endpoint hands out access tokens — but on
   * its own bucket, so hourly renewals from a shared IP cannot throttle
   * sign-ins.
   */
  .post("/refresh", async (c) => {
    const ip = clientIp(c.req.raw.headers);
    if (await isOverLimit(c.env.RL_REFRESH_IP, ip, "RL_REFRESH_IP")) return tooManyRequests(60);

    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.body(null, 401);

    const rotated = await rotateRefreshToken(c.env, parsed.data.refreshToken);
    if (!rotated) return c.body(null, 401);

    // The email lives in the JWT, so it is read fresh rather than carried in
    // the refresh row — and a user deleted mid-session fails here instead of
    // being handed a token for an account that no longer exists.
    const user = await q.getUserById(c.env, rotated.userId);
    if (!user) return c.body(null, 401);

    return c.json({
      token: await signToken(c.env, user.user_id, user.email),
      refreshToken: rotated.refreshToken,
    });
  })

  /**
   * End this device's session. 204 whatever happens: a client that is signing
   * out has already discarded its tokens locally, and an error it cannot act on
   * would only strand it on a "could not sign out" dialog.
   */
  .post("/logout", async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (parsed.success) await revokeRefreshToken(c.env, parsed.data.refreshToken);
    return c.body(null, 204);
  })

  .get("/me", requireAuth, async (c) => {
    const user = await q.getUserById(c.env, c.get("userId"));
    if (!user) return c.text("User does not exist", 404);
    return c.json({
      // The app uses this as its OneSignal external_id, so pushes can be
      // addressed by user rather than by device token.
      userId: user.user_id,
      email: user.email,
      latitude: user.latitude,
      longitude: user.longitude,
      hasLocation: user.region_id !== null,
      regionName: user.region_name,
      streetName: user.street_name,
      emailVerified: user.email_verified_at !== null,
      createdOnUTC: user.created_on_utc,
      updatedOnUTC: user.updated_on_utc,
    });
  })

  // ── Email verification & password reset ──────────────────────────────────

  /**
   * Re-send the verification link. Always 204: whether the address is already
   * verified is not something a caller needs to learn from the status code
   * (they can read it from GET /me), and a no-op reply keeps this useless as a
   * probe.
   */
  .post("/verify/resend", requireAuth, async (c) => {
    const userId = c.get("userId");
    if (await isOverLimit(c.env.RL_EMAIL_ADDR, userId, "RL_EMAIL_ADDR"))
      return tooManyRequests(60);

    const user = await q.getUserById(c.env, userId);
    if (user && user.email_verified_at === null) {
      const token = await issueToken(c.env, userId, "verify_email", VERIFY_TTL_MINUTES);
      const link = `${publicOrigin(c.env, c.req.url)}/api/auth/verify?token=${token}`;
      c.executionCtx.waitUntil(sendMail(c.env, verificationMail(user.email, link)));
    }
    return c.body(null, 204);
  })

  /**
   * Land the mailed verification link. Redeems on GET, unlike the reset flow:
   * if a mail scanner prefetches this, the account simply ends up verified —
   * which is the intended outcome — whereas prefetching a reset link would burn
   * it before the user ever saw the form.
   */
  .get("/verify", async (c) => {
    const token = c.req.query("token");
    const userId = token ? await consumeToken(c.env, token, "verify_email") : null;

    if (!userId) {
      return c.html(resultPage(
        "Връзката е невалидна или изтекла.",
        "This link is invalid or has expired.",
        false,
        "Ако имейлът ви още не е потвърден, поискайте нова връзка от приложението (Профил).",
        "If your email is still unconfirmed, request a new link from the app (Profile).",
      ), 400);
    }

    await q.markEmailVerified(c.env, userId);
    return c.html(resultPage(
      "Имейлът ви е потвърден. Можете да се върнете в приложението.",
      "Your email is confirmed. You can return to the app.",
      true,
    ));
  })

  /**
   * Start a password reset. Always 204, regardless of whether the address
   * exists — the 409 on /register already tells an attacker which addresses are
   * taken, and there is no reason to hand them a second, unthrottled oracle.
   */
  .post("/password/forgot", async (c) => {
    const ip = clientIp(c.req.raw.headers);
    if (await isOverLimit(c.env.RL_EMAIL_IP, ip, "RL_EMAIL_IP")) return tooManyRequests(60);

    const parsed = forgotSchema.safeParse(await c.req.json().catch(() => null));
    // Even a malformed body gets the neutral answer.
    if (!parsed.success) return c.body(null, 204);
    const { email } = parsed.data;

    if (await isOverLimit(c.env.RL_EMAIL_ADDR, email.toLowerCase(), "RL_EMAIL_ADDR"))
      return tooManyRequests(60);

    const user = await q.getUserByEmail(c.env, email);
    if (user) {
      const token = await issueToken(c.env, user.user_id, "reset_password", RESET_TTL_MINUTES);
      const link = `${publicOrigin(c.env, c.req.url)}/api/auth/password/reset?token=${token}`;
      c.executionCtx.waitUntil(sendMail(c.env, passwordResetMail(user.email, link)));
    }
    return c.body(null, 204);
  })

  /** The form the reset link opens. Renders only — nothing is consumed here. */
  .get("/password/reset", (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.html(resultPage(
        "Връзката е невалидна.", "This link is invalid.", false), 400);
    }
    return c.html(resetFormPage(token));
  })

  /**
   * Complete the reset. Form-encoded because it is posted by the page above,
   * not by the app — the app only ever calls /password/forgot.
   */
  .post("/password/reset", async (c) => {
    const ip = clientIp(c.req.raw.headers);
    if (await isOverLimit(c.env.RL_EMAIL_IP, ip, "RL_EMAIL_IP")) return tooManyRequests(60);

    const form = await c.req.parseBody().catch(() => null);
    const token = typeof form?.token === "string" ? form.token : "";
    const password = typeof form?.password === "string" ? form.password : "";
    const confirm = typeof form?.confirm === "string" ? form.confirm : "";

    if (!token) {
      return c.html(resultPage("Връзката е невалидна.", "This link is invalid.", false), 400);
    }
    if (!newPasswordSchema.safeParse(password).success) {
      return c.html(resetFormPage(token,
        "Паролата трябва да е между 8 и 50 знака.",
        "The password must be between 8 and 50 characters."), 400);
    }
    if (password !== confirm) {
      return c.html(resetFormPage(token,
        "Паролите не съвпадат.", "The passwords do not match."), 400);
    }

    // Redeemed last, so a rejected form can be corrected without a new email.
    const userId = await consumeToken(c.env, token, "reset_password");
    if (!userId) {
      return c.html(resultPage(
        "Връзката е невалидна, използвана или изтекла.",
        "This link is invalid, already used, or expired.",
        false,
        "Поискайте нова от екрана за вход.",
        "Request a new one from the sign-in screen.",
      ), 400);
    }

    await q.updateUserPassword(c.env, userId, await hashPassword(password));
    // Receiving the mail proves control of the address, so this doubles as
    // verification for accounts that never clicked the signup link.
    await q.markEmailVerified(c.env, userId);
    // Sign every device out. Someone resetting a password may be evicting
    // whoever got in, and a 60-day refresh token would otherwise outlive the
    // password it was issued against. Access tokens already in flight still
    // work until they expire — that hour is the bound we cannot revoke.
    await revokeAllRefreshTokens(c.env, userId);

    return c.html(resultPage(
      "Паролата е сменена. Влезте в приложението с новата парола.",
      "Your password has been changed. Sign in to the app with the new one.",
      true,
      "Другите устройства са отписани.",
      "Other devices have been signed out.",
    ));
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

    // No device section: push delivery moved to OneSignal, which holds the
    // device registrations keyed by this user_id (see COMPLIANCE.md).
    return c.json({
      profile: {
        userId: user.user_id,
        email: user.email,
        emailVerified: user.email_verified_at !== null,
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
