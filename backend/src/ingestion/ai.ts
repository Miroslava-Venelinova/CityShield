// Workers AI wrapper (docs/specification.md §1.8). Returns null on any failure
// so a source skips the message and retries next tick.
//
// Two models: AI_MODEL, and AI_FALLBACK_MODEL for the retry after it fails.
// Whichever model answers, the output goes through the same zod schema and the
// same deterministic guards (normalize.ts) — the fallback changes who parses,
// never what is trusted.

import type { Env } from "../env";
import { expired, sleepWithin, withTimeout } from "../shared/deadline";

// Spike 2 (spikes/RESULTS.md): qwen3-30b is a reasoning model — at the
// default 2000 tokens it burns the budget thinking and returns no JSON.
const MAX_TOKENS = 10_000;
const ATTEMPTS = 3;

// The AI binding accepts no AbortSignal, so a wedged inference request would
// otherwise hold the invocation open until workerd kills it. Spike 2 clocked
// legitimate qwen3 parses at 4–21 s (reasoning models genuinely take a while at
// 8k tokens), so the old 20 s cap could abort a call that was about to succeed;
// 30 s clears the observed tail while still bounding a truly wedged request.
// The effective wait is min(this, remaining deadline) (deadline.ts), so the
// tick budget (DEADLINE_MS, 5 min) is what actually lets this breathe.
const RUN_TIMEOUT_MS = 30_000;

/**
 * The model each attempt runs on: primary, fallback, primary.
 *
 * All three attempts used to go to AI_MODEL. Since 30.07.2026 qwen3 routinely
 * runs past its 30 s cap (6 timeouts against 8 ingested messages over three
 * ticks, §3.8), and a retry on the same model inside the same minute mostly
 * times out again — 30 s more of the tick deadline spent on nothing. So the
 * second attempt goes to a different model on different capacity.
 *
 * The third goes BACK to the primary rather than staying on the fallback. The
 * fallback is the smaller, less proven extractor (its eval is still owed —
 * §1.8), and a fallback that rejects the schema outright (5024/5025, as two
 * Phase 0 candidates did on every call) must cost one quick attempt, not two of
 * the primary's three. Unset, or equal to AI_MODEL, every attempt is AI_MODEL
 * exactly as before.
 */
export function attemptModels(env: Pick<Env, "AI_MODEL" | "AI_FALLBACK_MODEL">): string[] {
  const fallback = env.AI_FALLBACK_MODEL?.trim();
  if (!fallback || fallback === env.AI_MODEL) return Array<string>(ATTEMPTS).fill(env.AI_MODEL);
  return [env.AI_MODEL, fallback, env.AI_MODEL];
}

export async function aiParse<T>(
  env: Env,
  system: string,
  user: string,
  jsonSchema: object,
  // Structural typing so T infers as the zod OUTPUT type (defaults applied),
  // not the optional-heavy input type.
  zodSchema: { parse: (data: unknown) => T },
  deadline?: number,
  /** Injectable for tests, which cannot wait out 30 s per timeout. */
  runTimeoutMs: number = RUN_TIMEOUT_MS,
): Promise<T | null> {
  const models = attemptModels(env);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const model = models[attempt - 1]!;
    // Starting an inference we cannot wait out just burns neurons for nothing.
    if (expired(deadline, 1000)) {
      console.warn(`[ai] no time budget left; giving up after ${attempt - 1} attempt(s).`);
      return null;
    }
    try {
      const res = await withTimeout(
        env.AI.run(model as Parameters<Ai["run"]>[0], {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_schema", json_schema: jsonSchema },
          max_tokens: MAX_TOKENS,
        }) as Promise<{ response?: unknown }>,
        runTimeoutMs, deadline, `AI.run(${model})`,
      );

      const raw = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
      const parsed = zodSchema.parse(raw);
      // Every parse names its model, so a fallback parse is findable in the
      // tail — it is the less proven of the two, and the one to check first
      // when an alert reads oddly.
      const fallback = model !== env.AI_MODEL;
      console.log(
        `[ai] parsed by ${model}${fallback ? " (FALLBACK model)" : ""}, attempt ${attempt}/${ATTEMPTS}.`);
      return parsed;
    } catch (e) {
      if (attempt === ATTEMPTS) {
        console.error(`[ai] parse failed after ${ATTEMPTS} attempts (last on ${model}): ${e}`);
        return null;
      }
      console.warn(
        `[ai] attempt ${attempt}/${ATTEMPTS} on ${model} failed: ${e}. Retrying on ${models[attempt]}.`);
      if (!(await sleepWithin(1000 * attempt, deadline))) {
        console.warn("[ai] budget too tight to back off; giving up.");
        return null;
      }
    }
  }
  return null;
}
