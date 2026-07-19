import { env } from "cloudflare:test";
import { app } from "../src/api/app";

export async function api(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init, env);
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
