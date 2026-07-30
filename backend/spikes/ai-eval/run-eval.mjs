// Workers AI eval: replay the corpus through the candidate models with the
// production prompts + JSON-schema mode, grade against expected outputs, report
// per-model regressions.
//
// Started as Phase 0's model-selection spike, where the point was to grade the
// models against an untouched prompt. It is now also how a prompt CHANGE is
// measured (SPEC.md §1.8) — so prompts.mjs re-exports the real constants
// rather than copying them, and the grader normalizes times through the real
// normalizeSchedule.
//
// Two transports:
//   1. Direct REST: set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
//   2. Proxy Worker (spikes/ai-eval/worker): set EVAL_WORKER_URL + EVAL_TOKEN
//
// Usage: node run-eval.mjs [modelId ...]   (default: all CANDIDATES)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  OUTAGE_AI_PROMPT, ROADS_AI_PROMPT, VT_AI_PROMPT,
  OUTAGE_SCHEMA, ROADS_SCHEMA, VT_SCHEMA,
} from "./prompts.mjs";
// The production normalizer, so times are graded on what would be stored.
import { normalizeSchedule } from "../../src/shared/datetime.ts";

// Verified against the live catalog (list-models.mjs, July 2026):
// llama-3.1-8b-instruct was deprecated 2026-05-30 → fp8 variant instead.
const CANDIDATES = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/qwen/qwen3-30b-a3b-fp8",
];

const KINDS = {
  outage: { system: OUTAGE_AI_PROMPT, schema: OUTAGE_SCHEMA },
  roads: { system: ROADS_AI_PROMPT, schema: ROADS_SCHEMA },
  vt: { system: VT_AI_PROMPT, schema: VT_SCHEMA },
};

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf-8"));
// Pinned in the corpus and repeated in every outage input's CURRENT_DATE line,
// so a case that relies on the default date grades the same on any day.
const CURRENT_DATE = corpus.current_date;
const models = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES;

// --- transport --------------------------------------------------------------

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, EVAL_WORKER_URL, EVAL_TOKEN } = process.env;

// Reasoning models (qwen3) burn most of the default 2000-token budget on thinking
// before emitting JSON — production ai.ts must set the same headroom.
const MAX_TOKENS = Number(process.env.EVAL_MAX_TOKENS ?? 8000);

async function aiRun(model, messages, response_format) {
  if (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages, response_format, max_tokens: MAX_TOKENS }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    const data = await res.json();
    if (!data.success) throw new Error(`REST error: ${JSON.stringify(data.errors).slice(0, 300)}`);
    return data.result;
  }
  if (EVAL_WORKER_URL && EVAL_TOKEN) {
    const res = await fetch(EVAL_WORKER_URL, {
      method: "POST",
      headers: { "x-eval-token": EVAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, response_format, max_tokens: MAX_TOKENS }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`worker error: ${String(data.error).slice(0, 300)}`);
    return data.res;
  }
  throw new Error("No transport configured: set CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_API_TOKEN or EVAL_WORKER_URL+EVAL_TOKEN");
}

// --- grading ----------------------------------------------------------------

// BusLineCatalog.Normalize parity: uppercase + Cyrillic look-alikes → Latin.
const CYR = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Б: "B" };
const normLine = (s) => String(s).trim().toUpperCase().replace(/[АВЕКМНОРСТХБ]/g, (c) => CYR[c]);
const normText = (s) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, " ").trim());

function gradeOutage(testCase, actual) {
  const { expected, lenient = {}, forbidden_location_names: forbidden = [] } = testCase;
  const diffs = [];
  if (typeof actual !== "object" || actual === null) return ["output is not an object"];
  const expLocs = expected.locations ?? [];
  const actLocs = Array.isArray(actual.locations) ? actual.locations : [];

  // A non-place emitted as a location fails the case regardless of the rest:
  // that is exactly what the deterministic guards then have to clean up, and
  // what these prompt rules exist to prevent.
  const banned = forbidden.map(normText);
  for (const l of actLocs) {
    if (banned.includes(normText(l.location_name))) {
      diffs.push(`location_name: "${l.location_name}" is not a place`);
    }
  }

  if (expLocs.length !== actLocs.length) {
    diffs.push(`locations count: expected ${expLocs.length}, got ${actLocs.length}`);
  } else {
    const key = (l) => [normText(l.location_name), ...(l.sublocations ?? []).map(normText).sort()].join("|") + `|poly:${!!l.is_polygon}`;
    const keyNoName = (l) => (l.sublocations ?? []).map(normText).sort().join("|") + `|poly:${!!l.is_polygon}`;
    const useKey = lenient.location_name ? keyNoName : key;
    const exp = expLocs.map(useKey).sort();
    const act = actLocs.map(useKey).sort();
    if (JSON.stringify(exp) !== JSON.stringify(act)) diffs.push(`locations: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`);
  }

  // Times are graded on what the pipeline would STORE, not on the strings the
  // model wrote: normalizeSchedule is what turns the schedule into the envelope
  // plus windows, and "8:00" vs "08:00" is not a difference worth failing on.
  diffs.push(...gradeSchedule(expected.schedule, actual.schedule));

  if (Boolean(expected.city_wide) !== Boolean(actual.city_wide)) {
    diffs.push(`city_wide: expected ${expected.city_wide}, got ${actual.city_wide}`);
  }
  return diffs;
}

function gradeRoads({ expected }, actual) {
  const diffs = [];
  if (typeof actual !== "object" || actual === null) return ["output is not an object"];
  if (Boolean(expected.is_relevant) !== Boolean(actual.is_relevant)) {
    diffs.push(`is_relevant: expected ${expected.is_relevant}, got ${actual.is_relevant}`);
  }
  if (expected.is_relevant && expected.summary_nonempty && !normText(actual.summary)) {
    diffs.push("summary: expected non-empty Bulgarian summary, got empty/null");
  }
  return diffs;
}

function gradeVt({ expected }, actual) {
  if (typeof actual !== "object" || actual === null) return ["output is not an object"];
  const diffs = [];
  const exp = expected.bus_lines;
  const act = actual.bus_lines;
  if (exp === null) {
    if (!(act === null || act === undefined)) diffs.push(`bus_lines: expected null, got ${JSON.stringify(act)}`);
  } else if (!Array.isArray(act)) {
    diffs.push(`bus_lines: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`);
  } else {
    const a = exp.map(normLine).sort();
    const b = act.map(normLine).sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`bus_lines: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
    }
  }

  // vt gained a schedule when the 30.07.2026 review found route changes going
  // out with no period at all. Graded the same way the outage sources are: on
  // what the pipeline would STORE, so "9:00" vs "09:00" is not a failure.
  diffs.push(...gradeSchedule(expected.schedule, actual.schedule));
  return diffs;
}

/** Envelope + windows the pipeline would store, compared field by field. */
function gradeSchedule(expectedSchedule, actualSchedule) {
  const diffs = [];
  const want = normalizeSchedule(expectedSchedule, CURRENT_DATE);
  const got = normalizeSchedule(actualSchedule, CURRENT_DATE);
  for (const f of ["start_time", "end_time"]) {
    if (want[f] !== got[f]) diffs.push(`${f}: expected ${want[f]}, got ${got[f]}`);
  }
  if (JSON.stringify(want.windows) !== JSON.stringify(got.windows)) {
    diffs.push(`windows: expected ${JSON.stringify(want.windows)}, got ${JSON.stringify(got.windows)}`);
  }
  return diffs;
}

const GRADERS = { outage: gradeOutage, roads: gradeRoads, vt: gradeVt };

// --- run --------------------------------------------------------------------

function extractJson(res) {
  // Workers AI JSON mode may return the object directly in `response`, or a string.
  const raw = res?.response ?? res;
  if (typeof raw === "object" && raw !== null) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const report = { ranAt: new Date().toISOString(), models: {} };

for (const model of models) {
  console.log(`\n===== ${model} =====`);
  const entry = { cases: {}, passed: 0, failed: 0, errors: 0 };
  report.models[model] = entry;

  for (const testCase of corpus.cases) {
    const kind = KINDS[testCase.kind];
    const messages = [
      { role: "system", content: kind.system },
      { role: "user", content: testCase.input },
    ];
    let outcome;
    try {
      const res = await aiRun(model, messages, { type: "json_schema", json_schema: kind.schema });
      const parsed = extractJson(res);
      if (parsed === null) {
        outcome = { status: "error", detail: `unparseable output: ${JSON.stringify(res).slice(0, 200)}` };
        entry.errors++;
      } else {
        const diffs = GRADERS[testCase.kind](testCase, parsed);
        if (diffs.length === 0) {
          outcome = { status: "pass", output: parsed };
          entry.passed++;
        } else {
          outcome = { status: "fail", diffs, output: parsed };
          entry.failed++;
        }
      }
    } catch (err) {
      outcome = { status: "error", detail: String(err).slice(0, 300) };
      entry.errors++;
    }
    entry.cases[testCase.id] = outcome;
    const mark = outcome.status === "pass" ? "PASS" : outcome.status === "fail" ? "FAIL" : "ERR ";
    console.log(`  [${mark}] ${testCase.id}${outcome.diffs ? " — " + outcome.diffs.join("; ") : ""}${outcome.detail ? " — " + outcome.detail : ""}`);
  }
  console.log(`  => ${entry.passed} pass / ${entry.failed} fail / ${entry.errors} error of ${corpus.cases.length}`);
}

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
const outFile = new URL(`./out/eval-${Date.now()}.json`, import.meta.url);
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nFull report: ${outFile.pathname}`);
