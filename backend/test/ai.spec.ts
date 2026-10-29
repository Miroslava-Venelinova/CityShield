// The Workers AI wrapper's model fallback (ingestion/ai.ts, specification §1.8).
//
// All three attempts used to go to AI_MODEL. From 30.07.2026 qwen3 routinely
// runs past its 30 s cap, and a retry on the same model mostly times out again,
// spending the tick deadline on nothing. The second attempt now goes to
// AI_FALLBACK_MODEL; the third goes back to the primary.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { aiParse, attemptModels } from "../src/ingestion/ai";
import { processOutageMessage } from "../src/ingestion/pipeline";

const PRIMARY = "@cf/test/primary";
const FALLBACK = "@cf/test/fallback";
const schema = z.object({ answer: z.string() });

type Behaviour = "throw" | "hang" | "invalid" | { answer: string };

describe("aiParse model fallback", () => {
  const real = { AI: env.AI, AI_MODEL: env.AI_MODEL, AI_FALLBACK_MODEL: env.AI_FALLBACK_MODEL };
  afterEach(() => Object.assign(env, real));

  /** Each model behaves as told; returns the models in the order they were called. */
  function mockAI(behaviour: Record<string, Behaviour>, fallback: string | undefined = FALLBACK) {
    const called: string[] = [];
    Object.assign(env, {
      AI_MODEL: PRIMARY,
      AI_FALLBACK_MODEL: fallback,
      AI: {
        run: async (model: string) => {
          called.push(model);
          const b = behaviour[model];
          if (b === undefined || b === "throw") throw new Error(`AiError: ${model} down`);
          if (b === "hang") return new Promise(() => {});
          if (b === "invalid") return { response: JSON.stringify({ wrong: 1 }) };
          return { response: JSON.stringify(b) };
        },
      },
    });
    return called;
  }

  const parse = () => aiParse(env, "system", "user", {}, schema, undefined, 50);

  it("alternates primary, fallback, primary — and keeps the old behaviour without a fallback", () => {
    expect(attemptModels({ AI_MODEL: PRIMARY, AI_FALLBACK_MODEL: FALLBACK }))
      .toEqual([PRIMARY, FALLBACK, PRIMARY]);
    expect(attemptModels({ AI_MODEL: PRIMARY })).toEqual([PRIMARY, PRIMARY, PRIMARY]);
    expect(attemptModels({ AI_MODEL: PRIMARY, AI_FALLBACK_MODEL: "  " })).toEqual([PRIMARY, PRIMARY, PRIMARY]);
    expect(attemptModels({ AI_MODEL: PRIMARY, AI_FALLBACK_MODEL: PRIMARY })).toEqual([PRIMARY, PRIMARY, PRIMARY]);
  });

  it("is configured in wrangler.jsonc with a model distinct from AI_MODEL", () => {
    expect(real.AI_FALLBACK_MODEL).toBeTruthy();
    expect(real.AI_FALLBACK_MODEL).not.toBe(real.AI_MODEL);
  });

  it("does not touch the fallback when the primary answers", async () => {
    const called = mockAI({ [PRIMARY]: { answer: "primary" } });
    expect(await parse()).toEqual({ answer: "primary" });
    expect(called).toEqual([PRIMARY]);
  });

  // The case the fallback exists for: the primary timing out.
  it("parses with the fallback when the primary times out", async () => {
    const called = mockAI({ [PRIMARY]: "hang", [FALLBACK]: { answer: "fallback" } });
    expect(await parse()).toEqual({ answer: "fallback" });
    expect(called).toEqual([PRIMARY, FALLBACK]);
  }, 10_000); // one 1 s backoff

  it("parses with the fallback when the primary errors", async () => {
    const called = mockAI({ [PRIMARY]: "throw", [FALLBACK]: { answer: "fallback" } });
    expect(await parse()).toEqual({ answer: "fallback" });
    expect(called).toEqual([PRIMARY, FALLBACK]);
  }, 10_000);

  // A fallback answer is validated exactly like the primary's: output that does
  // not fit the schema is a failed attempt, and the primary gets another go.
  it("rejects a fallback answer that fails the schema and goes back to the primary", async () => {
    let primaryCalls = 0;
    const called = mockAI({ [FALLBACK]: "invalid" });
    const run = env.AI.run as unknown as (m: string) => Promise<unknown>;
    (env as { AI: unknown }).AI = {
      run: async (model: string) => {
        if (model === PRIMARY && primaryCalls++ > 0) {
          called.push(model);
          return { response: JSON.stringify({ answer: "primary, second try" }) };
        }
        return run(model);
      },
    };
    expect(await parse()).toEqual({ answer: "primary, second try" });
    expect(called).toEqual([PRIMARY, FALLBACK, PRIMARY]);
  }, 15_000); // 1 s + 2 s backoff

  it("returns null after primary, fallback, primary all fail — the message waits for the next tick", async () => {
    const called = mockAI({});
    expect(await parse()).toBeNull();
    expect(called).toEqual([PRIMARY, FALLBACK, PRIMARY]);
  }, 15_000);
});

// The deterministic guards are the safety net for BOTH models: the fallback is
// the smaller extractor, and nothing downstream may trust it more because a
// parse arrived. Driven through the real pipeline with a primary that times out.
describe("a fallback parse still goes through the guards", () => {
  const real = { AI: env.AI, AI_MODEL: env.AI_MODEL, AI_FALLBACK_MODEL: env.AI_FALLBACK_MODEL };
  afterEach(() => Object.assign(env, real));

  it("drops a place the fallback invented (A10)", async () => {
    Object.assign(env, {
      AI_MODEL: PRIMARY,
      AI_FALLBACK_MODEL: FALLBACK,
      AI: {
        run: async (model: string) => {
          if (model === PRIMARY) throw new Error("AiError: timed out");
          // 40b78a66's shape: a district the message never names.
          return {
            response: JSON.stringify({
              locations: [{ settlement: "гр. Варна", area: "кв. Виница", streets: [], is_polygon: false }],
              schedule: { from_date: null, to_date: null, windows: [] },
              city_wide: false,
            }),
          };
        },
      },
    });

    const ok = await processOutageMessage(
      env, "VIK", "vik", "Без вода", "Авария на водопровод в ж.к. Трошево.", "id=990001");
    expect(ok).toBe(true);
    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE source_ref = ?")
      .bind("vik:id=990001").first<{ locations_json: string }>();
    expect(row!.locations_json).not.toContain("Виница");
  }, 10_000);
});
