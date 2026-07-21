// Single-use links for email verification and password reset (migration 0006).
//
// Threat model, and why each choice is what it is:
//  - The token is 32 bytes from crypto.getRandomValues, base64url-encoded. That
//    is the entire secret in the link, so it must be unguessable rather than
//    merely unique — a UUID would not be.
//  - Only its SHA-256 is stored. Read access to D1 (a backup, a log, an
//    injection) then yields nothing replayable, exactly as with password_hash.
//    Plain SHA-256 is right here where PBKDF2 is right for passwords: the
//    pre-image is already high-entropy, so there is nothing to brute-force.
//  - Redemption is a single conditional UPDATE. Two clicks on the same link
//    race, and only the one whose UPDATE reports a change wins.

import type { Env } from "../env";

export type TokenPurpose = "verify_email" | "reset_password";

/** Verification links are mailed once and may sit in an inbox for a while. */
export const VERIFY_TTL_MINUTES = 24 * 60;
/** Reset links hand over the account, so they expire fast. */
export const RESET_TTL_MINUTES = 60;

const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hex SHA-256. Hex rather than base64 so the PK is trivially greppable in ops. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a link token. Returns the plaintext, which exists only in the outgoing
 * email — it is never stored and cannot be recovered afterwards.
 *
 * Any earlier unredeemed token of the same purpose is dropped, so "resend"
 * means the older link stops working. That is the behaviour users expect and
 * it caps how many live reset links can exist per account at one.
 */
export async function issueToken(
  env: Env, userId: string, purpose: TokenPurpose, ttlMinutes: number,
): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMinutes * 60_000);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?")
      .bind(userId, purpose),
    env.DB.prepare(
      `INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).bind(await hashToken(token), userId, purpose, expires.toISOString(), now.toISOString()),
  ]);

  return token;
}

/**
 * Redeem a token, returning the user it belongs to — or null when it is
 * unknown, expired, of the wrong purpose, or already used.
 *
 * Callers get one bit of information deliberately: every failure mode looks
 * the same, so a probing client learns nothing about which tokens exist.
 */
export async function consumeToken(
  env: Env, token: string, purpose: TokenPurpose,
): Promise<string | null> {
  const hash = await hashToken(token);
  const now = new Date().toISOString();

  // Claim and read in one round trip. `RETURNING` makes the claim atomic: a
  // second concurrent redemption matches no row and gets nothing back.
  const claimed = await env.DB.prepare(
    `UPDATE auth_tokens SET used_at = ?
     WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
     RETURNING user_id`,
  ).bind(now, hash, purpose, now).first<{ user_id: string }>();

  return claimed?.user_id ?? null;
}
