import { describe, expect, it } from "vitest";
import { pointInRing, type Ring, ringBBox, ringCentroid } from "../src/core/geo";

// Unit square in [lng, lat] space.
const square: Ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

describe("pointInRing", () => {
  it("detects inside / outside", () => {
    expect(pointInRing(0.5, 0.5, square)).toBe(true);
    expect(pointInRing(1.5, 0.5, square)).toBe(false);
    expect(pointInRing(-0.1, 0.5, square)).toBe(false);
  });

  it("treats the boundary as inside", () => {
    expect(pointInRing(0, 0.5, square)).toBe(true);   // on bottom edge
    expect(pointInRing(0.5, 1, square)).toBe(true);   // on right edge
    expect(pointInRing(0, 0, square)).toBe(true);     // on a vertex
  });

  it("handles a concave ring", () => {
    const lShape: Ring = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]];
    expect(pointInRing(0.5, 0.5, lShape)).toBe(true);
    expect(pointInRing(1.5, 1.5, lShape)).toBe(false); // in the notch
  });
});

describe("ringBBox / ringCentroid", () => {
  it("computes the bbox", () => {
    expect(ringBBox(square)).toEqual({ minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 });
    expect(ringBBox([])).toBeNull();
  });

  it("computes the vertex-average centroid", () => {
    // Includes the closing vertex, same as AlertService.PolygonCentroid.
    const c = ringCentroid([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(c).toEqual({ lat: 1, lng: 1 });
    expect(ringCentroid([])).toBeNull();
  });
});
