import { Hono } from "hono";
import { assertConfig } from "../env";
import { alertRoutes, internalRoutes } from "./alerts";
import { authRoutes } from "./auth";
import type { AppEnv } from "./middleware";
import { preferenceRoutes } from "./preferences";
import { privacyRoutes } from "./privacy";
import { globalRateLimit } from "./rate-limit";
import { tokenRoutes } from "./tokens";

export const app = new Hono<AppEnv>();

// Lazy startup guard: refuse to serve on missing/weak secrets (PLAN.MD §1.4).
app.use(async (c, next) => {
  assertConfig(c.env);
  await next();
});

// Per-IP backstop on the public API. Mounted under /api only: /internal is the
// push-batch self-chaining route (§1.6), which legitimately bursts far above
// any human rate and is already gated by INGEST_API_KEY.
app.use("/api/*", globalRateLimit);

app.route("/api/auth", authRoutes);
app.route("/api/alerts", alertRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api/preferences", preferenceRoutes);
app.route("/internal", internalRoutes);
app.route("/privacy", privacyRoutes);

// Uniform 500 without stack traces — parity with the production exception
// handler in Program.cs.
app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.method} ${c.req.path}: ${err}`);
  return c.json({ error: "An unexpected error occurred." }, 500);
});
