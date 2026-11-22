// The JSON a Workers AI text-generation call answered with (docs/specification.md §1.8).
//
// Two reply shapes exist. The models the pipeline was built on (qwen3-30b,
// llama-3.x) answer `{ response }`, holding either the parsed object or a JSON
// string. The newer catalog models — gemma-4, qwen3.8, gpt-oss, glm — answer
// in the OpenAI chat-completion shape, `{ choices: [{ message: { content } }] }`,
// with no `response` at all. Reading only `response` turned every gemma-4
// fallback parse into a zod "Required" error from 29.10.2026, unnoticed until
// qwen3-30b was deprecated on 20.11.2026 and the fallback was all there was.
//
// No imports, on purpose: spikes/ai-eval loads this file under plain Node, so
// the eval reads a reply exactly the way ingestion does.

/**
 * The model's JSON output: an object, or whatever JSON.parse makes of the text.
 * Returns undefined when the reply carries neither shape, and throws when the
 * text is not JSON — both for the zod schema (or the caller) to reject.
 */
export function aiOutput(res: unknown): unknown {
  if (typeof res !== "object" || res === null) return undefined;
  const reply = res as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const raw = reply.response ?? reply.choices?.[0]?.message?.content;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}
