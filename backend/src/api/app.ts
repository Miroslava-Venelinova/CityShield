import { Hono } from "hono";
import { assertConfig } from "../env";
import { alertRoutes } from "./alerts";
import { authRoutes } from "./auth";
import type { AppEnv } from "./middleware";
import { preferenceRoutes } from "./preferences";
import { privacyRoutes } from "./privacy";
import { globalRateLimit } from "./rate-limit";

export const app = new Hono<AppEnv>();

// Lazy startup guard: refuse to serve on missing/weak secrets (PLAN.MD §1.4).
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
app.route("/privacy", privacyRoutes);

// Uniform 500 without stack traces — parity with the production exception
// handler in Program.cs.
app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.method} ${c.req.path}: ${err}`);
  return c.json({ error: "An unexpected error occurred." }, 500);
});
