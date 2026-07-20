-- Cut the per-alert row reads that scanned the whole users table (the D1 free
-- plan bills rows *examined*, not rows returned).

-- getReceivesAllUserIds ran `WHERE receives_all_alerts = 1` with no index, i.e.
-- a full users scan on *every* alert fan-out. A partial index holds only the
-- handful of debug rows and covers the selected column.
CREATE INDEX ix_users_receives_all ON users(user_id) WHERE receives_all_alerts = 1;
