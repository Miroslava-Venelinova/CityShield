// The prompts and JSON schemas the eval replays.
//
// OUTAGE and VT are RE-EXPORTED from production rather than copied. They were a
// character-for-character copy taken at Phase 0, which was right while the point
// was to grade the models against the shipped prompt — but the prompt has since
// become something the eval is used to *change* (fix-plan Phase E), and a copy
// that has to be updated in lockstep is a copy that eventually is not. Node
// strips the types on import, so this reads the real thing.
//
// ROADS has no production counterpart: the roads source was dropped in the
// Cloudflare migration, and its corpus cases are kept as a regression check on
// the models' relevance judgement.

export { OUTAGE_AI_PROMPT, VT_AI_PROMPT } from "../../src/shared/constants.ts";
export { OUTAGE_JSON_SCHEMA as OUTAGE_SCHEMA, VT_JSON_SCHEMA as VT_SCHEMA } from "../../src/shared/schemas.ts";

export const ROADS_AI_PROMPT = `You are a system that outputs strictly valid JSON.

## Task
You will receive a news article in Bulgarian from the Bulgarian Road
Infrastructure Agency (АПИ). Decide whether it is relevant to drivers in
or around the city of Varna, and summarize it.

An article is relevant ONLY if it describes road works, road closures,
traffic restrictions or changed traffic organization that affect:
- roads inside област Варна (Varna province), or
- major routes to/from Varna (АМ "Хемус", път I-9, път I-2, ...).

Articles about other provinces, tolls, tenders, policy or statistics are
NOT relevant, even if they mention Varna in passing (e.g. "посока Варна"
for a road section in another province is NOT relevant).

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "is_relevant": bool,
    "summary": string
}

The "summary" must be 1-2 sentences in Bulgarian stating WHERE, WHEN and
WHAT is restricted. If the article is not relevant, use null.

## Constraints
- Do not add extra fields.
- Ensure the JSON is syntactically valid.
`;


export const ROADS_SCHEMA = {
  type: "object",
  properties: {
    is_relevant: { type: "boolean" },
    summary: { type: ["string", "null"] },
  },
  required: ["is_relevant", "summary"],
};
