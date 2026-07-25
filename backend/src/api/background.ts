// Fire-and-forget work attached to a request.
//
// `c.executionCtx` is a getter that THROWS when no ExecutionContext was supplied
// — which is the case for `app.request(...)` in tests, and for any future caller
// that invokes the Hono app directly. Reaching for it unguarded turns a
// best-effort side task (sending mail, warming a cache) into a 500 on the
// endpoint that scheduled it, which is the opposite of best-effort.

/** Context shape this needs — narrow on purpose, so tests can pass a stub. */
interface HasExecutionCtx {
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Run `promise` past the response when the platform allows it, and let it run
 * unextended when it does not. Either way the caller never fails because of it,
 * and the promise is never left to surface as an unhandled rejection.
 */
export function detach(c: HasExecutionCtx, promise: Promise<unknown>): void {
  const swallowed = promise.catch((e) => {
    console.error(`Detached task failed: ${e}`);
  });
  try {
    c.executionCtx.waitUntil(swallowed);
  } catch {
    // No ExecutionContext to extend the invocation with: the work still runs,
    // it just is not guaranteed to outlive the response.
    void swallowed;
  }
}
