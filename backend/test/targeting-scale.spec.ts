// Targeting at a scale past D1's limits.
//
// D1 rejects any statement with more than 100 bound parameters, so every
// `WHERE user_id IN (…)` on the notification path breaks the moment an alert
// targets more than 100 users — precisely the city-wide broadcast case, and
// only once the pilot grows. These tests pin the audience above that ceiling.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getBusLineSubscriptions, getDisabledUserIds, getUserIdsByStreets,
} from "../src/db/queries";

/** Comfortably past D1's 100-bound-parameter ceiling. */
const USER_COUNT = 250;

let userIds: string[] = [];

beforeEach(async () => {
  const now = new Date().toISOString();
  userIds = Array.from({ length: USER_COUNT }, () => crypto.randomUUID());

  // D1 batches are cheaper than 250 round trips and keep the suite quick.
  await env.DB.batch(userIds.map((id, i) =>
    env.DB.prepare(
      `INSERT INTO users (user_id, email, password_hash, subscribed_bus_lines,
                          created_on_utc, updated_on_utc)
       VALUES (?, ?, 'x', ?, ?, ?)`,
    ).bind(id, `scale-${i}-${id}@example.com`, "[]", now, now)));
});

describe("targeting queries past D1's bound-parameter ceiling", () => {
  it("finds category opt-outs within a large audience", async () => {
    const optedOut = userIds.slice(0, 3);
    const now = new Date().toISOString();
    await env.DB.batch(optedOut.map((id) =>
      env.DB.prepare(
        `INSERT INTO user_notification_preferences (user_id, category, is_enabled, updated_at)
         VALUES (?, 'vik', 0, ?)`,
      ).bind(id, now)));

    const disabled = await getDisabledUserIds(env, userIds, "vik");
    expect(disabled.sort()).toEqual([...optedOut].sort());
  });

  it("ignores opt-outs belonging to users outside the audience", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO user_notification_preferences (user_id, category, is_enabled, updated_at)
       VALUES (?, 'vik', 0, ?)`,
    ).bind(userIds[0], now).run();

    expect(await getDisabledUserIds(env, userIds.slice(10), "vik")).toEqual([]);
  });

  it("returns bus-line subscribers within a large audience, and only them", async () => {
    await env.DB.prepare("UPDATE users SET subscribed_bus_lines = ? WHERE user_id = ?")
      .bind(JSON.stringify(["9", "409"]), userIds[7]!).run();

    const subs = await getBusLineSubscriptions(env, userIds);
    // Users with an empty list are "no filter" and are deliberately not returned.
    expect(subs).toHaveLength(1);
    expect(subs[0]!.user_id).toBe(userIds[7]);
  });

  it("matches users across more than 100 streets in one call", async () => {
    // The street list itself can exceed the ceiling, so this path chunks.
    const streetIds: number[] = [];
    for (let i = 0; i < 120; i++) {
      const { meta } = await env.DB.prepare("INSERT INTO streets (street_name) VALUES (?)")
        .bind(`Улица ${i}`).run();
      streetIds.push(meta.last_row_id);
    }
    await env.DB.prepare("UPDATE users SET street_id = ? WHERE user_id = ?")
      .bind(streetIds[0]!, userIds[0]!).run();
    await env.DB.prepare("UPDATE users SET street_id = ? WHERE user_id = ?")
      .bind(streetIds[119]!, userIds[1]!).run();

    const matched = await getUserIdsByStreets(env, streetIds, null);
    expect(matched.sort()).toEqual([userIds[0], userIds[1]].sort());
  });
});
