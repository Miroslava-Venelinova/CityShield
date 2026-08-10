// AI output schemas (SPEC.md §1.8). Two layers per source, same trick as
// Pydantic's SkipJsonSchema: the JSON schema sent to Workers AI as the
// constrained-decoding target, and the zod schema used as the post-parse
// backstop. polygon_geojson / bus_lines are filled in programmatically and
// never shown to the model.
//
// What the Phase 0 eval established is that the live models' constrained
// decoder handles the *constructs* used here — `["string","null"]`, an array of
// `string`, a `boolean` — not that these exact bytes are load-bearing. (It read
// "keep byte-identical" until the location split, which added another property
// of an already-proven kind and no new construct.) Any change here is
// re-validated by spikes/ai-eval/run-eval.mjs, which imports these constants
// directly: 3 runs × 3 candidate models, compared per case id.

import { z } from "zod";
import type { AlertWindows } from "./datetime";

// ── Outage sources (vik, epro, heating) ──────────────────────────────────────
// Times come back as a `schedule` object — a date range plus the clock windows
// that repeat inside it — rather than a flat start/end pair. Asking for both a
// schedule and a pair invites the model to contradict itself, so the pair is
// derived from the schedule by normalizeSchedule() instead (shared/datetime.ts),
// which is also where every field is coerced or rejected. The zod/JSON layers
// stay deliberately lenient so a malformed clock never rejects a whole parse.

/**
 * The `schedule` object, shared by every source that states a time.
 *
 * Extracted rather than copied when vt gained times: a route change is
 * published with the same "from this date to that date, these hours each day"
 * shape an outage is, and `normalizeSchedule` is one function — two spellings
 * of the contract feeding it would only drift. Structurally identical to the
 * literal it replaced, so the JSON handed to the model is unchanged.
 */
const SCHEDULE_JSON_SCHEMA = {
  type: "object",
  properties: {
    from_date: { type: ["string", "null"] },
    to_date: { type: ["string", "null"] },
    windows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: ["string", "null"] },
          end: { type: ["string", "null"] },
        },
        required: ["start", "end"],
      },
    },
  },
  required: ["from_date", "to_date", "windows"],
} as const;

const scheduleAiSchema = z.object({
  from_date: z.string().nullable().default(null),
  to_date: z.string().nullable().default(null),
  windows: z.array(z.object({
    start: z.string().nullable().default(null),
    end: z.string().nullable().default(null),
  })).default([]),
}).default({ from_date: null, to_date: null, windows: [] });

// One entry is one place, in three slots: the settlement, the area inside it,
// and the streets inside that. It replaced a flat (location_name, sublocations)
// pair, where a city district and a village occupied the same field — so
// "гр. Варна - кв. Виница, ул. A, ул. B" had nowhere to put the city, the model
// pushed the district into the street array, and normalize.ts had to
// reconstruct the missing level by reading the order the source listed things
// in. The slots are independently nullable, so a region-only alert is just
// {settlement, null, []} and needs no separate shape.
//
// Deliberately flat rather than nested (`areas: [{name, streets}]`): every entry
// resolves to exactly one audience and one map pin, and nesting would push that
// two-level structure through targeting, enrichment and the app's map. Several
// districts in one city are several entries repeating the settlement.
export const OUTAGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          settlement: { type: ["string", "null"] },
          area: { type: ["string", "null"] },
          streets: { type: "array", items: { type: "string" } },
          is_polygon: { type: "boolean" },
        },
        required: ["settlement", "area", "streets", "is_polygon"],
      },
    },
    schedule: SCHEDULE_JSON_SCHEMA,
    city_wide: { type: "boolean" },
  },
  required: ["locations", "schedule", "city_wide"],
} as const;

export const outageAiSchema = z.object({
  locations: z.array(z.object({
    settlement: z.string().nullable().default(null),
    area: z.string().nullable().default(null),
    streets: z.array(z.string()).default([]),
    is_polygon: z.boolean().default(false),
  })).default([]),
  schedule: scheduleAiSchema,
  city_wide: z.boolean().default(false),
});

export type OutageAiOutput = z.infer<typeof outageAiSchema>;

/**
 * What the pipeline hands the alert service: the model's locations enriched
 * with polygons, plus the normalized times (SkipJsonSchema fields — never shown
 * to the model).
 */
export interface ProcessedData {
  locations: Array<OutageAiOutput["locations"][number] & {
    polygon_geojson?: unknown;
    /** Set by normalize.ts when the message hedges ("в района на …"): the street
     *  list says where the area is, not who is in it. See A6. */
    region_wide?: boolean;
    /** Why `buildPolygonForStreets` returned nothing, when `is_polygon` was set
     *  and no geometry came back. Carried into the stored DTO so a build failure
     *  stops being indistinguishable from a message that never wanted a block —
     *  see AlertLocationDTO.polygon_failed. */
    polygon_failure?: string;
  }>;
  city_wide: boolean;
  /** Envelope derived from the schedule; what every legacy reader still uses. */
  start_time: string | null;
  end_time: string | null;
  /** The detail the envelope loses — null unless there is any (migration 0012). */
  windows: AlertWindows | null;
  bus_lines?: string[] | null;
}

// ── VT (bus route changes) ───────────────────────────────────────────────────

// A route change runs for a period the same way an outage does ("от 01.08 до
// 15.08, от 09:00 до 17:00"), and the feed showed it with no time at all — the
// 30.07.2026 review flagged that. Same `schedule` contract, same
// normalizeSchedule on the way out; only `locations` is meaningless here,
// because a route change has no address.
export const VT_JSON_SCHEMA = {
  type: "object",
  properties: {
    bus_lines: { type: ["array", "null"], items: { type: "string" } },
    schedule: SCHEDULE_JSON_SCHEMA,
  },
  required: ["bus_lines", "schedule"],
} as const;

export const vtAiSchema = z.object({
  bus_lines: z.array(z.string()).nullable().default(null),
  schedule: scheduleAiSchema,
});
