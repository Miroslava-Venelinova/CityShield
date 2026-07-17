"""
State repository backed by PostgreSQL (table: crawl_state, one row per
source). Generic per-source crawl state. Two shapes are supported:

  Numeric cursor (sources whose messages have increasing numeric ids):
    last_id  BIGINT

  Seen-id set (sources without ordered ids):
    seen_ids TEXT[]

The table is created automatically on first use, so no migration step is
required. All public functions return safe defaults on any error so that
a database hiccup never crashes a service.
"""

import logging

import psycopg

from config import cfg

log = logging.getLogger(__name__)

_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS crawl_state (
    source     TEXT PRIMARY KEY,
    last_id    BIGINT NOT NULL DEFAULT 0,
    seen_ids   TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

# Sources only ever compare against ids still visible on the listing page
# (a page shows a few dozen items at most), so old ids can be dropped.
# Keeping the newest few hundred stops the array growing forever.
MAX_SEEN_IDS = 500

_table_ready = False


def _connect() -> psycopg.Connection:
    """
    Open a short-lived autocommit connection, creating the crawl_state
    table on first use in this process.
    """
    global _table_ready
    conn = psycopg.connect(
        dbname=cfg.POSTGRES_DB,
        user=cfg.POSTGRES_USER,
        password=cfg.POSTGRES_PASSWORD,
        host=cfg.POSTGRES_HOST,
        port=cfg.POSTGRES_PORT,
        sslmode=cfg.POSTGRES_SSLMODE,
        connect_timeout=5,
        autocommit=True,
    )
    if not _table_ready:
        try:
            conn.execute(_TABLE_DDL)
            _table_ready = True
        except psycopg.Error:
            conn.close()
            raise
    return conn


# ---------------------------------------------------------------------------
# Numeric cursor (e.g. vik, heating)
# ---------------------------------------------------------------------------

def get_last_id(source: str) -> int:
    """
    Return the last processed message id for a source.
    Returns 0 as a safe default on any error.
    """
    try:
        with _connect() as conn:
            row = conn.execute(
                "SELECT last_id FROM crawl_state WHERE source = %s", (source,)
            ).fetchone()
        if row is None:
            log.warning("[state_repo] %s state row not found — defaulting to 0.", source)
            return 0
        return int(row[0])
    except (psycopg.Error, TypeError, ValueError) as exc:
        log.error("[state_repo] get_last_id(%s) failed: %s", source, exc)
        return 0


def write_last_id(source: str, last_id: int) -> None:
    """
    Persist the latest processed message id for a source.
    Uses upsert so the row is created on first run.
    """
    try:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO crawl_state (source, last_id) VALUES (%s, %s)
                ON CONFLICT (source) DO UPDATE
                    SET last_id = EXCLUDED.last_id, updated_at = now()
                """,
                (source, last_id),
            )
        log.debug("[state_repo] %s last_id updated to %d", source, last_id)
    except psycopg.Error as exc:
        log.error("[state_repo] write_last_id(%s) failed: %s", source, exc)


# ---------------------------------------------------------------------------
# Seen-id set (e.g. vt, epro, roads)
# ---------------------------------------------------------------------------

def get_seen_ids(source: str) -> list[str]:
    """
    Return the list of already-processed message ids for a source.
    Returns an empty list as a safe default on any error.
    """
    try:
        with _connect() as conn:
            row = conn.execute(
                "SELECT seen_ids FROM crawl_state WHERE source = %s", (source,)
            ).fetchone()
        if row is None:
            log.warning("[state_repo] %s state row not found — defaulting to [].", source)
            return []
        return list(row[0])
    except (psycopg.Error, TypeError) as exc:
        log.error("[state_repo] get_seen_ids(%s) failed: %s", source, exc)
        return []


def _merge_seen_ids(existing: list[str], new_ids: list[str]) -> list[str]:
    """
    Append new ids (deduplicated, order-preserving) to the existing list,
    keeping only the newest MAX_SEEN_IDS entries.
    """
    merged = list(existing)
    known = set(existing)
    for entry in dict.fromkeys(new_ids):
        if entry not in known:
            merged.append(entry)
            known.add(entry)
    return merged[-MAX_SEEN_IDS:]


def add_seen_ids(source: str, ids: list[str]) -> None:
    """
    Add new message ids to a source's stored set, keeping only the newest
    MAX_SEEN_IDS entries (the sources only ever compare against ids still
    visible on the listing page). Ids already stored are skipped, so
    duplicates are never stored. Uses upsert so the row is created on
    first run.
    """
    if not ids:
        return
    try:
        # Read-merge-write: each source has a single writer, so this is
        # not racy in practice (same assumption as the old Mongo version).
        with _connect() as conn:
            row = conn.execute(
                "SELECT seen_ids FROM crawl_state WHERE source = %s", (source,)
            ).fetchone()
            existing = list(row[0]) if row else []
            merged = _merge_seen_ids(existing, ids)
            if merged == existing:
                return
            conn.execute(
                """
                INSERT INTO crawl_state (source, seen_ids) VALUES (%s, %s)
                ON CONFLICT (source) DO UPDATE
                    SET seen_ids = EXCLUDED.seen_ids, updated_at = now()
                """,
                (source, merged),
            )
        log.debug("[state_repo] %s stored %d id(s) total", source, len(merged))
    except psycopg.Error as exc:
        log.error("[state_repo] add_seen_ids(%s) failed: %s", source, exc)
