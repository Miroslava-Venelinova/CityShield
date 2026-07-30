// The tester's view of the Worker. Everything it runs is imported from
// backend/src — nothing is reimplemented here, so a polygon judged in the tool
// is the polygon ingestion would have built from the same ways and knobs.
//
// This file exists only to give esbuild one entry point to bundle: the Worker
// sources use extensionless relative imports, which plain Node ESM will not
// resolve, so `node backend/src/...` is not an option. See run.mjs.

export {
  BLOCK_POLYGON_DEFAULTS,
  buildBlockPolygon,
  clearOverpassCache,
  fetchStreetWays,
  groupWaysByName,
} from "../../backend/src/ingestion/polygon";

export { bestMatch, POLYGON_RESOLVE_THRESHOLD } from "../../backend/src/core/fuzzy";
