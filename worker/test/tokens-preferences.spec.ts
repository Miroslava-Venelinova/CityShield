// Contract tests for /api/tokens and /api/preferences/* + the FK-cascade
// guarantee GDPR deletion relies on (PLAN.MD §1.2 note).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, jsonInit, registerAndLogin } from "./helpers";

describe("/api/tokens", () => {
  it("401s without auth", async () => {
    expect((await api("/api/tokens", jsonInit("POST", { token: "t" }))).status).toBe(401);
  });

  it("upserts on POST and removes on DELETE (204s)", async () => {
    const { token } = await registerAndLogin();

    const post = await api("/api/tokens",
      jsonInit("POST", { token: "fcm-abc", platform: "android", deviceName: "Pixel" }, token));
    expect(post.status).toBe(204);

    // Re-registering the same device token must not duplicate the row.
    await api("/api/tokens", jsonInit("POST", { token: "fcm-abc" }, token));
    const rows = await env.DB.prepare("SELECT platform, device_name FROM device_tokens WHERE token = 'fcm-abc'").all();
    expect(rows.results).toHaveLength(1);
    // platform/deviceName survive an upsert that omits them
    expect(rows.results[0]).toEqual({ platform: "android", device_name: "Pixel" });

    const del = await api("/api/tokens", jsonInit("DELETE", { token: "fcm-abc" }, token));
    expect(del.status).toBe(204);
    const after = await env.DB.prepare("SELECT 1 FROM device_tokens WHERE token = 'fcm-abc'").all();
    expect(after.results).toHaveLength(0);
  });

  it("rejects a missing token field with 400", async () => {
    const { token } = await registerAndLogin();
    expect((await api("/api/tokens", jsonInit("POST", {}, token))).status).toBe(400);
  });
});

describe("/api/preferences", () => {
  it("returns all 5 categories, enabled by default, in catalog order", async () => {
    const { token } = await registerAndLogin();
    const res = await api("/api/preferences", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const prefs = await res.json() as Array<{ category: string; label: string; isEnabled: boolean }>;
    expect(prefs.map((p) => p.category)).toEqual(["vik", "vt", "epro", "heating", "roads"]);
    expect(prefs.every((p) => p.isEnabled)).toBe(true);
    expect(prefs[0]).toEqual({ category: "vik", label: "Water (ВиК)", isEnabled: true });
  });

  it("PUT /{category} persists and unknown category 400s with the exact text", async () => {
    const { token } = await registerAndLogin();

    const put = await api("/api/preferences/vik", jsonInit("PUT", { isEnabled: false }, token));
    expect(put.status).toBe(204);

    const res = await api("/api/preferences", { headers: { Authorization: `Bearer ${token}` } });
    const prefs = await res.json() as Array<{ category: string; isEnabled: boolean }>;
    expect(prefs.find((p) => p.category === "vik")?.isEnabled).toBe(false);
    expect(prefs.find((p) => p.category === "vt")?.isEnabled).toBe(true);

    const bad = await api("/api/preferences/foo", jsonInit("PUT", { isEnabled: true }, token));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("Unknown category: foo");
  });

  it("bus-lines: returns catalog + selection, normalizes Cyrillic and the 0 sentinel", async () => {
    const { token } = await registerAndLogin();

    const initial = await api("/api/preferences/bus-lines", { headers: { Authorization: `Bearer ${token}` } });
    const dto = await initial.json() as { available: string[]; selected: string[] };
    expect(dto.available).toContain("209B");
    expect(dto.available).toHaveLength(38);
    expect(dto.selected).toEqual([]);

    // "31а"/"209Б" use Cyrillic suffixes; "0" is the drop sentinel.
    const put = await api("/api/preferences/bus-lines",
      jsonInit("PUT", { busLines: ["31а", "209Б", "0", " 17a "] }, token));
    expect(put.status).toBe(204);

    const after = await api("/api/preferences/bus-lines", { headers: { Authorization: `Bearer ${token}` } });
    const dto2 = await after.json() as { selected: string[] };
    expect(dto2.selected).toEqual(["31A", "209B", "17A"]);
  });

  it("bus-lines: unknown line 400s with the exact text", async () => {
    const { token } = await registerAndLogin();
    const res = await api("/api/preferences/bus-lines", jsonInit("PUT", { busLines: ["999"] }, token));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Unknown bus line(s): 999");
  });
});

describe("FK cascade (GDPR deletion relies on it)", () => {
  it("deleting a user removes their tokens and preferences", async () => {
    const { token, email } = await registerAndLogin();
    await api("/api/tokens", jsonInit("POST", { token: "cascade-tok" }, token));
    await api("/api/preferences/vik", jsonInit("PUT", { isEnabled: false }, token));

    const user = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?")
      .bind(email).first<{ user_id: string }>();
    await env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email).run();

    const tokens = await env.DB.prepare("SELECT 1 FROM device_tokens WHERE token = 'cascade-tok'").all();
    const prefs = await env.DB.prepare(
      "SELECT 1 FROM user_notification_preferences WHERE user_id = ?",
    ).bind(user!.user_id).all();
    expect(tokens.results).toHaveLength(0);
    expect(prefs.results).toHaveLength(0);
  });
});
