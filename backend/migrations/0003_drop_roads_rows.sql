-- Remove the deployed rows left behind by the api.bg "roads" source (552a2a3).
-- The code no longer reads or writes any of them, but they still cost row
-- reads on the D1 free plan (alerts is scanned by created_on_utc on every
-- map load) and would resurface if "roads" were ever reused as a key.

DELETE FROM crawl_state WHERE source = 'roads';
DELETE FROM user_notification_preferences WHERE category = 'roads';
DELETE FROM alerts WHERE category = 'roads';
