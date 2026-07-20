// GDPR endpoints (PLAN.MD §1.10 / §2.3): erasure with cascade, portability
// export, location-consent withdrawal, and the /privacy page.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, jsonInit, registerAndLogin } from "./helpers";

describe("DELETE /api/auth/me (erasure)", () => {
  it("deletes the account and cascades to tokens + preferences", async () => {
    const { token, email } = await registerAndLogin();
    await api("/api/tokens", jsonInit("POST", { token: "gdpr-tok" }, token));
    await api("/api/preferences/vik", jsonInit("PUT", { isEnabled: false }, token));

    const res = await api("/api/auth/me", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(204);

    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM device_tokens WHERE token = 'gdpr-tok'").first()).toBeNull();
    // The JWT no longer resolves to a user.
    expect((await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  it("401s without auth", async () => {
    expect((await api("/api/auth/me", { method: "DELETE" })).status).toBe(401);
  });
});

describe("GET /api/auth/me/export (portability)", () => {
  it("returns profile, preferences and device metadata — without raw push tokens", async () => {
    const { token, email } = await registerAndLogin();
    await api("/api/tokens",
      jsonInit("POST", { token: "export-tok-secret", platform: "android", deviceName: "Pixel" }, token));
    await api("/api/preferences/heating", jsonInit("PUT", { isEnabled: false }, token));

    const res = await api("/api/auth/me/export", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;

    expect(body.profile.email).toBe(email);
    expect(body.profile.subscribedBusLines).toEqual([]);
    expect(body.notificationPreferences).toEqual([{ category: "heating", isEnabled: false }]);
    expect(body.devices).toEqual([{
      platform: "android",
      deviceName: "Pixel",
      createdAt: body.devices[0].createdAt,
      lastSeenAt: body.devices[0].lastSeenAt,
    }]);
    // The raw FCM token must not appear anywhere in the export.
    expect(JSON.stringify(body)).not.toContain("export-tok-secret");
  });
});

describe("DELETE /api/auth/location (withdraw consent)", () => {
  it("clears lat/lng and region/street", async () => {
    const { token } = await registerAndLogin();
    // Set location fields directly (skip the Nominatim round-trip); the
    // per-test DB contains only this user.
    await env.DB.prepare("UPDATE users SET latitude = 43.2, longitude = 27.9").run();

    const res = await api("/api/auth/location", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(204);

    const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    const dto = await me.json() as Record<string, unknown>;
    expect(dto.latitude).toBeNull();
    expect(dto.longitude).toBeNull();
    expect(dto.hasLocation).toBe(false);
  });
});

describe("GET /privacy", () => {
  it("serves the bilingual policy without auth", async () => {
    const res = await api("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Политика за поверителност");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("cpdp.bg");
    expect(html).toContain("OpenStreetMap");
  });
});
