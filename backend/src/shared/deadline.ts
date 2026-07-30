// Wall-clock budgeting for the ingest path.
//
// Every external hop in the pipeline (source fetch, Workers AI, Overpass,
// Nominatim, OneSignal) can hang for minutes on its own. Without a shared budget
// the runner's deadline check between messages is fiction: one stuck subrequest
// burns the whole invocation and the neurons and subrequests spent on the
// message are lost.
//
// The budget that matters is the cron cadence, not a platform kill: the tick has
// to finish well inside 15 minutes so the next one never overlaps it, because
// the cursor/seen-id model assumes one writer per source at a time. See
// DEADLINE_MS in ingestion/runner.ts for the number and the reasoning.
//
// The contract is: a `deadline` is an absolute `Date.now()` timestamp threaded
// down from the runner. Every blocking operation caps its own timeout at
// whatever is left, and refuses to start when nothing is left. `undefined`
// means "no deadline" — the API request path, where Cloudflare's own request
// timeout is the backstop.

/** Milliseconds left, or Infinity when unbounded. */
export function msLeft(deadline?: number): number {
  return deadline === undefined ? Infinity : deadline - Date.now();
}

/** True when the budget is spent (or so nearly spent that starting work is pointless). */
export function expired(deadline?: number, needMs = 0): boolean {
  return msLeft(deadline) <= needMs;
}

/**
 * An AbortSignal firing at whichever comes first: `maxMs` from now, or the
 * deadline. Pass to `fetch` so a hung socket can never outlive the budget.
 */
export function abortIn(maxMs: number, deadline?: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.min(maxMs, msLeft(deadline))));
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Bound a promise that has no abort support of its own — notably `env.AI.run`,
 * whose binding takes no signal. The underlying work keeps running; we stop
 * waiting on it, which is what the budget actually needs.
 */
export async function withTimeout<T>(
  promise: Promise<T>, maxMs: number, deadline: number | undefined, label: string,
): Promise<T> {
  const ms = Math.max(1, Math.min(maxMs, msLeft(deadline)));
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep, but never past the deadline. Returns false when the full delay does
 * not fit — callers use that to skip a retry rather than sleep into the kill.
 */
export async function sleepWithin(ms: number, deadline?: number): Promise<boolean> {
  if (msLeft(deadline) <= ms) return false;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return true;
}

/**
 * End the current CPU burst and start a new one.
 *
 * The free plan's 10 ms is not an invocation total — it bounds one uninterrupted
 * synchronous stretch between two I/O awaits (§1.1; ticks reporting 94 ms of
 * `cpuTime` complete fine). So a computation too long to run in one go does not
 * need a bigger budget, it needs to stop being one go. Awaiting this hands
 * control back to the runtime, which charges what has run so far and starts the
 * next stretch from zero.
 *
 * This is not a substitute for making the work smaller — every yield is a task
 * hop, and slicing a genuinely quadratic loop only spreads the same cost over
 * more of them. Use it where the work is irreducible and already close to the
 * ceiling, which in this Worker means the JSTS pipeline in ingestion/polygon.ts.
 *
 * `setTimeout` rather than `scheduler.wait`: both suspend the isolate, and this
 * one also runs under plain Node, which is what lets tools/polygon-tester
 * execute the very same function.
 */
export function yieldBurst(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
