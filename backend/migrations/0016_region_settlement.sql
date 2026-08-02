-- Give a region the settlement it sits inside (SPEC.md §1.2).
--
-- `regions` has always been one flat table holding three different kinds of
-- place at once: settlements (Варна, Тополи, Аврен), the districts inside them
-- (кв. Виница, ж.к. Младост, м-т Ваялар), and nothing to tell them apart —
-- 203 of the 252 seeded names carry no kind prefix, and Център, Максуда and
-- Галата are bare city sub-areas sitting right beside bare villages like
-- Тополи and Казашко. Every place that needed the distinction had to guess it:
--
--   * `settlementOf()` answers "Варна" for anything not written гр./с., which
--     is correct for the city's districts and wrong for ж.к. Младост
--     (Белослав) — a district of a different town entirely.
--   * normalize.ts A9 has to measure the distance between a settlement and an
--     area to decide whether one can contain the other, because containment
--     itself was not answerable.
--   * The invariant that `streets.region_id` always points at a settlement and
--     never at a district (migration 0015) is upheld only by the seeder knowing
--     which it queried. Nothing in the schema says it.
--
-- The link is what the province sweep in tools/osm-seed-builder now produces
-- for free: it extracts each settlement's districts from inside that
-- settlement's own admin_level 8 boundary, so which city a district belongs to
-- is not inferred afterwards — it is how the district was found.
--
-- Nullable, and left NULL for a settlement itself. Self-referencing rather than
-- a `kind` column because the two facts are the same fact: a row with a
-- settlement_id IS a district, a row without one IS a settlement, and they
-- cannot contradict each other the way two independent columns could.

ALTER TABLE regions ADD COLUMN settlement_id INTEGER REFERENCES regions(id);

-- Districts are looked up BY settlement ("everything inside Варна"), never the
-- other way round, so the index goes on the referencing side.
CREATE INDEX ix_regions_settlement ON regions(settlement_id);
