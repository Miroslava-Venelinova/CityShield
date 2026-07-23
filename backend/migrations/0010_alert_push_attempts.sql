-- Guard against a permanently-failing push pinning the ingest cursor. A send
-- that fails every tick would otherwise block newer messages on the id-listing
-- sources (vik/heating) until the stuck message aged off the listing — which on
-- a low-volume source can be a long time. Count the failed attempts per alert so
-- the pipeline can give up after a cap and let the cursor advance past it. See
-- MAX_PUSH_ATTEMPTS in src/ingestion/pipeline.ts.

ALTER TABLE alerts ADD COLUMN push_attempts INTEGER NOT NULL DEFAULT 0;
