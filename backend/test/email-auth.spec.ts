// Email verification + password reset: the token primitive and both link flows.
//
// Delivery is mocked (core/mailer.ts), which the tests exploit rather than work
// around — the mock's outbox lets them open the exact link a user would have
// received, so the flows are covered end-to-end and not just from the token
// layer inward.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeToken, hashToken, issueToken } from "../src/core/auth-tokens";
import { clearSentMail, render, sentMail, verificationMail } from "../src/core/mailer";
import { api, jsonInit, registerAndLogin } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => clearSentMail());

afterEach(() => fetchMock.assertNoPendingInterceptors());

/** The link from the most recent message to `to`, as a user would follow it. */
function linkFor(to: string): string {
  const mail = [...sentMail()].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`no mail sent to ${to}`);
  return mail.url;
}

/** The reset page posts a real HTML form, so the endpoint has to accept one. */
function formInit(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

async function userIdOf(email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?")
    .bind(email).first<{ user_id: string }>();
  if (!row) throw new Error(`no user ${email}`);
  return row.user_id;
}

describe("auth-tokens", () => {
  it("stores only the hash, never the token itself", async () => {
    const { email } = await registerAndLogin();
    const userId = await userIdOf(email);
    const token = await issueToken(env, userId, "reset_password", 60);

    const row = await env.DB.prepare(
      "SELECT token_hash FROM auth_tokens WHERE user_id = ? AND purpose = 'reset_password'",
    ).bind(userId).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await hashToken(token));
    expect(row!.token_hash).not.toBe(token);
  });

  it("redeems once and only once", async () => {
    const { email } = await registerAndLogin();
    const userId = await userIdOf(email);
    const token = await issueToken(env, userId, "reset_password", 60);

    expect(await consumeToken(env, token, "reset_password")).toBe(userId);
    expect(await consumeToken(env, token, "reset_password")).toBeNull();
  });

  it("rejects the right token used for the wrong purpose", async () => {
    const { email } = await registerAndLogin();
    const userId = await userIdOf(email);
    const token = await issueToken(env, userId, "verify_email", 60);

    expect(await consumeToken(env, token, "reset_password")).toBeNull();
    // Still good for what it was minted for.
    expect(await consumeToken(env, token, "verify_email")).toBe(userId);
  });

  it("rejects an expired token", async () => {
    const { email } = await registerAndLogin();
    const userId = await userIdOf(email);
    const token = await issueToken(env, userId, "reset_password", -1);

    expect(await consumeToken(env, token, "reset_password")).toBeNull();
  });

  it("invalidates the previous link when a new one is issued", async () => {
    const { email } = await registerAndLogin();
    const userId = await userIdOf(email);
    const first = await issueToken(env, userId, "verify_email", 60);
    const second = await issueToken(env, userId, "verify_email", 60);

    expect(await consumeToken(env, first, "verify_email")).toBeNull();
    expect(await consumeToken(env, second, "verify_email")).toBe(userId);
  });

  it("drops tokens with the user (FK cascade)", async () => {
    const { token, email } = await registerAndLogin();
    const userId = await userIdOf(email);
    await issueToken(env, userId, "verify_email", 60);

    await api("/api/auth/me", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });

    const left = await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE user_id = ?")
      .bind(userId).first();
    expect(left).toBeNull();
  });
});

describe("email verification", () => {
  it("registration issues a verification token and reports the account unverified", async () => {
    const { token, email } = await registerAndLogin();
    const userId = await userIdOf(email);

    const issued = await env.DB.prepare(
      "SELECT 1 FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'",
    ).bind(userId).first();
    expect(issued).not.toBeNull();

    const me = await (await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(me.emailVerified).toBe(false);
  });

  it("verifies the address when the link from the signup mail is opened", async () => {
    const { token, email } = await registerAndLogin();

    // Exactly the URL the user was mailed, not a token minted on the side.
    const mailed = new URL(linkFor(email));
    const res = await api(`${mailed.pathname}${mailed.search}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const me = await (await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(me.emailVerified).toBe(true);
  });

  it("400s on a missing, unknown or reused link", async () => {
    expect((await api("/api/auth/verify")).status).toBe(400);
    expect((await api("/api/auth/verify?token=nonsense")).status).toBe(400);

    const { email } = await registerAndLogin();
    const link = await issueToken(env, await userIdOf(email), "verify_email", 60);
    expect((await api(`/api/auth/verify?token=${link}`)).status).toBe(200);
    expect((await api(`/api/auth/verify?token=${link}`)).status).toBe(400);
  });

  it("resend issues a fresh token, needs auth, and is a no-op once verified", async () => {
    const { token, email } = await registerAndLogin();
    const userId = await userIdOf(email);

    expect((await api("/api/auth/verify/resend", { method: "POST" })).status).toBe(401);

    const res = await api("/api/auth/verify/resend", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(204);
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'",
    ).bind(userId).first<{ n: number }>();
    // Registration's token was replaced, not accumulated.
    expect(after!.n).toBe(1);

    // Once verified, resending issues nothing further but still answers 204.
    await env.DB.prepare("UPDATE users SET email_verified_at = ? WHERE user_id = ?")
      .bind(new Date().toISOString(), userId).run();
    await env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ?").bind(userId).run();

    const second = await api("/api/auth/verify/resend", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(second.status).toBe(204);
    const none = await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE user_id = ?").bind(userId).first();
    expect(none).toBeNull();
  });

  it("includes the verification state in the GDPR export", async () => {
    const { token } = await registerAndLogin();
    const body = await (await api("/api/auth/me/export", { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(body.profile.emailVerified).toBe(false);
  });
});

describe("POST /api/auth/password/forgot", () => {
  it("answers 204 for an unknown address without issuing anything", async () => {
    const res = await api("/api/auth/password/forgot",
      jsonInit("POST", { email: "nobody-here@example.com" }));
    expect(res.status).toBe(204);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM auth_tokens WHERE purpose = 'reset_password'",
    ).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("answers 204 and issues a token for a known address", async () => {
    const { email } = await registerAndLogin();
    const res = await api("/api/auth/password/forgot", jsonInit("POST", { email }));
    expect(res.status).toBe(204);

    const row = await env.DB.prepare(
      "SELECT 1 FROM auth_tokens WHERE user_id = ? AND purpose = 'reset_password'",
    ).bind(await userIdOf(email)).first();
    expect(row).not.toBeNull();
  });

  it("stays neutral on a malformed body", async () => {
    expect((await api("/api/auth/password/forgot", jsonInit("POST", { email: "bogus" }))).status).toBe(204);
    expect((await api("/api/auth/password/forgot", jsonInit("POST", {}))).status).toBe(204);
  });
});

describe("password reset", () => {
  it("serves the form for a link and 400s without one", async () => {
    const { email } = await registerAndLogin();
    const link = await issueToken(env, await userIdOf(email), "reset_password", 60);

    const res = await api(`/api/auth/password/reset?token=${link}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(link);
    expect(html).toContain("</form>");
    // Rendering must not redeem the token — mail scanners prefetch links.
    expect(await consumeToken(env, link, "reset_password")).not.toBeNull();

    expect((await api("/api/auth/password/reset")).status).toBe(400);
  });

  it("walks the whole flow: forgot → mailed link → form → new password", async () => {
    const { email } = await registerAndLogin();
    const userId = await userIdOf(email);

    expect((await api("/api/auth/password/forgot", jsonInit("POST", { email }))).status).toBe(204);

    // Follow the mailed link, then post the form it renders.
    const mailed = new URL(linkFor(email));
    const link = mailed.searchParams.get("token")!;
    expect((await api(`${mailed.pathname}${mailed.search}`)).status).toBe(200);

    const res = await api("/api/auth/password/reset",
      formInit({ token: link, password: "brand new password", confirm: "brand new password" }));
    expect(res.status).toBe(200);

    const fresh = await api("/api/auth/login", jsonInit("POST", { email, password: "brand new password" }));
    expect(fresh.status).toBe(200);
    const stale = await api("/api/auth/login", jsonInit("POST", { email, password: "correct horse battery" }));
    expect(stale.status).toBe(401);

    // Receiving the mail proves the address works.
    const user = await env.DB.prepare("SELECT email_verified_at FROM users WHERE user_id = ?")
      .bind(userId).first<{ email_verified_at: string | null }>();
    expect(user!.email_verified_at).not.toBeNull();
  });

  it("re-renders the form on a bad password without burning the link", async () => {
    const { email } = await registerAndLogin();
    const link = await issueToken(env, await userIdOf(email), "reset_password", 60);

    const short = await api("/api/auth/password/reset",
      formInit({ token: link, password: "short", confirm: "short" }));
    expect(short.status).toBe(400);
    expect(await short.text()).toContain("</form>");

    const mismatch = await api("/api/auth/password/reset",
      formInit({ token: link, password: "long enough here", confirm: "different entirely" }));
    expect(mismatch.status).toBe(400);

    // The user can still fix the form with the same link.
    const ok = await api("/api/auth/password/reset",
      formInit({ token: link, password: "long enough here", confirm: "long enough here" }));
    expect(ok.status).toBe(200);
  });

  it("400s on a reused or unknown link", async () => {
    const { email } = await registerAndLogin();
    const link = await issueToken(env, await userIdOf(email), "reset_password", 60);
    const body = { token: link, password: "another password", confirm: "another password" };

    expect((await api("/api/auth/password/reset", formInit(body))).status).toBe(200);
    expect((await api("/api/auth/password/reset", formInit(body))).status).toBe(400);
    expect((await api("/api/auth/password/reset",
      formInit({ ...body, token: "nonsense" }))).status).toBe(400);
  });
});

describe("mailer (mock)", () => {
  it("delivers nothing over the network", async () => {
    // No fetch interceptor is registered anywhere in this suite, and
    // disableNetConnect is on: an outbound send would fail the test.
    await registerAndLogin();
    expect(sentMail()).toHaveLength(1);
  });

  it("still composes both language halves and the link", () => {
    const { html, text } = render(
      verificationMail("user@example.com", "https://example.com/verify?token=abc"));

    expect(html).toContain("Потвърди имейла");
    expect(html).toContain("Confirm email");
    expect(html).toContain("https://example.com/verify?token=abc");
    expect(text).toContain("https://example.com/verify?token=abc");
  });

  it("escapes the link rather than interpolating it raw into the HTML", () => {
    const { html } = render(verificationMail("user@example.com", 'https://x/?t=a"><script>'));
    expect(html).not.toContain("<script>");
  });
});
