import { app } from "./api/app";
import type { Env } from "./env";
import { runDailyCleanup, runIngestion } from "./ingestion/runner";

/**
 * A rejection inside waitUntil surfaces as an unhandled rejection and tells us
 * nothing about which job died, so every scheduled job reports its own failure.
 */
function guard(label: string, job: Promise<void>): Promise<void> {
  return job.catch((e) => console.error(`[scheduled] ${label} failed: ${e}`));
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") ctx.waitUntil(guard("ingestion", runIngestion(env)));
    if (event.cron === "30 3 * * *") ctx.waitUntil(guard("daily cleanup", runDailyCleanup(env)));
  },
} satisfies ExportedHandler<Env>;
