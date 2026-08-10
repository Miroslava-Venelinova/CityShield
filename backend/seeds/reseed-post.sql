-- Wipe-and-reseed, part 2 of 2: re-link users to the new ids by name.
--
-- _user_place is deliberately left behind: if a user came out unplaced it is the
-- only record of where they were, and the name they were placed under is the
-- thing to go and look for in the new seed. Part 1 recreates it each run, so it
-- always describes the most recent reseed.
-- A region matches when the name AND the parent settlement name both match, so
-- the two Припек (a village, and a suburb of Константиново) stay apart.
UPDATE users
   SET region_id = (
     SELECT r.id
       FROM regions r
       LEFT JOIN regions p ON p.id = r.settlement_id
      WHERE r.region_name = (SELECT region_name FROM _user_place WHERE user_id = users.user_id)
        AND COALESCE(p.region_name, '') =
            COALESCE((SELECT region_settlement FROM _user_place WHERE user_id = users.user_id), '')
      LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM _user_place up
                WHERE up.user_id = users.user_id AND up.region_name IS NOT NULL);

UPDATE users
   SET street_id = (
     SELECT s.id
       FROM streets s
       JOIN regions r ON r.id = s.region_id
       LEFT JOIN regions p ON p.id = r.settlement_id
      WHERE s.street_name = (SELECT street_name FROM _user_place WHERE user_id = users.user_id)
        AND r.region_name = (SELECT street_region FROM _user_place WHERE user_id = users.user_id)
        AND COALESCE(p.region_name, '') =
            COALESCE((SELECT street_settlement FROM _user_place WHERE user_id = users.user_id), '')
      LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM _user_place up
                WHERE up.user_id = users.user_id AND up.street_name IS NOT NULL);
