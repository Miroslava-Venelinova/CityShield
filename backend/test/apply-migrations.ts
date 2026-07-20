import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file; storage isolation resets D1 in between.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
