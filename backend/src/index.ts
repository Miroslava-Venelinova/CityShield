import { app } from "./api/app";
import type { Env } from "./env";
import { runDailyCleanup, runIngestion } from "./ingestion/runner";

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") ctx.waitUntil(runIngestion(env));
    if (event.cron === "30 3 * * *") ctx.waitUntil(runDailyCleanup(env));
  },
} satisfies ExportedHandler<Env>;
