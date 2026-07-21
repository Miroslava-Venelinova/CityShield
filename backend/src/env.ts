export interface Env {
  DB: D1Database;
  AI: Ai;

  // Rate limiters (wrangler.jsonc `ratelimits`). Optional in the type because a
  // stale deploy or a miniflare setup without the binding must not 500 every
  // request — `enforceLimit` degrades to allow-and-warn, see api/rate-limit.ts.
  RL_LOGIN_IP?: RateLimit;
  RL_LOGIN_EMAIL?: RateLimit;
  /** Session renewal (/api/auth/refresh) — separate from login, see wrangler.jsonc. */
  RL_REFRESH_IP?: RateLimit;
  RL_REGISTER_IP?: RateLimit;
  RL_GEOCODE_USER?: RateLimit;
  RL_API_IP?: RateLimit;
  /** Mail-sending routes, keyed per IP and per address (see api/auth.ts). */
  RL_EMAIL_IP?: RateLimit;
  RL_EMAIL_ADDR?: RateLimit;

  // vars (wrangler.jsonc)
  AI_MODEL: string;
  VIK_URL: string;
  VT_URL: string;
  EPRO_URL: string;
  EPRO_AREA_NAME: string;
  HEATING_BASE_URL: string;
  HEATING_URL: string;
  OVERPASS_URL: string;
  NOMINATIM_URL: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  JWT_EXPIRE_MINUTES: string;
  /** Public origin of this Worker, used to build verification/reset links from cron, which has no request to derive one from. */
  SELF_URL?: string;
  /** OneSignal app the pushes are sent from. Not a secret (it ships in the mobile app too). */
  ONESIGNAL_APP_ID?: string;

  // secrets
  JWT_KEY: string;
  INGEST_API_KEY: string;
  /** OneSignal REST API key. Optional: missing push config degrades to a warning, never a 500. */
  ONESIGNAL_API_KEY?: string;
  // NOTE: mail delivery is mocked (core/mailer.ts) — no provider credentials
  // yet, by decision. Whatever provider we settle on adds its key here.
}

/**
 * Deploy-time startup guards become lazy first-request checks in a Worker
 * (PLAN.MD §1.4): refuse to serve if secrets are missing or weak.
 */
export function assertConfig(env: Env): void {
  if (!env.JWT_KEY || env.JWT_KEY.length < 32)
    throw new Error("JWT_KEY is unset or too short (need ≥32 chars; use `wrangler secret put JWT_KEY`)");
  if (!env.INGEST_API_KEY)
    throw new Error("INGEST_API_KEY is unset — ingest endpoints would be unauthenticated");
}
