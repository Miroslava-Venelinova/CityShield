// HS256 JWT helpers (SPEC.md §1.4). The app treats the token as opaque, so
// standard `sub`/`email` claims replace the .NET URI-style claim names.

import { sign, verify } from "hono/jwt";
import type { Env } from "../env";

export interface TokenClaims {
  sub: string;   // user id (uuid)
  email: string;
}

export async function signToken(env: Env, userId: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expireMinutes = Number(env.JWT_EXPIRE_MINUTES) || 60;
  return sign(
    {
      sub: userId,
      email,
      iss: env.JWT_ISSUER,
      aud: env.JWT_AUDIENCE,
      iat: now,
      exp: now + expireMinutes * 60,
    },
    env.JWT_KEY,
    "HS256",
  );
}

/** Returns the claims, or null on any validation failure (bad signature, expired, wrong iss/aud). */
export async function verifyToken(env: Env, token: string): Promise<TokenClaims | null> {
  try {
    const payload = await verify(token, env.JWT_KEY, "HS256");
    if (payload.iss !== env.JWT_ISSUER || payload.aud !== env.JWT_AUDIENCE) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
