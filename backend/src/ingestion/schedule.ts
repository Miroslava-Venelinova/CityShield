// Per-source polling intervals — port of the *_INTERVAL settings in
// backend_deprecated/backend/config.py. Some sources publish a handful of
// messages a week, so hitting them every tick is pure waste (and burns AI +
// D1 quota on nothing).
//
// The Worker still wakes on ONE cron ("*/5 * * * *", see wrangler.toml);
// this module decides which sources are due on a given tick. Whether a source
// runs is derived purely from wall-clock time, so it costs no state row and
// survives restarts — the trade-off is that the phase is fixed to the epoch
// rather than to "when this source last ran".

/** Must stay in sync with the ingest cron in wrangler.toml. */
// 5 rather than 10 so a 15-minute interval is expressible; ticks with nothing
// due return immediately.
export const TICK_MINUTES = 5;

const TICK_MS = TICK_MINUTES * 60 * 1000;

/**
 * How often each source is polled, in minutes. Values are rounded UP to a
 * multiple of TICK_MINUTES — the Worker can't wake more precisely than the
 * cron, so 22 behaves as 25. A source missing from this map falls back to
 * DEFAULT_INTERVAL_MINUTES.
 */
export const DEFAULT_INTERVAL_MINUTES = 10;

export const SOURCE_INTERVAL_MINUTES: Record<string, number> = {
  vik: 15, // several outages a day
  epro: 15, // planned + unplanned power cuts, moderately chatty
  vt: 360, // route changes; a few per week
  heating: 240, // handful of messages a month outside the heating season
};

/** Resolved interval expressed in ticks (always >= 1). */
export function ticksFor(source: string): number {
  const minutes = SOURCE_INTERVAL_MINUTES[source] ?? DEFAULT_INTERVAL_MINUTES;
  return Math.max(1, Math.ceil(minutes / TICK_MINUTES));
}

/**
 * Whether `source` should run on the tick containing `now`.
 *
 * `phase` staggers sources that share an interval so they don't all land on
 * the same tick and fight over the 25 s deadline; pass a stable per-source
 * index. Sources at the tick rate (every === 1) are due on every tick
 * regardless of phase.
 */
export function isDue(source: string, phase: number, now: number = Date.now()): boolean {
  const every = ticksFor(source);
  const tick = Math.floor(now / TICK_MS);
  return ((tick - phase) % every + every) % every === 0;
}
