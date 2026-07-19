// Minimal ambient typings for the jsts submodule imports used by
// ingestion/polygon.ts (the package ships no types for these paths).

declare module "jsts/org/locationtech/jts/geom/GeometryFactory.js" {
  const GeometryFactory: any;
  export default GeometryFactory;
}
declare module "jsts/org/locationtech/jts/geom/Coordinate.js" {
  const Coordinate: any;
  export default Coordinate;
}
declare module "jsts/org/locationtech/jts/operation/linemerge/LineMerger.js" {
  const LineMerger: any;
  export default LineMerger;
}
declare module "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js" {
  const Polygonizer: any;
  export default Polygonizer;
}
declare module "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js" {
  const UnaryUnionOp: any;
  export default UnaryUnionOp;
}
declare module "jsts/org/locationtech/jts/operation/distance/DistanceOp.js" {
  const DistanceOp: any;
  export default DistanceOp;
}
