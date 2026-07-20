-- user_notification_preferences now stores opt-outs only (see upsertPreference).
-- An is_enabled = 1 row is the default state written out longhand: it changes
-- no read result and only adds rows for getDisabledUserIds to examine.

DELETE FROM user_notification_preferences WHERE is_enabled = 1;
