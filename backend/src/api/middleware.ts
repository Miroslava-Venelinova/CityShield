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

/**
 * Compare two secrets without leaking where they diverge.
 *
 * `===` on strings returns as soon as it finds a differing byte, so the reply
 * time carries how much of the key was right — enough, given a quiet path and
 * many samples, to recover it one character at a time. The length check ahead
 * of the comparison leaks the key's length, which is not a secret and is what
 * `timingSafeEqual` requires anyway (it throws on unequal sizes).
 */
function secretsMatch(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left as BufferSource, right as BufferSource);
}

/** X-Api-Key gate for machine-to-machine ingest endpoints (used from Phase 2). */
export const requireIngestKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("X-Api-Key");
  if (!key || !secretsMatch(key, c.env.INGEST_API_KEY)) return c.body(null, 401);
  await next();
};
