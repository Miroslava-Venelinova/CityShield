// Scheduled dispatcher (PLAN.MD §1.7): the asyncio loops collapse into
// one cron tick. Sources run sequentially under a 25 s deadline guard, and
// the start order rotates by tick number so a slow source can't starve the
// others. Worst case is delayed — never lost — alerts (cursor semantics).

import type { Env } from "../env";
import * as epro from "./sources/epro";
import * as heating from "./sources/heating";
import * as vik from "./sources/vik";
import * as vt from "./sources/vt";

const SOURCES: Array<{ name: string; run: (env: Env, deadline: number) => Promise<void> }> = [
  { name: "vik", run: vik.run },
  { name: "heating", run: heating.run },
  { name: "epro", run: epro.run },
  { name: "vt", run: vt.run },
];

const DEADLINE_MS = 25_000;
const TICK_INTERVAL_MS = 10 * 60 * 1000;

export async function runIngestion(env: Env): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  const tick = Math.floor(Date.now() / TICK_INTERVAL_MS);
  const order = [...SOURCES.slice(tick % SOURCES.length), ...SOURCES.slice(0, tick % SOURCES.length)];

  for (const source of order) {
    if (Date.now() >= deadline) {
      console.warn(`[runner] Deadline reached before '${source.name}' — it runs next tick.`);
      break;
    }
    try {
      await source.run(env, deadline);
    } catch (e) {
      console.error(`[runner] Source '${source.name}' failed: ${e}`);
    }
  }
}

/**
 * Daily cron (30 3 * * *): §1.6 stale-token cleanup + §1.10 retention jobs.
 */
export async function runDailyCleanup(env: Env): Promise<void> {
  const cutoff = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const tokens = await env.DB.prepare("DELETE FROM device_tokens WHERE last_seen_at < ?")
    .bind(cutoff(60)).run();
  const alerts = await env.DB.prepare("DELETE FROM alerts WHERE created_on_utc < ?")
    .bind(cutoff(90)).run();
  const geocache = await env.DB.prepare("DELETE FROM geocode_cache WHERE resolved_at < ?")
    .bind(cutoff(180)).run();
  console.log(`[cleanup] removed ${tokens.meta.changes} stale token(s), `
    + `${alerts.meta.changes} old alert(s), ${geocache.meta.changes} geocode cache row(s)`);
}
