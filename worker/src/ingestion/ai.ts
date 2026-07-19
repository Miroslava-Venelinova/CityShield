// Workers AI wrapper (PLAN.MD §1.8) — port of ai_parser.py minus the debug
// disk cache. Returns null on any failure so a source skips the message and
// retries next tick (identical contract to the Python version).

import type { Env } from "../env";

// Spike 2 (spikes/RESULTS.md): qwen3-30b is a reasoning model — at the
// default 2000 tokens it burns the budget thinking and returns no JSON.
const MAX_TOKENS = 8000;
const ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function aiParse<T>(
  env: Env,
  system: string,
  user: string,
  jsonSchema: object,
  // Structural typing so T infers as the zod OUTPUT type (defaults applied),
  // not the optional-heavy input type.
  zodSchema: { parse: (data: unknown) => T },
): Promise<T | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await env.AI.run(env.AI_MODEL as Parameters<Ai["run"]>[0], {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: jsonSchema },
        max_tokens: MAX_TOKENS,
      }) as { response?: unknown };

      const raw = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
      return zodSchema.parse(raw);
    } catch (e) {
      if (attempt === ATTEMPTS) {
        console.error(`[ai] parse failed after ${ATTEMPTS} attempts: ${e}`);
        return null;
      }
      console.warn(`[ai] attempt ${attempt}/${ATTEMPTS} failed: ${e}. Retrying.`);
      await sleep(1000 * attempt);
    }
  }
  return null;
}
