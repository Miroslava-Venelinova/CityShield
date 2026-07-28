// AI output schemas (SPEC.md §1.8). Two layers per source, same trick as
// Pydantic's SkipJsonSchema: the JSON schema sent to Workers AI as the
// constrained-decoding target (validated against the live models in the
// Phase 0 eval — keep byte-identical), and the zod schema used as the
// post-parse backstop. polygon_geojson / bus_lines are filled in
// programmatically and never shown to the model.

import { z } from "zod";
import type { AlertWindows } from "./datetime";

// ── Outage sources (vik, epro, heating) ──────────────────────────────────────
// Times come back as a `schedule` object — a date range plus the clock windows
// that repeat inside it — rather than a flat start/end pair. Asking for both a
// schedule and a pair invites the model to contradict itself, so the pair is
// derived from the schedule by normalizeSchedule() instead (shared/datetime.ts),
// which is also where every field is coerced or rejected. The zod/JSON layers
// stay deliberately lenient so a malformed clock never rejects a whole parse.

export const OUTAGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          location_name: { type: ["string", "null"] },
          sublocations: { type: "array", items: { type: "string" } },
          is_polygon: { type: "boolean" },
        },
        required: ["location_name", "sublocations", "is_polygon"],
      },
    },
    schedule: {
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
    },
    city_wide: { type: "boolean" },
  },
  required: ["locations", "schedule", "city_wide"],
} as const;

export const outageAiSchema = z.object({
  locations: z.array(z.object({
    location_name: z.string().nullable().default(null),
    sublocations: z.array(z.string()).default([]),
    is_polygon: z.boolean().default(false),
  })).default([]),
  schedule: z.object({
    from_date: z.string().nullable().default(null),
    to_date: z.string().nullable().default(null),
    windows: z.array(z.object({
      start: z.string().nullable().default(null),
      end: z.string().nullable().default(null),
    })).default([]),
  }).default({ from_date: null, to_date: null, windows: [] }),
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

export const VT_JSON_SCHEMA = {
  type: "object",
  properties: {
    bus_lines: { type: ["array", "null"], items: { type: "string" } },
  },
  required: ["bus_lines"],
} as const;

export const vtAiSchema = z.object({
  bus_lines: z.array(z.string()).nullable().default(null),
});
