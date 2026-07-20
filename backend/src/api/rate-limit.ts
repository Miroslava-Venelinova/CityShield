// Rate limiting on top of Cloudflare's Rate Limiting binding (PLAN.MD §2.4).
//
// Honest description of the guarantee, because it shapes how the limits are
// picked: counters are local to the Cloudflare location serving the request and
// are documented as "permissive, eventually consistent, and intentionally
// designed to not be used as an accurate accounting system". An attacker
// spread across N locations effectively gets N× each limit. That is still a
// large improvement over the previous per-isolate `Map`, which any isolate
// recycle reset to zero, but it means these limits are an abuse dampener and
// never the only control — password strength rules and PBKDF2 cost still carry
// the real weight for credential attacks.
//
// The binding only supports a `period` of 10 or 60 seconds, so there is no
// escalating-lockout tier here; sustained attacks are shaped, not banned.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import type { AppEnv } from "./middleware";

/**
 * Client IP for keying. `CF-Connecting-IP` is written by Cloudflare's edge and
 * cannot be spoofed by the client, unlike `X-Forwarded-For` — never widen this
 * to trust a client-supplied header.
 *
 * Falls back to a constant off-edge (tests, `wrangler dev`), which collapses
 * every caller into one bucket. That is the safe direction to fail.
 */
export function clientIp(headers: Headers): string {
  return headers.get("CF-Connecting-IP") ?? "local";
}

/**
 * Consume one token. Returns true when the caller is over the limit.
 *
 * Fails **open** when the binding is missing or throws: a rate limiter outage
 * must not take down login for everyone. The tradeoff is deliberate — the
 * blast radius of failing closed here is a full auth outage, whereas failing
 * open degrades to the pre-existing (unlimited) behaviour and is logged.
 */
export async function isOverLimit(
  limiter: RateLimit | undefined,
  key: string,
  name: string,
): Promise<boolean> {
  if (!limiter) {
    console.warn(`Rate limiter ${name} is not bound — request allowed unthrottled.`);
    return false;
  }
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch (err) {
    console.error(`Rate limiter ${name} failed, allowing request: ${err}`);
    return false;
  }
}

/** 429 body shape. Text, matching the plain-text error style of /api/auth/*. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response("Too many requests. Please try again shortly.", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      // Advisory only — the binding does not report when the window resets, so
      // this is the configured period, not a computed remaining time.
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * Blanket per-IP backstop, mounted app-wide. Sized well above real app usage
 * (a session refresh is a handful of calls) so it only catches scripted abuse;
 * the per-route limiters below it do the precise work.
 */
export const globalRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c.req.raw.headers);
  if (await isOverLimit(c.env.RL_API_IP, ip, "RL_API_IP")) return tooManyRequests(60);
  await next();
};

/** Per-user limiter for routes whose cost is an outbound third-party call. */
export function perUserRateLimit(
  pick: (env: Env) => RateLimit | undefined,
  name: string,
  period: number,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (await isOverLimit(pick(c.env), c.get("userId"), name)) return tooManyRequests(period);
    await next();
  };
}
