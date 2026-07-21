// Workers AI wrapper (PLAN.MD §1.8) — port of ai_parser.py minus the debug
// disk cache. Returns null on any failure so a source skips the message and
// retries next tick (identical contract to the Python version).

import type { Env } from "../env";
import { expired, sleepWithin, withTimeout } from "../shared/deadline";

// Spike 2 (spikes/RESULTS.md): qwen3-30b is a reasoning model — at the
// default 2000 tokens it burns the budget thinking and returns no JSON.
const MAX_TOKENS = 8000;
const ATTEMPTS = 3;

// The AI binding accepts no AbortSignal, so a wedged inference request would
// otherwise hold the invocation open until workerd kills it. A generous cap
// (reasoning models genuinely take a while at 8k tokens) still beats no cap.
const RUN_TIMEOUT_MS = 20_000;

export async function aiParse<T>(
  env: Env,
  system: string,
  user: string,
  jsonSchema: object,
  // Structural typing so T infers as the zod OUTPUT type (defaults applied),
  // not the optional-heavy input type.
  zodSchema: { parse: (data: unknown) => T },
  deadline?: number,
): Promise<T | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Starting an inference we cannot wait out just burns neurons for nothing.
    if (expired(deadline, 1000)) {
      console.warn(`[ai] no time budget left; giving up after ${attempt - 1} attempt(s).`);
      return null;
    }
    try {
      const res = await withTimeout(
        env.AI.run(env.AI_MODEL as Parameters<Ai["run"]>[0], {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_schema", json_schema: jsonSchema },
          max_tokens: MAX_TOKENS,
        }) as Promise<{ response?: unknown }>,
        RUN_TIMEOUT_MS, deadline, "AI.run",
      );

      const raw = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
      return zodSchema.parse(raw);
    } catch (e) {
      if (attempt === ATTEMPTS) {
        console.error(`[ai] parse failed after ${ATTEMPTS} attempts: ${e}`);
        return null;
      }
      console.warn(`[ai] attempt ${attempt}/${ATTEMPTS} failed: ${e}. Retrying.`);
      if (!(await sleepWithin(1000 * attempt, deadline))) {
        console.warn("[ai] budget too tight to back off; giving up.");
        return null;
      }
    }
  }
  return null;
}
