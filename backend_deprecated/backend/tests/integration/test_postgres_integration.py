"""Integration test: state_repository against a real PostgreSQL.

Skipped automatically when no PostgreSQL is reachable via cfg.POSTGRES_*.
Uses uniquely named test sources and cleans up after itself.
"""

import uuid

import psycopg
import pytest

from config import cfg
from data.postgres import state_repository

pytestmark = pytest.mark.integration


def _connect_direct():
    return psycopg.connect(
        dbname=cfg.POSTGRES_DB,
        user=cfg.POSTGRES_USER,
        password=cfg.POSTGRES_PASSWORD,
        host=cfg.POSTGRES_HOST,
        port=cfg.POSTGRES_PORT,
        connect_timeout=2,
        autocommit=True,
    )


def _postgres_available() -> bool:
    try:
        _connect_direct().close()
        return True
    except Exception:
        return False


requires_postgres = pytest.mark.skipif(
    not _postgres_available(),
    reason=f"PostgreSQL not reachable at {cfg.POSTGRES_HOST}:{cfg.POSTGRES_PORT}")


@pytest.fixture
def test_source():
    source = f"pytest_{uuid.uuid4().hex[:12]}"
    yield source
    with _connect_direct() as conn:
        conn.execute("DELETE FROM crawl_state WHERE source = %s", (source,))


@requires_postgres
def test_numeric_cursor_roundtrip_against_real_postgres(test_source):
    assert state_repository.get_last_id(test_source) == 0
    state_repository.write_last_id(test_source, 123)
    assert state_repository.get_last_id(test_source) == 123
    state_repository.write_last_id(test_source, 456)
    assert state_repository.get_last_id(test_source) == 456


@requires_postgres
def test_seen_ids_roundtrip_and_dedup_against_real_postgres(test_source):
    assert state_repository.get_seen_ids(test_source) == []
    state_repository.add_seen_ids(test_source, ["a", "b"])
    state_repository.add_seen_ids(test_source, ["b", "c"])
    assert state_repository.get_seen_ids(test_source) == ["a", "b", "c"]


@requires_postgres
def test_cursor_and_seen_ids_share_one_row(test_source):
    state_repository.write_last_id(test_source, 7)
    state_repository.add_seen_ids(test_source, ["x"])
    assert state_repository.get_last_id(test_source) == 7
    assert state_repository.get_seen_ids(test_source) == ["x"]
    with _connect_direct() as conn:
        row = conn.execute(
            "SELECT count(*) FROM crawl_state WHERE source = %s", (test_source,)
        ).fetchone()
    assert row[0] == 1
