-- Index the two audience filters that ran as full table scans, in the same
-- spirit as 0002: the D1 free plan bills rows *examined*, and both of these are
-- on the alert fan-out path where cost is paid per alert rather than per user.
--
-- getDisabledUserIds filters `category = ? AND is_enabled = 0`. The only index
-- on the table was the UNIQUE(user_id, category) one, whose leading column the
-- query does not constrain — so every alert, for every category, scanned the
-- whole preferences table. Leading with `category` and carrying `user_id` makes
-- it a covering search (verified with EXPLAIN QUERY PLAN: SCAN -> SEARCH USING
-- COVERING INDEX). Partial on is_enabled = 0 because 0004 established that an
-- enabled row is never stored, so the index holds exactly the rows the query
-- wants and nothing else.
CREATE INDEX ix_prefs_category_optout
    ON user_notification_preferences(category, user_id)
    WHERE is_enabled = 0;

-- getBusLineSubscriptions reads every user holding a non-empty subscription
-- list, deliberately: filtering in memory keeps it off D1's 100-bound-parameter
-- ceiling on a city-wide audience. That trade only costs what it examines, and
-- it was examining the entire users table to find the handful of subscribers.
-- The WHERE clause is textually identical to the query's so SQLite can match it
-- to the partial index; both selected columns are in it, so the scan never
-- touches the table.
CREATE INDEX ix_users_bus_lines
    ON users(user_id, subscribed_bus_lines)
    WHERE subscribed_bus_lines NOT IN ('[]', '');
