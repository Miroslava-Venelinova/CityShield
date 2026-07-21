// Push delivery via OneSignal (replaces the FCM HTTP v1 client).
//
// Why: FCM v1 has no multicast endpoint, so the old core/fcm.ts spent one
// external subrequest per *device* and chained self-invocations to get past the
// 50-subrequest ceiling — fan-out cost grew with the device count. OneSignal
// takes a list of users per call and does the per-device fan-out on its own
// infrastructure, so the Worker's cost grows with ceil(users / 2000) instead.
//
// Targeting stays entirely ours (see alert-service.ts): OneSignal never learns
// who lives where, it only receives the user ids we already decided to notify.

import type { Env } from "../env";

const API_URL = "https://api.onesignal.com/notifications";

// A send is a network call with no natural bound; without this an unresponsive
// endpoint holds the invocation open until workerd kills it.
const SEND_TIMEOUT_MS = 10_000;

// OneSignal's docs advertise up to 20,000 aliases per request, but the
// documented per-call limit for include_aliases is 2,000 — take the smaller
// bound. At 2,000 the free tier's 50 subrequests still cover 100,000 users in a
// single invocation, which is far past anything this app will target.
const MAX_ALIASES_PER_REQUEST = 2_000;

export interface PushNotification {
  title: string;
  body: string;
  /** All values are strings, matching what the app's push handler reads. */
  data: Record<string, string>;
}

/** 200 responses still report per-alias problems in `errors`. */
interface CreateNotificationResponse {
  id?: string;
  recipients?: number;
  errors?: unknown;
}

/**
 * Never rejects: one chunk's network failure must not discard the outcomes of
 * the other chunks. Returns how many users that chunk reached.
 */
async function sendChunk(
  env: Env, userIds: string[], notification: PushNotification,
): Promise<number> {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.ONESIGNAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: env.ONESIGNAL_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: userIds },
        headings: { en: notification.title },
        contents: { en: notification.body },
        data: notification.data,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`OneSignal send failed: ${res.status} ${await res.text()}`);
      return 0;
    }

    const body = (await res.json()) as CreateNotificationResponse;
    // A 200 with `errors` means some aliases were unknown (never registered, or
    // logged out on every device). That is normal churn, not a fault: OneSignal
    // drops those subscriptions itself, which is why there is no stale-token
    // bookkeeping left on our side.
    if (body.errors) console.warn(`OneSignal reported alias errors: ${JSON.stringify(body.errors)}`);

    // `recipients` counts devices, which is what actually got reached; fall back
    // to the chunk size when the field is absent rather than reporting zero.
    return body.recipients ?? userIds.length;
  } catch (e) {
    console.warn(`OneSignal send errored: ${e}`);
    return 0;
  }
}

/**
 * Sends one notification to the given users, addressed by `external_id` — which
 * is the app's own `user_id`, set client-side via `OneSignal.login()`.
 *
 * Never throws: a notification failure must never fail the caller's request
 * (the alert is already stored by then).
 */
export async function sendPushToUsers(
  env: Env, userIds: string[], notification: PushNotification,
): Promise<{ sent: number; failed: number }> {
  if (userIds.length === 0) return { sent: 0, failed: 0 };

  if (!env.ONESIGNAL_API_KEY || !env.ONESIGNAL_APP_ID) {
    // Local dev / tests without credentials: log and skip rather than failing.
    console.warn(
      `ONESIGNAL_API_KEY/ONESIGNAL_APP_ID not set — skipping push to ${userIds.length} user(s)`);
    return { sent: 0, failed: userIds.length };
  }

  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += MAX_ALIASES_PER_REQUEST)
    chunks.push(userIds.slice(i, i + MAX_ALIASES_PER_REQUEST));

  const counts = await Promise.all(chunks.map((c) => sendChunk(env, c, notification)));
  const sent = counts.reduce((a, b) => a + b, 0);

  // `sent` counts devices and `userIds` counts users, so a user with two phones
  // can push `sent` above the user count — clamp so `failed` never goes negative.
  return { sent, failed: Math.max(0, userIds.length - sent) };
}
