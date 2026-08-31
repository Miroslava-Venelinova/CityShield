-- A heartbeat that survives the failure it exists to report.
--
-- The stalled-cursor warning in runner.ts is a console.error, and an
-- `exceededCpu` kill DISCARDS the invocation's buffered logs — so on the three
-- dead ticks of 28.08.2026 the alarm fired into a log stream that was thrown
-- away, and the tick was indistinguishable at a glance from one that had
-- nothing to do. An alarm that cannot outlive its own incident is not an alarm.
--
-- D1 can. A committed write is I/O, it costs essentially no CPU against the
-- 10 ms cap, and it is still there after the isolate is killed.
--
-- The signature this makes queryable: `started_at` advancing on every tick
-- while `completed_at` stands still is exactly a tick being killed mid-work.
-- One SELECT, instead of a 15-minute `wrangler tail` vigil at one data point
-- per cron — which matters more than usual here, because the observability
-- scopes needed to read historical logs are not granted (SPEC.md §3.8).

CREATE TABLE ingest_health (
    cron          TEXT PRIMARY KEY,  -- the cron expression that fired
    started_at    TEXT NOT NULL,     -- written FIRST, before any parsing
    completed_at  TEXT,              -- written only when the tick ran to the end
    last_duration_ms INTEGER         -- wall clock of the last completed tick
);
