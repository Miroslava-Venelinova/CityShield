// Session renewal — POST /api/auth/refresh + /logout (migration 0007).
//
// The bug these cover: the access token expires after an hour and nothing
// renewed it, so a signed-in app went permanently dead.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, freshIp, jsonInit } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

let n = 0;

/** Registers a user and returns the full token pair from login. */
async function newSession(): Promise<{ token: string; refreshToken: string; email: string }> {
  const email = `refresh${++n}-${Date.now()}@example.com`;
  const password = "correct horse battery";
  await api("/api/auth/register", jsonInit("POST", { email, password }));
  const res = await api("/api/auth/login", jsonInit("POST", { email, password }));
  const body = (await res.json()) as { token: string; refreshToken: string };
  return { ...body, email };
}

/** Every refresh is rate-limited per IP, so each one gets its own caller. */
function refresh(refreshToken: string) {
  return api("/api/auth/refresh", jsonInit("POST", { refreshToken }), freshIp());
}

describe("POST /api/auth/login", () => {
  it("returns a refresh token alongside the JWT", async () => {
    const { token, refreshToken } = await newSession();
    expect(token.split(".")).toHaveLength(3);
    expect(refreshToken.length).toBeGreaterThan(20);
  });
});

describe("POST /api/auth/refresh", () => {
  it("exchanges a refresh token for a working access token", async () => {
    const { refreshToken } = await newSession();

    const res = await refresh(refreshToken);
    expect(res.status).toBe(200);
    const renewed = (await res.json()) as { token: string; refreshToken: string };

    // The new access token must actually authenticate.
    const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${renewed.token}` } });
    expect(me.status).toBe(200);
  });

  it("rotates: the presented token stops working, its replacement works", async () => {
    const { refreshToken } = await newSession();
    const first = (await (await refresh(refreshToken)).json()) as { refreshToken: string };

    // Replacement first: replaying the spent one revokes the family (next
    // test), which would take the replacement down with it.
    expect((await refresh(first.refreshToken)).status).toBe(200);
    expect((await refresh(refreshToken)).status).toBe(401);
  });

  it("revokes the whole family when a spent token is replayed", async () => {
    const { refreshToken } = await newSession();
    const a = (await (await refresh(refreshToken)).json()) as { refreshToken: string };
    const b = (await (await refresh(a.refreshToken)).json()) as { refreshToken: string };

    // A thief replays the token the device already spent.
    expect((await refresh(a.refreshToken)).status).toBe(401);
    // The live token dies with it — both parties must sign in again.
    expect((await refresh(b.refreshToken)).status).toBe(401);
  });

  it("rejects unknown and malformed tokens with 401", async () => {
    expect((await refresh("not-a-real-token")).status).toBe(401);
    expect((await api("/api/auth/refresh", jsonInit("POST", {}), freshIp())).status).toBe(401);
  });

  it("does not survive account deletion", async () => {
    const { token, refreshToken } = await newSession();
    await api("/api/auth/me", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect((await refresh(refreshToken)).status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session and answers 204 either way", async () => {
    const { refreshToken } = await newSession();

    expect((await api("/api/auth/logout", jsonInit("POST", { refreshToken }))).status).toBe(204);
    expect((await refresh(refreshToken)).status).toBe(401);

    // Unknown token, and a malformed body: still 204, never an error dialog.
    expect((await api("/api/auth/logout", jsonInit("POST", { refreshToken: "gone" }))).status).toBe(204);
    expect((await api("/api/auth/logout", jsonInit("POST", {}))).status).toBe(204);
  });

  it("leaves other devices signed in", async () => {
    const email = `multi-${Date.now()}@example.com`;
    const password = "correct horse battery";
    await api("/api/auth/register", jsonInit("POST", { email, password }));

    const one = (await (await api("/api/auth/login", jsonInit("POST", { email, password })))
      .json()) as { refreshToken: string };
    const two = (await (await api("/api/auth/login", jsonInit("POST", { email, password })))
      .json()) as { refreshToken: string };

    await api("/api/auth/logout", jsonInit("POST", { refreshToken: one.refreshToken }));
    expect((await refresh(two.refreshToken)).status).toBe(200);
  });
});

describe("password reset", () => {
  it("signs every device out", async () => {
    const { email, refreshToken } = await newSession();

    // Mint a reset token the way /password/forgot does, then complete the form.
    const { issueToken, RESET_TTL_MINUTES } = await import("../src/core/auth-tokens");
    const user = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?")
      .bind(email.toLowerCase()).first<{ user_id: string }>();
    const link = await issueToken(env as never, user!.user_id, "reset_password", RESET_TTL_MINUTES);

    const form = new URLSearchParams({ token: link, password: "brand new password", confirm: "brand new password" });
    const res = await api("/api/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }, freshIp());
    expect(res.status).toBe(200);

    expect((await refresh(refreshToken)).status).toBe(401);
  });
});
