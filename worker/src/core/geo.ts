// Point-in-polygon and centroid helpers (PLAN.MD §1.3) — the TypeScript
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
