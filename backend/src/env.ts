export interface Env {
  DB: D1Database;
  AI: Ai;

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
  /** Public origin of this Worker (for push-batch self-chaining from cron); optional — fetch handlers derive it from the request. */
  SELF_URL?: string;

  // secrets
  JWT_KEY: string;
  INGEST_API_KEY: string;
  FCM_SERVICE_ACCOUNT?: string;
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
