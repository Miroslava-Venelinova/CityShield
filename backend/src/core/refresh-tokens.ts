// Rotating refresh tokens — the thing that keeps a signed-in app signed in
// (migration 0007).
//
// The access token is a 60-minute HS256 JWT. Before this existed, that was the
// whole session: an hour after signing in every request 401'd, the app had no
// way to notice, and it looked like the device had gone offline until the user
// reinstalled. The JWT lifetime is not the problem to fix — it is short on
// purpose, because nothing can revoke one — so the session moves into a row we
// control and the app trades it for a fresh JWT.
//
// Shape, and why:
//  - Same secret handling as auth-tokens.ts: 32 random bytes, only the SHA-256
//    is stored. A refresh token is a bearer credential for the account, so a
//    leaked database must not yield replayable ones.
//  - Rotation on every use. A refresh token is spent when redeemed, and the
//    reply carries its replacement. Long-lived *and* static would mean a token
//    lifted off a device works for two months undetected.
//  - Sliding expiry: each rotation gets a fresh 90 days. A user who opens the
//    app inside that window is never signed out; one who abandons it is.
//  - Reuse of an already-rotated token means two parties hold the chain — the
//    legitimate device and a thief. There is no way to tell which is calling,
//    so the family dies and that device signs in again.

import type { Env } from "../env";
import { hashToken } from "./auth-tokens";

/**
 * How long a session survives without the app being opened. Long, because the
 * cost of getting this wrong is a user who thinks the app is broken; the short
 * window that actually bounds damage is the access token's.
 *
 * 90 days suits how this app is actually used: an outage notifier is something
 * you install and then do not open until something breaks, and a quiet quarter
 * is normal rather than a sign of abandonment. What keeps the longer window from
 * widening the exposure is that the token is single-use — rotation means a
 * stolen one works until the real device next refreshes and trips the replay
 * check, which is a property of the chain, not of its expiry date.
 */
export const REFRESH_TTL_DAYS = 90;

const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function insert(
  env: Env, userId: string, familyId: string,
): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const now = new Date();
  const expires = new Date(now.getTime() + REFRESH_TTL_DAYS * 24 * 3600_000);

  await env.DB.prepare(
    `INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).bind(await hashToken(token), userId, familyId, expires.toISOString(), now.toISOString()).run();

  return token;
}

/**
 * Open a new session — one per sign-in, i.e. one per device. Returns the
 * plaintext token, which is never stored and cannot be recovered afterwards.
 */
export function issueRefreshToken(env: Env, userId: string): Promise<string> {
  return insert(env, userId, crypto.randomUUID());
}

export interface Rotation {
  userId: string;
  refreshToken: string;
}

/**
 * Spend a refresh token and return its replacement, or null when it is unknown,
 * expired, or already spent.
 *
 * Callers get one bit, as with consumeToken: every failure looks alike, so a
 * probing client learns nothing about which tokens exist.
 */
export async function rotateRefreshToken(env: Env, token: string): Promise<Rotation | null> {
  const hash = await hashToken(token);
  const now = new Date().toISOString();

  // Claim and read in one round trip. Two concurrent refreshes from the same
  // device — easy to trigger, since a screen that fans out three API calls
  // 401s three times at once — race here, and exactly one wins. The loser gets
  // null and retries with the token the winner stored, rather than both
  // rotating and leaving one of them holding a spent token.
  const claimed = await env.DB.prepare(
    `UPDATE refresh_tokens SET used_at = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING user_id, family_id`,
  ).bind(now, hash, now).first<{ user_id: string; family_id: string }>();

  if (!claimed) {
    await revokeIfReplayed(env, hash);
    return null;
  }

  return {
    userId: claimed.user_id,
    refreshToken: await insert(env, claimed.user_id, claimed.family_id),
  };
}

/**
 * A token that exists but could not be claimed was already rotated (or is a
 * relic past its expiry). The first case means the chain leaked: kill the
 * family, so whoever holds it — thief or victim — has to sign in with a
 * password.
 *
 * Deliberately narrow: it drops one device's chain, not the account's other
 * sessions, so a single stale replay cannot be used to log a user out
 * everywhere.
 */
async function revokeIfReplayed(env: Env, hash: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT family_id FROM refresh_tokens WHERE token_hash = ? AND used_at IS NOT NULL",
  ).bind(hash).first<{ family_id: string }>();
  if (!row) return;

  console.warn("Refresh token replayed — revoking the device's session family.");
  await env.DB.prepare("DELETE FROM refresh_tokens WHERE family_id = ?").bind(row.family_id).run();
}

/** Sign out one device. Unknown tokens are a no-op — logout never errors. */
export async function revokeRefreshToken(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM refresh_tokens WHERE token_hash = ?")
    .bind(await hashToken(token)).run();
}

/**
 * Sign out every device. Used after a password reset: whoever changed the
 * password may be locking someone else out on purpose, and leaving live
 * sessions behind would defeat that.
 */
export async function revokeAllRefreshTokens(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").bind(userId).run();
}
