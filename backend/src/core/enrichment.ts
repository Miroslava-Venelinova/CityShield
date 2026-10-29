// Location enrichment (docs/specification.md §1.5): give every stored location
// a coordinate, from our own seeded rows first and Nominatim second, and judge
// every Nominatim answer against the settlement it was asked about (§2.5).

import * as q from "../db/queries";
import type { Env } from "../env";
import { ringCentroid, distanceKm } from "./geo";
import { buildGeocodeQuery, geocode, type GeocodeHit, type GeoPoint } from "./geocoding";
import {
  type AlertLocationDTO, asObject, extractPolygonGeometry, outerRing, readLocation,
  settlementOf, settlementScope,
} from "./locations";
import { matchRegion, matchStreet, parseName } from "./place-names";

// ── Location enrichment ───────────────────────────────────────────────────────

/**
 * Converts the raw scraper locations into DTOs carrying coordinates: polygon
 * locations get their centroid, everything else is resolved by fuzzy-matching
 * names against the regions/streets tables and forward-geocoding the
 * canonical name via Nominatim. Never throws — an alert without coordinates
 * is still worth storing.
 */
export async function enrichLocations(
  env: Env, locations: unknown, deadline?: number,
): Promise<AlertLocationDTO[]> {
  const result: AlertLocationDTO[] = [];
  if (!Array.isArray(locations)) return result;

  for (const raw of locations) {
    const location = asObject(raw);
    if (!location) continue;

    const slots = readLocation(location);
    const dto: AlertLocationDTO = {
      settlement: slots.settlement,
      area: slots.area,
      // The display pair, derived: the most specific place named, and the
      // streets under it. Byte-identical to what the flat schema stored for
      // every shape it could express.
      location_name: slots.area ?? slots.settlement ?? "",
      sublocations: slots.streets,
      is_polygon: location.is_polygon === true,
    };
    if (slots.region_wide) dto.region_wide = true;

    // Normalize the polygon to a bare GeoJSON geometry — the scraper sends a
    // FeatureCollection, the app expects {type, coordinates}.
    const geometry = extractPolygonGeometry(location);
    if (geometry) {
      dto.polygon_geojson = geometry;
      const ring = outerRing(geometry);
      const centroid = ring ? ringCentroid(ring) : null;
      if (centroid) {
        dto.lat = centroid.lat;
        dto.lng = centroid.lng;
      }
    } else {
      // `is_polygon` still has to go: getUserIdsInPolygonRange would target an
      // empty ring, and every downstream reader takes the flag as a promise that
      // geometry is present. What must NOT go with it is the fact that a block
      // was asked for — see AlertLocationDTO.polygon_failed.
      if (dto.is_polygon) {
        dto.polygon_failed = true;
        const why = typeof location.polygon_failure === "string" ? location.polygon_failure : null;
        if (why) dto.polygon_failure = why;
        console.warn(
          `[polygon] requested but not built for "${dto.location_name}" `
          + `[${dto.sublocations.join(", ")}]${why ? `: ${why}` : ""}`);
      }
      dto.is_polygon = false;
      const located = await resolveCoordinates(env, dto, deadline);
      dto.coords_source = located.source;
      if (located.point) {
        dto.lat = located.point.lat;
        dto.lng = located.point.lng;
      }
    }

    result.push(dto);
  }

  return result;
}

/**
 * The name to hand Nominatim when our own tables did not recognise it.
 *
 * Nominatim indexes places by their plain name, so the written kind is noise
 * that costs matches — and `parseName` knows every spelling the sources use,
 * where the old hardcoded prefix list only knew the canonical eight.
 */
function geocodableName(name: string): string {
  const { core } = parseName(name);
  return core || name.trim();
}

// ── Geocode plausibility (§2.5) ──────────────────────────────────────────────

/**
 * The radius a settlement's own places must fall inside, derived from the
 * settlement's own seeded streets.
 *
 * A single global number cannot do this job, and the seed data says why. Varna's
 * 1,333 streets sit at a median of 3.5 km from its centroid with a 95th
 * percentile of 10.7 km — the city really is that big. Долни чифлик's 42 streets
 * all lie within 1.2 km. Nominatim answered "ул. Синчец, Долни чифлик" with a
 * point 6.4 km east of the town (alert 803a51e4, still in geocode_cache), and
 * there is no constant that rejects 6.4 km while keeping Varna's legitimate
 * 10.7 — so the threshold has to be the settlement's own extent.
 *
 * The 95th percentile rather than the maximum, because a maximum is one bad row
 * away from useless: Varna's farthest "own" street is currently 58 km out (§1.1),
 * and a max-based radius would wave the whole province through. A quarter's
 * margin on top, so a legitimate street just past the ones we happen to have
 * seeded is not rejected.
 *
 * The floor is what makes it safe on thin data — с. Аврен has exactly one seeded
 * street, and its extent is not 0.9 km. Fails open by design: a settlement with
 * no seeded streets at all gets the floor, and the check can only ever reject an
 * answer that is further out than the town plausibly reaches.
 */
const SETTLEMENT_EXTENT_PERCENTILE = 0.95;
const SETTLEMENT_EXTENT_MARGIN = 1.25;
const SETTLEMENT_EXTENT_MIN_KM = 2;

/**
 * Memoized per (streets array, settlement id). The streets array is the 6-hour
 * module-scope ref cache, so the WeakMap drops every extent when the rows behind
 * them turn over — the same keying `prepare` and `candidateGrams` use, and for
 * the same 10 ms budget.
 */
const extents = new WeakMap<object, Map<number, number>>();

function settlementExtentKm(scope: q.NamedRow, streets: readonly q.NamedRow[]): number {
  if (scope.lat === null || scope.lng === null) return SETTLEMENT_EXTENT_MIN_KM;
  let memo = extents.get(streets as object);
  if (!memo) {
    memo = new Map();
    extents.set(streets as object, memo);
  }
  const cached = memo.get(scope.id);
  if (cached !== undefined) return cached;

  const distances: number[] = [];
  for (const s of streets) {
    if (s.region_id !== scope.id || s.lat === null || s.lng === null) continue;
    distances.push(distanceKm(scope.lat, scope.lng, s.lat, s.lng));
  }
  distances.sort((a, b) => a - b);
  const p = distances.length === 0
    ? 0
    : distances[Math.min(distances.length - 1,
      Math.floor(distances.length * SETTLEMENT_EXTENT_PERCENTILE))]!;
  const km = Math.max(SETTLEMENT_EXTENT_MIN_KM, p * SETTLEMENT_EXTENT_MARGIN);
  memo.set(scope.id, km);
  return km;
}

/**
 * A geocoded point, or null when it cannot plausibly be in the settlement it was
 * looked up inside.
 *
 * Nothing used to compare a Nominatim answer against the place it was anchored
 * to, so a confident wrong answer was accepted and — because misses are cached
 * too — kept. Rejecting it lets `resolveCoordinates` try the next candidate and
 * ultimately the settlement centroid, which is a coarse pin rather than a wrong
 * one. The rejection is logged: an anchor that keeps failing is a `region_aliases`
 * row waiting to be written, and it can only be noticed if it is said out loud.
 * The Photon fallback's answers pass through the same check.
 */
function plausible(
  point: GeocodeHit | null, scope: q.NamedRow | null, streets: readonly q.NamedRow[], what: string,
): GeocodeHit | null {
  if (point === null || scope === null || scope.lat === null || scope.lng === null) return point;
  const limit = settlementExtentKm(scope, streets);
  const km = distanceKm(point.lat, point.lng, scope.lat, scope.lng);
  if (km <= limit) return point;
  console.warn(
    `[geocode] rejected '${what}' — ${point.provider} answered ${km.toFixed(1)} km from `
    + `${scope.name}, past its ${limit.toFixed(1)} km extent.`);
  return null;
}

/**
 * The seeded centroid for a matched reference row, when it has one.
 *
 * Reference rows carry coordinates since migration 0005, so a name we already
 * recognize needs no network call at all — which keeps Nominatim's 1,100 ms
 * throttle and 8 s timeout off the ingest deadline budget on the common path.
 * A row seeded before the coordinates existed returns null and falls through
 * to Nominatim exactly as before.
 */
function seededPoint(row: q.NamedRow | null): GeoPoint | null {
  return row && row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null;
}

/**
 * Geocoding strategy: canonicalize names against
 * our own DB first (trigram fuzzy match), then ask Nominatim.
 *
 * Area-first for the pin: when a location names a district/locality it usually
 * lists several streets within it, and dropping the pin on one of them reads as
 * "the outage is here" when it spans the whole area — so the region centroid is
 * the better marker. Streets are only used when no area was given (or the named
 * area resolves to nothing). This is the pin only; notification targeting stays
 * street-first — see getUserIdsInRange.
 *
 * The settlement is the LAST resort, below the streets, and that ordering is
 * what keeps the three-slot split from moving every pin. Under the flat schema
 * a street-only city alert arrived with location_name "" and went straight to
 * its streets; now the city is stated on every entry, so pinning the settlement
 * at step 1 would answer "гр. Варна, ул. Дубровник" with the city centre. A
 * street inside the named settlement is strictly the better marker, and falling
 * back to the settlement centroid still beats no pin at all.
 */
interface LocatedPoint {
  point: GeoPoint | null;
  source: NonNullable<AlertLocationDTO["coords_source"]>;
}

async function resolveCoordinates(
  env: Env, dto: AlertLocationDTO, deadline?: number,
): Promise<LocatedPoint> {
  // Everything this location looks up is searched inside its own settlement,
  // so a village street is never resolved against the like-named city one.
  const regions = await q.getRegions(env);
  // The settlement as a row, for scoping the street table. Null when we hold no
  // region for it, which means no seeded street can be trusted to be this
  // location's — Nominatim answers those, as it did for every village street
  // before they could be seeded at all.
  const scope = settlementScope(dto.settlement, dto.area ?? dto.location_name, regions);
  // The same thing as a string, for the Nominatim anchor. The resolved row's
  // name is the canonical spelling; settlementOf only sees what was written.
  const settlement = scope?.name ?? settlementOf(dto.settlement ?? dto.area ?? dto.location_name);
  // Hoisted above step 1: the plausibility check needs the settlement's extent,
  // which is derived from its own streets. Served by the same 6-hour ref cache
  // every other read here uses, so asking for it early costs nothing.
  const streets = await q.getStreets(env);

  // The plausibility check measures against the settlement the MESSAGE stated,
  // never against DEFAULT_SETTLEMENT. `settlementScope` answers "Варна" for
  // anything it cannot place, which is the right scope to search in and the
  // wrong thing to judge an answer by: alert 8360abda names only "Вилна зона",
  // and the correct point for it is 40 km away in Провадия. Judging that against
  // a Варна we merely assumed would reject a right answer, which is the failure
  // this guard exists to prevent, pointed the other way.
  const anchor = dto.settlement?.trim() ? scope : null;

  // 1. District / locality level: a named area pins the whole of it — the one
  // inside this location's settlement, which is the whole point of scoping here:
  // Варна's "Цветен квартал" and Белослав's are 17.5 km apart and share a name.
  if (dto.area?.trim()) {
    const match = matchRegion(dto.area, regions, undefined, scope?.id);
    const seeded = seededPoint(match);
    if (seeded) return { point: seeded, source: "seed" };

    const name = match?.name ?? geocodableName(dto.area);
    const point = plausible(
      await geocode(env, buildGeocodeQuery(name, settlement), deadline), anchor, streets, name);
    // The provider that answered: `photon` when Nominatim was down (§1.5).
    if (point) return { point, source: point.provider };
    // Area named but unresolvable — fall through to the streets rather than
    // leaving the alert with no pin at all.
  }

  // 2. Street-level fallback: first sublocation that resolves wins.
  const candidates = dto.sublocations.slice(0, 3);
  if (candidates.length > 0) {
    for (const raw of candidates) {
      // Scoped to this location's settlement, so a matched row IS this
      // location's street — which is what lets its seeded coordinate be used
      // directly. The old code had to refuse any match outside Варна, because a
      // seeded row could only be a city street; that guard is what sent every
      // village street to Nominatim, one 1,100 ms throttle slot plus an
      // up-to-8 s request at a time, on the ingest deadline.
      const match = scope === null ? null : matchStreet(raw, streets, scope.id);
      const seeded = seededPoint(match);
      if (seeded) return { point: seeded, source: "seed" };

      const name = match?.name ?? geocodableName(raw);
      const point = plausible(
        await geocode(env, buildGeocodeQuery(name, settlement), deadline), anchor, streets, name);
      if (point) return { point, source: point.provider };
    }
  }

  // 3. Settlement level: no area and no street resolved, so the city or village
  // centroid is all that is left. Below the streets deliberately — see above.
  if (dto.settlement?.trim()) {
    // Both branches are `settlement`, not `seed`/`nominatim`: what makes this a
    // fallback is not where the number came from but WHAT it describes — the
    // centre of a settlement, standing in for a place we failed to locate. A
    // seeded city centroid is exactly as wrong for a lost district as a
    // geocoded one.
    const seeded = seededPoint(scope);
    if (seeded) return { point: seeded, source: "settlement" };

    const point = await geocode(
      env, buildGeocodeQuery(scope?.name ?? geocodableName(dto.settlement), settlement), deadline);
    if (point) return { point, source: "settlement" };
  }

  return { point: null, source: "none" };
}
