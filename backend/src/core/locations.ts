// The location model the alert service is built on (docs/specification.md §1.5):
// the stored DTO, reading a location in either of its shapes, its polygon
// geometry, and which settlement it is in. Shared by targeting
// (alert-service.ts), enrichment (enrichment.ts) and the polygon build
// (ingestion/pipeline.ts), so that "which settlement is this in" has one answer.

import type * as q from "../db/queries";
import type { Ring } from "./geo";
import { matchRegion, parseName, placeClass } from "./place-names";

export interface AlertLocationDTO {
  /** The settlement slot (schemas.ts): "гр. Варна", "с. Аврен", or null. */
  settlement: string | null;
  /** The area inside it — "кв. Виница", "м-т Ваялар" — or null. */
  area: string | null;
  /**
   * Derived display fields, kept because the shipped app reads them
   * (frontend/src/services/api.ts) and every alert stored before the three-slot
   * split holds this pair inside locations_json. `location_name` is the most
   * specific place named, which is what the flat schema always meant by it, so
   * old rows and old clients keep rendering unchanged.
   */
  location_name: string;
  sublocations: string[];
  is_polygon: boolean;
  /** Set when the message hedged ("в района на …") and the streets below were
   *  used to locate the area rather than to bound it (normalize.ts A6). Display
   *  is unchanged; this records why targeting was region-wide. */
  region_wide?: boolean;
  /**
   * A polygon was asked for and the build produced none.
   *
   * `is_polygon` has to be cleared in that case — every reader downstream treats
   * it as "there is geometry here", and targeting an empty ring notifies nobody
   * — but clearing it alone erased the fact that a block was ever requested. The
   * stored row then read exactly like a message that never mentioned one, which
   * is how the 08.08.2026 review came to blame the AI for four failures the
   * deterministic A2 guard had gotten right: 252 of 252 stored locations carried
   * `is_polygon: false`, and nothing distinguished the two populations.
   *
   * Rides inside `locations_json`, so it needs no migration, and it is what
   * makes the review tool's `polygon flagged, no geometry` badge reachable.
   */
  polygon_failed?: boolean;
  /** Why the build failed, from BlockPolygonResult.reason — "only 2/4 street
   *  names resolved", "the streets enclose no block". Paired with the flag
   *  above so a reviewer gets the cause, not just the fact. */
  polygon_failure?: string;
  polygon_geojson?: unknown; // bare GeoJSON Polygon geometry
  lat?: number;
  lng?: number;
  /**
   * WHERE the coordinate came from — the same blind spot `polygon_failed` was
   * invented to fix, and the same fix.
   *
   * 37 of 783 locations in the 08.2026 review (4.7%) were positionally wrong or
   * unlocated and nothing on the row said so: a settlement-centroid fallback is
   * byte-identical to a genuine city-centre location, so "how often are we
   * guessing" could only be answered by a manual audit.
   *
   *   `seed`       a seeded region/street centroid — deterministic, ours
   *   `nominatim`  an external lookup that answered, and passed `plausible`
   *   `settlement` NOTHING specific resolved; this is the settlement centroid,
   *                which is a coarse pin standing in for a place we lost
   *   `none`       no coordinate at all
   *
   * Rides inside `locations_json`, so it needs no migration, and it turns the
   * question into a SELECT and gives the review tool a badge. Seeding the names
   * that currently miss would remove most of today's fallbacks but not the
   * class — the next unseeded name falls back just as silently.
   */
  coords_source?: "seed" | "nominatim" | "settlement" | "none";
}

export type Json = Record<string, unknown>;

export const asObject = (v: unknown): Json | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

// ── Polygon geometry handling ─────────────────────────────────────────────────

/** Returns the Polygon geometry from either a FeatureCollection, or a bare geometry. */
export function extractPolygonGeometry(location: Json): Json | null {
  const poly = asObject(location.polygon_geojson);
  if (!poly) return null;

  if ("coordinates" in poly) return poly;

  const features = poly.features;
  if (Array.isArray(features) && features.length > 0) {
    const geometry = asObject(asObject(features[0])?.geometry);
    if (geometry && "coordinates" in geometry) return geometry;
  }
  return null;
}

/** Outer ring of a GeoJSON Polygon geometry as [lng, lat] pairs, or null. */
export function outerRing(geometry: Json): Ring | null {
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0])) return null;
  const ring: Ring = [];
  for (const coord of coordinates[0] as unknown[]) {
    if (!Array.isArray(coord) || typeof coord[0] !== "number" || typeof coord[1] !== "number")
      return null;
    ring.push([coord[0], coord[1]]);
  }
  return ring;
}

// ── Reading a location ────────────────────────────────────────────────────────

/** One location's three slots, plus the A6 marker. */
export interface LocationSlots {
  settlement: string | null;
  area: string | null;
  streets: string[];
  region_wide: boolean;
}

/**
 * Read a location in either shape.
 *
 * Targeting runs on whatever the caller sent: the crawler hands over
 * normalize.ts's three slots, but /api/alerts/submit-data passes
 * `processed_data.locations` straight through (api/alerts.ts), so the flat
 * (location_name, sublocations) pair is still a live input and not merely a
 * historical one. It maps on without a guess — a flat `location_name` was the
 * most specific place the message named, which is what `area` is.
 */
export function readLocation(location: Json): LocationSlots {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;

  const hasSlots = "settlement" in location || "area" in location;
  return {
    settlement: hasSlots ? str(location.settlement) : null,
    area: hasSlots ? str(location.area) : str(location.location_name),
    // `sublocations` is also the fallback for an enriched DTO fed back in, which
    // carries the slots but keeps its street list under the display name.
    streets: list(location.streets) ?? list(location.sublocations) ?? [],
    region_wide: location.region_wide === true,
  };
}

// ── Settlement scope ──────────────────────────────────────────────────────────

/**
 * The city every source we crawl is written against, and so the scope for any
 * location we cannot place in a settlement of its own.
 */
export const DEFAULT_SETTLEMENT = "Варна";

/**
 * The settlement a name sits in, from the written kind alone.
 *
 * A "гр." or "с." names a settlement in its own right, so it *is* the scope —
 * Долни чифлик is not inside Варна, and scoping it there is what sent an
 * unseeded village street to a like-named street in the city. Everything else
 * (кв., ж.к., м-т, к.к., or a bare name we cannot classify) keeps the Варна
 * scope the sources are written against.
 *
 * All the schema could answer before migration 0016, and still the answer for a
 * region we hold no parent link for — see settlementScope.
 */
export function settlementOf(locationName: string): string {
  const { kind, core } = parseName(locationName);
  const cls = placeClass(kind);
  return (cls === "city" || cls === "village") && core ? core : DEFAULT_SETTLEMENT;
}

/**
 * The regions row for a location's settlement — the scope its street lookups
 * take (`streets.region_id`, migration 0015).
 *
 * Deliberately not the same thing as the `region` a location matches. For
 * "кв. Виница" the region is the district and the settlement is Варна; only the
 * latter can scope a street, because `streets.region_id` always points at a
 * settlement-class region and never at a district.
 *
 * Both slots are offered because either can carry the answer: the settlement
 * slot when the message stated one, the area slot when it named only a district
 * and migration 0016 knows which settlement that district is in. The link is
 * what makes "ж.к. Младост (Белослав)" scope to Белослав — the written kind
 * cannot, and answering Варна for it is a district of the wrong town.
 *
 * A region with no link falls back to the written kind, which is exactly the
 * pre-0016 behaviour: unlinked data cannot tell a district from a settlement
 * (both have a NULL parent), so the guess stays the conservative one.
 *
 * Null means we could not place the location in any settlement we know, and
 * every caller treats that as "no street lookup is possible here" rather than
 * as "search everywhere".
 *
 * Shared by targeting, enrichment and ingestion/pipeline.ts, which needs the
 * same answer to scope a polygon build. Two spellings of "which settlement is
 * this in" would drift, and the polygon path's whole problem was that it had no
 * answer at all.
 */
export function settlementScope(
  settlement: string | null, area: string | null, regions: readonly q.NamedRow[],
): q.NamedRow | null {
  for (const name of [settlement, area]) {
    if (name === null) continue;

    // A written "гр."/"с." names a settlement in its own right, so it IS the
    // scope and the parent-link branch below must not get to it first. That
    // ordering is what §1.2 actually turned on: Варна province holds two places
    // called Припек 10 km apart — the village, and a suburb of Константиново —
    // and an unscoped `matchRegion("с. Припек")` can land on either. Landing on
    // the suburb used to mean following its parent link and answering with
    // Константиново's centroid, which is how two alerts came to pin a village
    // 1.7 km off. A name that states its own settlement kind is never a district
    // of something else, so resolve it as a settlement first.
    //
    // Settlement-class rows only, for the reason below: since migration 0017 a
    // district may carry the same name, and resolving to it would hand
    // `matchStreet` a district id as its scope — `streets.region_id` never
    // points at a district (0015), so every street lookup under it would
    // silently find nothing.
    const written = settlementOf(name);
    if (written !== DEFAULT_SETTLEMENT) {
      const scope = matchRegion(written, regions, undefined, null);
      // §3.4: a settlement the seed does not hold. The street path is gated on a
      // non-null scope — rightly, since an unscoped street match is what used to
      // notify Varna about a Долни чифлик outage — so unless the area itself
      // matches a region, this location's audience is exactly zero. ViK publishes
      // for the whole province, and nothing said a word about it.
      if (scope === null) {
        console.warn(
          `[targeting] No seeded settlement for "${name}" — no street lookup is `
          + `possible, so this location can only be reached by its area.`);
      }
      return scope;
    }

    // No settlement kind was written, so this is a district (or a bare name we
    // cannot classify). Migration 0016's link is what says which settlement it
    // sits in — the written kind cannot, and answering Варна for "ж.к. Младост
    // (Белослав)" is a district of the wrong town.
    const row = matchRegion(name, regions);
    if (row && row.settlement_id !== null && row.settlement_id !== undefined) {
      const parent = regions.find((r) => r.id === row.settlement_id);
      if (parent) return parent;
    }
  }
  return matchRegion(DEFAULT_SETTLEMENT, regions, undefined, null);
}
