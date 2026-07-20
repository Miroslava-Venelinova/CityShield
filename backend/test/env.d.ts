import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    TEST_FIXTURES: Record<string, string>;
  }
}
