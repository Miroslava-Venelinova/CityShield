-- Carry the settlement in the name of the five regions that collided with a
-- Varna district of the same name (fix-plan D3).
--
-- "Аспарухово" was a village 55 km out AND a district of Varna; "Чайка" a
-- resort AND a district; "ж.к. Младост" one in Белослав AND two in Varna. The
-- matcher now breaks those ties by preferring the in-city row, but a tie-break
-- is a rule you have to keep being right about — naming the places distinctly
-- means the ambiguity stops existing in the data.
--
-- An UPDATE rather than a re-seed: seeds/seed.sql upserts on region_name, so a
-- renamed entry would insert a second row and orphan every user already
-- pointing at the first. Renaming in place keeps region_id — and therefore
-- every user's assignment — intact.
--
-- Each rename is guarded on the target not already existing, so re-running
-- against a database that has been reseeded from the new files is a no-op
-- rather than a UNIQUE violation.

UPDATE regions SET region_name = 'с. Аспарухово (Дългопол)'
 WHERE region_name = 'Аспарухово'
   AND NOT EXISTS (SELECT 1 FROM regions WHERE region_name = 'с. Аспарухово (Дългопол)');

UPDATE regions SET region_name = 'с. Изгрев (Суворово)'
 WHERE region_name = 'Изгрев'
   AND NOT EXISTS (SELECT 1 FROM regions WHERE region_name = 'с. Изгрев (Суворово)');

UPDATE regions SET region_name = 'с. Левски (Суворово)'
 WHERE region_name = 'Левски'
   AND NOT EXISTS (SELECT 1 FROM regions WHERE region_name = 'с. Левски (Суворово)');

UPDATE regions SET region_name = 'к.к. Чайка'
 WHERE region_name = 'Чайка'
   AND NOT EXISTS (SELECT 1 FROM regions WHERE region_name = 'к.к. Чайка');

-- Verified by reverse geocoding its seeded centroid (43.1922, 27.7130):
-- Белослав, not Девня as the review supposed.
UPDATE regions SET region_name = 'ж.к. Младост (Белослав)'
 WHERE region_name = 'ж.к. Младост'
   AND NOT EXISTS (SELECT 1 FROM regions WHERE region_name = 'ж.к. Младост (Белослав)');
