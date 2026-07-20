import type { MiddlewareHandler } from "hono";
import { verifyToken } from "../core/jwt";
import type { Env } from "../env";

export interface AuthVariables {
  userId: string;
  userEmail: string;
}

export type AppEnv = { Bindings: Env; Variables: AuthVariables };

/**
 * JWT bearer auth. Parity with ASP.NET JwtBearer: 401 with empty body on
 * missing/invalid/expired token (the app only checks `response.ok`).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return c.body(null, 401);
  const claims = await verifyToken(c.env, header.slice("Bearer ".length));
  if (!claims) return c.body(null, 401);
  c.set("userId", claims.sub);
  c.set("userEmail", claims.email);
  await next();
};

/** X-Api-Key gate for machine-to-machine ingest endpoints (used from Phase 2). */
export const requireIngestKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("X-Api-Key");
  if (!key || key !== c.env.INGEST_API_KEY) return c.body(null, 401);
  await next();
};
