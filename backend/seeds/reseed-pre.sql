-- Wipe-and-reseed, part 1 of 2: remember where every user lives, by NAME, then
-- drop the reference tables. seed.sql is an upsert and never deletes, so this
-- is the only way to drop rows that should no longer exist — `npm run db:local`
-- alone leaves a retired region or street exactly where it was.
--
-- Do not run this by hand: `npm run db:reseed:local` / `db:reseed:remote` runs
-- part 1, seed.sql and part 2 in the order they have to happen.
--
-- Ids are assigned by AUTOINCREMENT and change across a reseed, so users are
-- re-linked by (name, parent settlement name) afterwards. crawl_state, alerts
-- and geocode_cache are untouched.
DROP TABLE IF EXISTS _user_place;

CREATE TABLE _user_place AS
SELECT u.user_id                AS user_id,
       r.region_name            AS region_name,
       p.region_name            AS region_settlement,
       s.street_name            AS street_name,
       sr.region_name           AS street_region,
       sp.region_name           AS street_settlement
  FROM users u
  LEFT JOIN regions r  ON r.id  = u.region_id
  LEFT JOIN regions p  ON p.id  = r.settlement_id
  LEFT JOIN streets s  ON s.id  = u.street_id
  LEFT JOIN regions sr ON sr.id = s.region_id
  LEFT JOIN regions sp ON sp.id = sr.settlement_id
 WHERE u.region_id IS NOT NULL OR u.street_id IS NOT NULL;

-- Detach before deleting, so the delete cannot leave a user pointing at an id
-- that no longer exists.
UPDATE users SET region_id = NULL, street_id = NULL;

DELETE FROM region_aliases;
DELETE FROM streets;
DELETE FROM regions;

-- Restart the id sequences so a reseeded database numbers like a fresh one.
DELETE FROM sqlite_sequence WHERE name IN ('regions', 'streets');
