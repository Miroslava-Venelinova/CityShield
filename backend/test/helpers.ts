import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/api/app";

/**
 * A caller IP no other test has used, so the rate limiters stay out of the way.
 *
 * Random rather than a counter: vitest gives each test FILE its own copy of this
 * module, so a counter starting at zero handed the first request of every file
 * the same address. RL_REGISTER_IP allows five registrations per key per minute,
 * so once five files had spent it, the sixth file to register got a 429 that had
 * nothing to do with what it was testing — a flake that only showed up in a full
 * suite run, and moved around as files were added.
 *
 * The value is a rate-limiter bucket key, never parsed as an address (see
 * clientIp), so uniqueness is the only property that matters.
 */
export function freshIp(): string {
  return `203.0.113.${crypto.randomUUID()}`;
}

/**
 * Rate limiters key on `CF-Connecting-IP`, and miniflare enforces them for
 * real. Without a per-call IP the suite throttles itself — every request would
 * share the one "local" fallback bucket and trip RL_REGISTER_IP after five
 * registrations. Tests that assert throttling pass an explicit fixed IP.
 */
export async function api(path: string, init?: RequestInit, ip?: string): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("CF-Connecting-IP", ip ?? freshIp());
  // A real ExecutionContext, because routes use waitUntil for work that must
  // outlive the response (mail sends). Without one, `c.executionCtx` throws;
  // waiting on it afterwards also makes that background work deterministic.
  const ctx = createExecutionContext();
  const res = await app.request(path, { ...init, headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

let userCounter = 0;

/** Registers a fresh user and returns their JWT + email. */
export async function registerAndLogin(): Promise<{ token: string; email: string }> {
  const email = `user${++userCounter}-${Date.now()}@example.com`;
  const password = "correct horse battery";

  const reg = await api("/api/auth/register", jsonInit("POST", { email, password }));
  if (reg.status !== 200) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);

  const login = await api("/api/auth/login", jsonInit("POST", { email, password }));
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const { token } = (await login.json()) as { token: string };
  return { token, email };
}
