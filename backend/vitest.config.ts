import { defineWorkersProject, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export default defineWorkersProject(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  // HTML/JSON fixtures are read here (Node context) and handed to the tests
  // as a binding — workerd has no fs, and relative `?raw` imports don't
  // typecheck against wildcard ambient modules.
  const fixturesDir = path.join(__dirname, "test", "fixtures");
  const fixtures = Object.fromEntries(
    readdirSync(fixturesDir).map((name) => [name, readFileSync(path.join(fixturesDir, name), "utf8")]),
  );

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Mirrors the `ratelimits` block in wrangler.jsonc — keep the two
            // in sync. They are duplicated rather than derived because the
            // pinned vitest-pool-workers (0.8.x) bundles its own wrangler
            // 4.35, which predates the `ratelimits` config key and drops it
            // with an "unexpected field" warning. Deriving them would mean
            // upgrading to vitest-pool-workers 0.18, which requires vitest 4.
            ratelimits: {
              RL_LOGIN_IP: { simple: { limit: 20, period: 60 } },
              RL_LOGIN_EMAIL: { simple: { limit: 10, period: 60 } },
              RL_REGISTER_IP: { simple: { limit: 5, period: 60 } },
              RL_GEOCODE_USER: { simple: { limit: 5, period: 60 } },
              RL_API_IP: { simple: { limit: 120, period: 60 } },
            },
            bindings: {
              TEST_MIGRATIONS: migrations,
              TEST_FIXTURES: fixtures,
              // Secrets come from wrangler secret / .dev.vars outside tests.
              JWT_KEY: "test-jwt-key-0123456789-0123456789-0123456789-01234567",
              INGEST_API_KEY: "test-ingest-key",
            },
          },
        },
      },
    },
  };
});
