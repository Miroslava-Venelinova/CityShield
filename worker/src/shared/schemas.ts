// AI output schemas (PLAN.MD §1.8). Two layers per source, same trick as
// Pydantic's SkipJsonSchema: the JSON schema sent to Workers AI as the
// constrained-decoding target (validated against the live models in the
// Phase 0 eval — keep byte-identical), and the zod schema used as the
// post-parse backstop. polygon_geojson / bus_lines are filled in
// programmatically and never shown to the model.

import { z } from "zod";

// ── Outage sources (vik, epro, heating) ──────────────────────────────────────

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
    start_time: { type: ["string", "null"] },
    end_time: { type: ["string", "null"] },
    city_wide: { type: "boolean" },
  },
  required: ["locations", "start_time", "end_time", "city_wide"],
} as const;

export const outageAiSchema = z.object({
  locations: z.array(z.object({
    location_name: z.string().nullable().default(null),
    sublocations: z.array(z.string()).default([]),
    is_polygon: z.boolean().default(false),
  })).default([]),
  start_time: z.string().nullable().default(null),
  end_time: z.string().nullable().default(null),
  city_wide: z.boolean().default(false),
});

export type OutageAiOutput = z.infer<typeof outageAiSchema>;

/** The widened shape the pipeline hands to the alert service (SkipJsonSchema fields added). */
export interface ProcessedData extends Omit<OutageAiOutput, "locations"> {
  locations: Array<OutageAiOutput["locations"][number] & { polygon_geojson?: unknown }>;
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

export type VtAiOutput = z.infer<typeof vtAiSchema>;

// ── Roads (АПИ news relevance) ───────────────────────────────────────────────

export const ROADS_JSON_SCHEMA = {
  type: "object",
  properties: {
    is_relevant: { type: "boolean" },
    summary: { type: ["string", "null"] },
  },
  required: ["is_relevant", "summary"],
} as const;

export const roadsAiSchema = z.object({
  is_relevant: z.boolean().default(false),
  summary: z.string().nullable().default(null),
});

export type RoadsAiOutput = z.infer<typeof roadsAiSchema>;
