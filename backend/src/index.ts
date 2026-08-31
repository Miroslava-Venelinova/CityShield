import { app } from "./api/app";
import { markTickCompleted, markTickStarted } from "./db/queries";
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
        // The heartbeat brackets the work and is written to D1, not to the log
        // stream: an `exceededCpu` kill discards the invocation's logs, so the
        // one signal that a tick died is the one that must not live in them
        // (migration 0019). `started_at` is committed before any parsing;
        // `completed_at` only if the tick reaches the end. Both are I/O, so
        // neither adds meaningfully to the 10 ms CPU burst they report on.
        await guard("tick heartbeat (start)", markTickStarted(env, event.cron));
        {
          const startedAt = Date.now();
          await guard("ingestion", runIngestion(env));
          await guard("tick heartbeat (end)",
            markTickCompleted(env, event.cron, Date.now() - startedAt));
        }
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
