-- Which geocoder answered a cached forward lookup.
--
-- Forward geocoding now falls back to Photon when Nominatim fails transiently
-- (docs/specification.md §1.5), and enrichment records the provider as
-- `coords_source`. Without this column a cached Photon answer would come back
-- on the next read as an anonymous point and be reported as `nominatim` — a
-- fallback that leaves no trace looks exactly like success, which is the blind
-- spot `coords_source` exists to close.
--
-- NULL on every row written before this migration: Nominatim was the only
-- provider then, and the reader treats NULL as `nominatim`. Nullable, so the
-- ALTER needs no backfill and the Worker before this change keeps working
-- against the new schema (deploy migrations first, as always).

ALTER TABLE geocode_cache ADD COLUMN provider TEXT;  -- 'nominatim' | 'photon'
