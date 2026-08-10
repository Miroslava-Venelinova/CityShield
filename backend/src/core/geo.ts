// Point-in-polygon and centroid helpers (SPEC.md §1.3) — the TypeScript
// replacement for PostGIS `polygon.Contains(u.Location)`. Works on the outer
// ring of a GeoJSON Polygon ([lng, lat] pairs), as the C# port did
// (CreatePolygon over coordinates[0]).

export type Ring = [number, number][]; // [lng, lat]

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function ringBBox(ring: Ring): BBox | null {
  if (ring.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

const EDGE_EPS = 1e-12;

/**
 * Ray-casting point-in-polygon with boundary treated as inside (close enough
 * to NTS `Contains` for alert targeting).
 */
export function pointInRing(lat: number, lng: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;

    // On-segment check (boundary counts as inside).
    const cross = (xj - xi) * (lat - yi) - (yj - yi) * (lng - xi);
    if (Math.abs(cross) < EDGE_EPS
      && lng >= Math.min(xi, xj) - EDGE_EPS && lng <= Math.max(xi, xj) + EDGE_EPS
      && lat >= Math.min(yi, yj) - EDGE_EPS && lat <= Math.max(yi, yj) + EDGE_EPS)
      return true;

    const intersects = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

/**
 * Metres from a point to the nearest edge of a ring — 0 when the point is on or
 * inside it.
 *
 * `pointInRing` is a hard in/out test, and a block polygon's edge is an estimate:
 * it sits a road half-width off an OSM centreline, and the user's own position
 * came from a phone GPS fix. A resident standing on the far kerb of the street
 * that bounds their own block is outside the ring by a few metres and hears
 * nothing. This is what lets the caller give that person a tolerance band
 * instead (alert-service.ts).
 *
 * Distances are computed in a local flat projection anchored at the query point,
 * the same shortcut and for the same reason as `distanceKm` — over the tens of
 * metres a tolerance band spans, the error is millimetres.
 */
export function distanceToRingM(lat: number, lng: number, ring: Ring): number {
  if (ring.length === 0) return Infinity;
  if (pointInRing(lat, lng, ring)) return 0;

  // Degrees → metres at this latitude, so the segment maths is plain Euclidean.
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(lat * RAD);
  const px = 0, py = 0; // the query point is the origin
  const toLocal = ([elng, elat]: [number, number]): [number, number] =>
    [(elng - lng) * mPerLng, (elat - lat) * mPerLat];

  let best = Infinity;
  let [ax, ay] = toLocal(ring[ring.length - 1]!);
  for (const vertex of ring) {
    const [bx, by] = toLocal(vertex);
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    // Project the point onto the segment, clamped to its ends.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d < best) best = d;
    [ax, ay] = [bx, by];
  }
  return best;
}

/**
 * Equirectangular great-circle approximation, in kilometres.
 *
 * Used only to ask "is this seeded place inside Varna or out in the district"
 * (core/place-names.ts), where the error of the flat-earth shortcut is metres
 * over the tens of kilometres being compared — and it costs two multiplies
 * instead of a haversine against the 10 ms CPU budget.
 */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLng = (bLng - aLng) * RAD * Math.cos(((aLat + bLat) / 2) * RAD);
  return Math.hypot(dLat, dLng) * EARTH_RADIUS_KM;
}

/** Average of the outer-ring vertices — "good enough for a map pin" (AlertService.PolygonCentroid). */
export function ringCentroid(ring: Ring): { lat: number; lng: number } | null {
  if (ring.length === 0) return null;
  let latSum = 0, lngSum = 0;
  for (const [lng, lat] of ring) {
    latSum += lat;
    lngSum += lng;
  }
  return { lat: latSum / ring.length, lng: lngSum / ring.length };
}
