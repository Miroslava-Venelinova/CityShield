-- Bound a message that fails BEFORE the store, so one bad item cannot become an
-- unbounded outage of its whole source.
--
-- Migration 0010 capped a permanently-failing *push* for exactly this reason,
-- but it counts on the alert row, which only exists once the store has
-- succeeded. Everything ahead of the store — the scrape parse, the AI call, the
-- deterministic guards — had no cap at all, and the crawlers advance the cursor
-- only past successes. So a message that reliably dies before the store pins
-- the cursor and blocks every newer message indefinitely: 20 hours on
-- 30.07.2026, ~21 hours from 28.08.2026, both ended by hand.
--
-- The count is written BEFORE the attempt, not after. A tick killed for
-- exceeding the 10 ms CPU cap never reaches its own trailing writes (and loses
-- its logs with it), which is precisely the case that has to be bounded — a
-- counter incremented after the failure would never record the failure that
-- matters. See MAX_PRE_STORE_ATTEMPTS in src/ingestion/state.ts.
--
-- Rows are per (source, message ref) and deleted on success, so the table holds
-- only what is currently failing plus what was given up on; the daily retention
-- job ages out the rest.

CREATE TABLE ingest_attempts (
    source     TEXT    NOT NULL,          -- crawl_state.source: 'vik', 'heating'
    ref        TEXT    NOT NULL,          -- message id within that source
    attempts   INTEGER NOT NULL DEFAULT 0,
    skipped_at TEXT,                      -- set when the cap was hit and the cursor moved past it
    first_at   TEXT    NOT NULL,
    last_at    TEXT    NOT NULL,
    PRIMARY KEY (source, ref)
);

-- The operator query: what has this source given up on, newest first.
CREATE INDEX ix_ingest_attempts_skipped ON ingest_attempts(source, skipped_at);
