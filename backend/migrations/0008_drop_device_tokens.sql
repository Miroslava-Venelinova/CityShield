-- Push delivery moved to OneSignal (external_id targeting), so the backend no
-- longer stores device tokens at all: OneSignal owns the device<->user mapping
-- and its own unsubscribe handling. Drops the table behind /api/tokens and the
-- 60-day stale-token cleanup job, both removed in the same change.

DROP INDEX IF EXISTS ix_device_tokens_user;
DROP TABLE IF EXISTS device_tokens;
