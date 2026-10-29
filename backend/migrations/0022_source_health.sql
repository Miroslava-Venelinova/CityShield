-- What each source's parser found on its last run, and when it last found
-- anything at all.
--
-- A layout change on a source site makes its parser find nothing, and nothing
-- reads exactly like a quiet day: no error, no exception, the cursor simply
-- stops moving — which for heating and vt it does for days anyway. Both
-- source-side outages so far (epro's API change, ViK's region-scoped listing)
-- and the ~18-day heating outage of 13.08.2026 were found by a person looking.
-- The tick now records, per source, whether the parser recognised anything,
-- and /api/health calls a source SILENT once `items_at` is older than that
-- source's normal quiet spell (docs/specification.md §3.8).
--
-- Its own table, not columns on crawl_state: a crawl_state row's mere
-- existence is the bootstrap signal (state.ts hasStateRow), so writing health
-- there before a source's first run would skip its bootstrap and push-notify
-- its whole visible history.
--
-- Time-based on purpose: silence is read as `now - items_at`, so a source whose
-- every run is killed before it can write anything still turns silent — the
-- heating failure mode, where the tick died inside the parser.

CREATE TABLE source_health (
    source       TEXT PRIMARY KEY,    -- crawl_state.source: 'vik', 'epro', …
    first_run_at TEXT NOT NULL,       -- first recorded run; the silence clock starts here until items_at is set
    run_at       TEXT NOT NULL,       -- the latest run that looked at the source
    outcome      TEXT NOT NULL,       -- that run: items | empty | parse_error | fetch_error
    items        INTEGER,             -- what the parser found on that run (outcome = items)
    detail       TEXT,                -- what failed, for the two error outcomes
    items_at     TEXT                 -- the latest run whose parser found at least one item
);
