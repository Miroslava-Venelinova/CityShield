import { Hono } from "hono";
import { assertConfig } from "../env";
import { alertRoutes } from "./alerts";
import { authRoutes } from "./auth";
import { healthRoutes } from "./health";
import { requireIngestKey, type AppEnv } from "./middleware";
import { preferenceRoutes } from "./preferences";
import { privacyRoutes } from "./privacy";
import { globalRateLimit } from "./rate-limit";

export const app = new Hono<AppEnv>();

/**
 * Response headers set on everything this Worker serves.
 *
 * Most of the surface is JSON for a native app, where none of these do
 * anything — they are here for the handful of routes a *browser* actually
 * renders: the privacy policy, and the verification/reset pages a mailed link
 * opens (api/auth-pages.ts).
 *
 * The CSP is as tight as it is because those pages need almost nothing: no
 * scripts at all, no images, no fonts, no outbound connections. `default-src
 * 'none'` denies the lot, and `style-src 'unsafe-inline'` re-admits only the
 * one thing they do use — their own <style> block. Should a future edit ever
 * introduce an injectable value into that HTML, the damage it can do is already
 * bounded.
 *
 * `Referrer-Policy: no-referrer` is the load-bearing one. A password-reset link
 * carries its token in the query string, so any request the page makes off-site
 * would carry the token in `Referer`. Today it makes none — this keeps that
 * true regardless of what the page grows into.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
    + "base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // workers.dev is HTTPS-only, so this can never lock out a working URL.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

app.use(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    c.res.headers.set(name, value);
  // Default to no-store — this is an auth API, and both the reset page and the
  // token in its URL are things no cache should keep. Routes that deliberately
  // want caching set their own value first and keep it; /api/alerts/recent is
  // the only one, and its payload is public city data by design.
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

// Lazy startup guard: refuse to serve on missing/weak secrets (SPEC.md §1.4).
app.use(async (c, next) => {
  assertConfig(c.env);
  await next();
});

// Per-IP backstop on the public API. Mounted under /api only, so the static
// /privacy pages stay reachable even from an IP that has spent its API budget.
app.use("/api/*", globalRateLimit);

app.route("/api/auth", authRoutes);
app.route("/api/alerts", alertRoutes);
app.route("/api/preferences", preferenceRoutes);
// Operational health (SPEC.md §3.8). Behind the ingest key rather than public:
// it reports cursors, tick outcomes and the ids of messages deliberately not
// delivered — nothing personal, but nothing the public needs either. A header
// is all an external uptime ping needs, so this still meets the goal of being
// checkable without wrangler.
app.use("/api/health", requireIngestKey);
app.route("/api/health", healthRoutes);

app.route("/privacy", privacyRoutes);

// Uniform 500 without stack traces — parity with the production exception
// handler in Program.cs.
app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.method} ${c.req.path}: ${err}`);
  return c.json({ error: "An unexpected error occurred." }, 500);
});
