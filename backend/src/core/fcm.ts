// FCM HTTP v1 without firebase-admin (PLAN.MD §1.6): mint an OAuth2 access
// token by RS256-signing a JWT with the service account's private key
// (WebCrypto), then send one request per device token. Stale tokens
// (UNREGISTERED / SENDER_ID_MISMATCH — the same "definitively dead" codes
// FirebaseMessenger.cs used) are deleted from device_tokens.

import type { Env } from "../env";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

// Every hop here is a network call with no natural bound; without these an
// unresponsive Google endpoint holds the invocation open until workerd kills
// it, taking the stale-token cleanup down with it.
const TOKEN_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;
const CHAIN_TIMEOUT_MS = 20_000;

// ── OAuth2 access token (cached in module scope until ~5 min before expiry) ──

let cachedToken: { value: string; expiresAt: number } | null = null;
// In-flight mint, so a burst of pushes on a cold isolate performs one token
// exchange instead of one per caller.
let pendingToken: Promise<string> | null = null;

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const b64url = (data: string | Uint8Array): string => {
  const bin = typeof data === "string"
    ? data
    : String.fromCharCode(...data);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return Promise.resolve(cachedToken.value);
  if (pendingToken) return pendingToken;
  pendingToken = mintAccessToken(env).finally(() => { pendingToken = null; });
  return pendingToken;
}

async function mintAccessToken(env: Env): Promise<string> {
  if (!env.FCM_SERVICE_ACCOUNT) throw new Error("FCM_SERVICE_ACCOUNT secret is not set");
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${b64url(signature)}`,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 300) * 1000,
  };
  return body.access_token;
}

/** Test hook. */
export function clearFcmTokenCache(): void {
  cachedToken = null;
  pendingToken = null;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export interface PushNotification {
  title: string;
  body: string;
  data: Record<string, string>; // FCM data values must all be strings
}

// An ingest invocation also spends subrequests on scraping/Overpass/Nominatim;
// keep FCM fan-out per invocation bounded and chain the rest (§1.6).
const MAX_INLINE_SENDS = 30;

function isTokenInvalid(status: number, body: string): boolean {
  // Only codes that definitively mean "this token is dead" — INVALID_ARGUMENT
  // is deliberately excluded (also returned for message-level problems).
  if (status === 404) return true; // NOT_FOUND → UNREGISTERED
  return /"errorCode"\s*:\s*"(UNREGISTERED|SENDER_ID_MISMATCH)"/.test(body)
    || (status === 403 && body.includes("SENDER_ID_MISMATCH"));
}

/**
 * Never rejects: one device's network failure must not discard the outcomes of
 * the other 29 sends in the batch (and with them the stale-token cleanup).
 */
async function sendOne(
  accessToken: string, projectId: string,
  token: string, notification: PushNotification,
): Promise<{ ok: boolean; stale: boolean }> {
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: notification.title, body: notification.body },
          data: notification.data,
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, stale: false };
    const body = await res.text();
    return { ok: false, stale: isTokenInvalid(res.status, body) };
  } catch (e) {
    // Transport failure or timeout — retriable in principle, but the token is
    // certainly not provably dead, so never treat it as stale.
    console.warn(`FCM send failed: ${e}`);
    return { ok: false, stale: false };
  }
}

/**
 * Sends the notification to up to MAX_INLINE_SENDS device tokens inline and
 * chains the remainder through the Worker's own /internal/push-batch route
 * (fresh 50-subrequest budget per hop). Deletes definitively-dead tokens.
 * Never throws on per-token failures; throws only on auth/config errors.
 */
export async function sendPushToTokens(
  env: Env, tokens: string[], notification: PushNotification, selfUrl?: string,
): Promise<{ sent: number; failed: number; staleRemoved: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0, staleRemoved: 0 };

  if (!env.FCM_SERVICE_ACCOUNT) {
    // Local dev / test environments without the secret: log and skip rather
    // than failing the caller (notification failure never fails a request).
    console.warn(`FCM_SERVICE_ACCOUNT not set — skipping push to ${tokens.length} token(s)`);
    return { sent: 0, failed: tokens.length, staleRemoved: 0 };
  }

  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  const accessToken = await getAccessToken(env);

  const inline = tokens.slice(0, MAX_INLINE_SENDS);
  const remainder = tokens.slice(MAX_INLINE_SENDS);

  const outcomes = await Promise.all(
    inline.map((t) => sendOne(accessToken, sa.project_id, t, notification)));

  const stale = inline.filter((_, i) => outcomes[i]!.stale);
  if (stale.length > 0) {
    // MAX_INLINE_SENDS is under D1's 100-bound-parameter ceiling, so this
    // never needs chunking — keep the two constants in that relationship.
    const placeholders = stale.map(() => "?").join(", ");
    try {
      await env.DB.prepare(`DELETE FROM device_tokens WHERE token IN (${placeholders})`)
        .bind(...stale).run();
      console.log(`Removed ${stale.length} stale FCM token(s)`);
    } catch (e) {
      // Cleanup is housekeeping; the pushes already went out.
      console.warn(`Stale-token cleanup failed: ${e}`);
    }
  }

  let chained = { sent: 0, failed: 0, staleRemoved: 0 };
  if (remainder.length > 0) {
    if (!selfUrl) {
      console.warn(`No self URL for push-batch chaining — ${remainder.length} token(s) not sent this hop`);
      chained = { sent: 0, failed: remainder.length, staleRemoved: 0 };
    } else {
      // A chain hop is itself a Worker invocation doing up to 30 FCM sends, so
      // it needs a real timeout — and a failure here must degrade to "these
      // devices missed this push", never to a thrown error that would make the
      // caller re-send to the devices already reached.
      try {
        const res = await fetch(`${selfUrl}/internal/push-batch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": env.INGEST_API_KEY,
          },
          body: JSON.stringify({ tokens: remainder, notification }),
          signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
        });
        if (res.ok) {
          chained = (await res.json()) as typeof chained;
        } else {
          console.error(`push-batch chain hop failed: ${res.status}`);
          chained = { sent: 0, failed: remainder.length, staleRemoved: 0 };
        }
      } catch (e) {
        console.error(`push-batch chain hop errored: ${e}`);
        chained = { sent: 0, failed: remainder.length, staleRemoved: 0 };
      }
    }
  }

  const sent = outcomes.filter((o) => o.ok).length;
  return {
    sent: sent + chained.sent,
    failed: inline.length - sent + chained.failed,
    staleRemoved: stale.length + chained.staleRemoved,
  };
}
