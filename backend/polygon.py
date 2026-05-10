"""
Module for forming a polygon from a list of streets.
"""

import json
import math
import warnings
import osmnx as ox
import geopandas as gpd
from shapely.geometry import Point, LineString
from shapely.ops import linemerge, polygonize, unary_union
import folium

# 1. ENABLE CACHING: Saves OSM data locally so you don't hit API limits on repeated runs
ox.settings.use_cache = False

# Suppress minor Shapely/GeoPandas warnings for a cleaner console output
warnings.filterwarnings('ignore')

def extend_line(line, distance=200):
    """Extends a LineString at both ends by a given distance (in meters)."""
    if line is None or line.is_empty:
        return line
        
    coords = list(line.coords)
    if len(coords) < 2:
        return line
    
    # Calculate vector for the first segment to extend backwards
    p0, p1 = coords[0], coords[1]
    dx0, dy0 = p1[0] - p0[0], p1[1] - p0[1]
    len0 = math.hypot(dx0, dy0)
    new_start = (p0[0] - (dx0 / len0) * distance, p0[1] - (dy0 / len0) * distance) if len0 else p0
    
    # Calculate vector for the last segment to extend forwards
    pn_1, pn = coords[-2], coords[-1]
    dxn, dyn = pn[0] - pn_1[0], pn[1] - pn_1[1]
    lenn = math.hypot(dxn, dyn)
    new_end = (pn[0] + (dxn / lenn) * distance, pn[1] + (dyn / lenn) * distance) if lenn else pn
    
    return LineString([new_start] + coords + [new_end])

def extend_geometry(geom, distance=200):
    """Extends a LineString or all parts of a MultiLineString to prevent truncating boulevards."""
    if geom is None or geom.is_empty:
        return geom
        
    if geom.geom_type == 'LineString':
        return extend_line(geom, distance)
    elif geom.geom_type == 'MultiLineString':
        extended_lines = []
        for line in geom.geoms:
            if line.geom_type == 'LineString':
                extended_lines.append(extend_line(line, distance))
        return linemerge(extended_lines)
    return geom

def batch_reproject_dict(geom_dict, src_crs, dst_crs="EPSG:4326"):
    """Helper to reproject a dictionary of geometries all at once for better performance."""
    if not geom_dict: return {}
    names = list(geom_dict.keys())
    geoms = list(geom_dict.values())
    gdf = gpd.GeoDataFrame({'name': names, 'geometry': geoms}, crs=src_crs).to_crs(dst_crs)
    return dict(zip(gdf['name'], gdf.geometry))

def extract_city_block(place_name, street_names, extension_dist=200, output_html=None):
    """Constructs a block polygon and saves an interactive Folium map."""
    
    print(f"Fetching data for {place_name} (Using cache if available)...")
    tags = {'name': street_names}
    
    try:
        gdf = ox.features_from_place(place_name, tags=tags)
    except Exception as e:
        print(f"Error fetching data from OSM: {e}")
        return None, None, None

    # Keep only line geometries
    gdf = gdf[gdf.geometry.type.isin(['LineString', 'MultiLineString'])]
    original_crs = gdf.crs
    
    # Project to a local metric coordinate system for accurate distance math
    gdf_proj = ox.projection.project_gdf(gdf)
    projected_crs = gdf_proj.crs

    # 1. Merge Segments per Street
    street_geoms = {}
    for street in street_names:
        street_segments = gdf_proj[gdf_proj['name'] == street].geometry.tolist()
        if not street_segments:
            print(f"Warning: Street '{street}' not found in OSM data.")
            continue
        street_geoms[street] = linemerge(street_segments)

    # 2. Safety Check: Need at least 3 streets to form a closed polygon
    if len(street_geoms) < 3:
        print("Error: Found fewer than 3 streets in OSM. Cannot form a closed block.")
        return None, None, None

    # 3. Extend Street Geometries
    extended_geoms = {name: extend_geometry(geom, extension_dist) 
                      for name, geom in street_geoms.items()}

    # 4. Construct the Polygon using Shapely's built-in `polygonize`
    # This automatically finds closed loops created by intersecting lines!
    union_lines = unary_union(list(extended_geoms.values()))
    polygons = list(polygonize(union_lines))
    
    block_poly = None
    block_edges = []
    
    if polygons:
        # If multiple polygons form (from extensions crossing), the main block is almost always the largest one
        polygons.sort(key=lambda p: p.area, reverse=True)
        block_poly = polygons[0]
        
        # Extract the perimeter edges of our chosen block for mapping
        coords = list(block_poly.exterior.coords)
        block_edges = [LineString([coords[i], coords[i+1]]) for i in range(len(coords)-1)]
    else:
        print("Warning: The extended streets do not enclose a fully closed polygon.")

    # 5. Folium Visualization (Optimized with Batch Reprojection)
    if output_html:
        print("Generating Folium map...")
    
        # Calculate map center based on original geometries
        bounds = gdf.geometry.union_all().bounds # minx, miny, maxx, maxy
        center_lon, center_lat = (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2
            
        m = folium.Map(location=[center_lat, center_lon], zoom_start=15, tiles="CartoDB positron")

        # Batch reproject all geometries to WGS84 for the map
        street_wgs84 = batch_reproject_dict(street_geoms, projected_crs)
        extended_wgs84 = batch_reproject_dict(extended_geoms, projected_crs)
        
        # Layer: Original Streets
        for name, geom in street_wgs84.items():
            folium.GeoJson(geom, name=f"Original: {name}",
                        style_function=lambda x: {'color': '#3388ff', 'weight': 6, 'opacity': 0.4}).add_to(m)

        # Layer: Extended Streets
        for name, geom in extended_wgs84.items():
            folium.GeoJson(geom, name=f"Extended: {name}",
                        style_function=lambda x: {'color': '#555555', 'weight': 2, 'dashArray': '5, 5', 'opacity': 0.6}).add_to(m)

        # Layer: Extracted Edges & Final Polygon
        if block_poly:
            # Reproject edges
            edges_gdf = gpd.GeoDataFrame({'geometry': block_edges}, crs=projected_crs).to_crs("EPSG:4326")
            for idx, edge in enumerate(edges_gdf.geometry):
                folium.GeoJson(edge, name=f"Block Edge {idx+1}",
                            style_function=lambda x: {'color': '#ff3333', 'weight': 4, 'opacity': 0.9}).add_to(m)
            
            # Reproject Polygon
            poly_gdf = gpd.GeoDataFrame({'geometry': [block_poly]}, crs=projected_crs).to_crs("EPSG:4326")
            folium.GeoJson(poly_gdf.geometry.iloc[0], name="Final Block Polygon",
                        style_function=lambda x: {'fillColor': '#28a745', 'color': '#28a745', 'weight': 2, 'fillOpacity': 0.3}).add_to(m)

        folium.LayerControl().add_to(m)
        m.save(output_html)
        print(f"Success! Interactive map saved to: {output_html}")    
    
    return block_poly, original_crs, projected_crs

# 6. Point-in-Polygon Test Function
def is_point_in_block(lat, lon, block_poly, original_crs, projected_crs):
    """Tests whether a WGS84 lat/lon point lies inside the projected polygon."""
    if block_poly is None:
        return False
        
    point_gdf = gpd.GeoDataFrame([{'geometry': Point(lon, lat)}], crs=original_crs)
    point_proj = point_gdf.to_crs(projected_crs).geometry.iloc[0]
    return block_poly.covers(point_proj)

def streets_to_geojson(
    place_name,
    raw_street_names,
    conn,
    extension_dist=200,
    similarity_threshold=0.4
):
    """
    Full pipeline:
    raw input → normalize → DB fuzzy match → polygon → GeoJSON
    """

    # --- Step 1: resolve names via PostgreSQL ---
    resolved_map = resolve_street_names(
        raw_street_names,
        conn,
        similarity_threshold=similarity_threshold
    )

    resolved_names = []
    for original, resolved in resolved_map.items():
        if resolved:
            resolved_names.append(resolved)
        else:
            print(f"Warning: Could not resolve '{original}'")

    if len(resolved_names) < 3:
        print("Error: Need at least 3 valid streets after normalization.")
        return None

    # Optional debug output
    print("\nResolved street mapping:")
    for k, v in resolved_map.items():
        print(f"  {k} → {v}")

    # --- Step 2: build polygon ---
    polygon, original_crs, projected_crs = extract_city_block(
        place_name=place_name,
        street_names=resolved_names,
        extension_dist=extension_dist,
        output_html=None
    )

    if polygon is None:
        print("Error: Polygon construction failed.")
        return None

    # --- Step 3: convert to GeoJSON (WGS84) ---
    gdf = gpd.GeoDataFrame(
        [{
            "geometry": polygon,
            "streets": resolved_names  # optional metadata
        }],
        crs=projected_crs
    ).to_crs("EPSG:4326")

    geojson = json.loads(gdf.to_json())

    return geojson

def resolve_street_names(input_names, conn, similarity_threshold=0.4, limit=1):
    """
    Resolves fuzzy street names using PostgreSQL pg_trgm similarity.

    Args:
        input_names (list[str]): User-provided street names
        conn: psycopg2 connection
        similarity_threshold (float): minimum similarity
        limit (int): number of candidates per input

    Returns:
        dict: {input_name: best_match_from_db or None}
    """
    resolved = {}

    with conn.cursor() as cur:
        for name in input_names:
            cur.execute("""
                SELECT street_name, similarity(street_name, %s) AS sim
                FROM streets
                WHERE street_name %% %s
                ORDER BY sim DESC
                LIMIT %s;
            """, (name, name, limit))

            result = cur.fetchone()
            resolved[name] = result[0] if result else None

    return resolved

# ==========================================
# EXECUTABLE SCRIPT / EXAMPLE USAGE
# ==========================================
if __name__ == "__main__":
    city_context = "Варна България"
    #bounding_streets = [
    #    "Йордан Йовков",
    #    "Хан Кубрат",
    #    "Ивац Войвода",
    #    "Тихомир"
    #]
    #bounding_streets = [
    #    "Акад. Андрей Сахаров",
    #    "бул. Христо Смирненски",
    #    "бул. Сливница",
    #    "бул. Цар Освободител"
    #]
    #bounding_streets = [
    #    "бул. Владислав Варненчик",
    #    "Младежка", 
    #    "Йордан Йовков",
    #    "Фантазия" 
    #]
    bounding_streets = [ "Царевец", "Клокотница", "бул. Чаталджа"]

    html_file = "map.html"

    polygon, orig_crs, proj_crs = extract_city_block(
        place_name=city_context, 
        street_names=bounding_streets,
        extension_dist=250, 
        output_html=html_file
    )

    if polygon:
        # Example test point
        test_lat, test_lon = 43.22191026531218, 27.88398470945895
        is_inside = is_point_in_block(test_lat, test_lon, polygon, orig_crs, proj_crs)
        print(f"\nTest Point ({test_lat}, {test_lon}) inside block? -> {is_inside}")
    else:
        print("\nPolygon construction failed, please check warnings.")