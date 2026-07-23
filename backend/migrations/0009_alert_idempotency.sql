-- Lost-push fix: give each cursor-driven alert a stable key back to its source
-- message plus a delivery flag, so a message whose push failed can be safely
-- re-driven end to end. sendPushToUsers never throws, so a failed send used to
-- vanish silently — the alert was stored, the cursor advanced, the push was
-- lost. Now the pipeline holds the cursor on a failed send; the next tick
-- re-stores (a no-op via source_ref) and re-pushes, and only stamps notified_at
-- once delivery lands. Retrying is safe precisely because store + notify are now
-- idempotent per source message. See src/ingestion/pipeline.ts.

ALTER TABLE alerts ADD COLUMN source_ref  TEXT;   -- "<category>:id=<n>"; NULL on pre-0009 and manual-submit rows
ALTER TABLE alerts ADD COLUMN notified_at TEXT;   -- ISO-8601 when the push landed; NULL = still owed

-- Partial: pre-0009 rows and manual /submit-data injections carry NULL
-- source_ref (SQLite lets any number of NULLs coexist under a UNIQUE index) and
-- must never collide — only real source messages dedup against each other.
CREATE UNIQUE INDEX ux_alerts_source_ref ON alerts(source_ref) WHERE source_ref IS NOT NULL;
