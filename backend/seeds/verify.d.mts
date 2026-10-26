// Types for verify.mjs, so test/seeds.spec.ts type-checks against it.

export interface SeedRegion { name: string; lat?: number; lng?: number; settlement?: string }
export interface SeedStreet { name: string; lat?: number; lng?: number; settlement?: string }
/** One street's geometry in street_ways.json: one `[[lon, lat], …]` line per OSM way. */
export interface SeedStreetWays { name: string; settlement?: string; ways: number[][][] }

export interface SeedProblem {
  kind: "street-orphan" | "street-far" | "link-orphan" | "link-far" | "ways-orphan" | "ways-far";
  message: string;
  row: SeedRegion | SeedStreet | SeedStreetWays;
}

export const MAX_SEED_DISTANCE_KM: number;
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number;
export function verifySeeds(
  regions: readonly SeedRegion[], streets: readonly SeedStreet[],
): SeedProblem[];
export function verifyStreetWays(
  regions: readonly SeedRegion[], streets: readonly SeedStreet[], ways: readonly SeedStreetWays[],
): SeedProblem[];
