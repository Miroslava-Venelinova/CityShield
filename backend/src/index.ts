import { app } from "./api/app";
import type { Env } from "./env";
import { runDailyCleanup, runIngestion } from "./ingestion/runner";

/** Must stay in sync with `triggers.crons` in wrangler.jsonc. */
const INGEST_CRON = "*/15 * * * *";
const CLEANUP_CRON = "30 3 * * *";

/**
 * A rejection inside a scheduled job surfaces as an unhandled rejection and
 * tells us nothing about which job died, so every job reports its own failure.
 */
function guard(label: string, job: Promise<void>): Promise<void> {
  return job.catch((e) => console.error(`[scheduled] ${label} failed: ${e}`));
}

export default {
  fetch: app.fetch,

  /**
   * Dispatch on which cron fired.
   *
   * Two things here are deliberate. First, the job is awaited rather than handed
   * to `ctx.waitUntil`: the runtime waits either way, but awaiting makes the
   * invocation's duration and CPU time describe the actual work, which is what
   * `wrangler tail` is read against when checking whether a schedule really
   * fires. With waitUntil the invocation reported completion instantly and every
   * tick looked like a no-op whether or not it did anything.
   *
   * Second, an expression matching neither constant is logged loudly instead of
   * being dropped. Matching literal cron strings is brittle — a schedule edited
   * outside wrangler.jsonc stops matching and every branch silently misses,
   * which is indistinguishable from "the cron never fired" and cost real time to
   * diagnose once already.
   */
  async scheduled(event, env, _ctx) {
    switch (event.cron) {
      case INGEST_CRON:
        await guard("ingestion", runIngestion(env));
        break;
      case CLEANUP_CRON:
        await guard("daily cleanup", runDailyCleanup(env));
        break;
      default:
        console.error(
          `[scheduled] Unrecognized cron '${event.cron}' — nothing ran. `
          + `Expected '${INGEST_CRON}' or '${CLEANUP_CRON}'; the deployed schedule `
          + `has drifted from wrangler.jsonc.`,
        );
    }
  },
} satisfies ExportedHandler<Env>;
