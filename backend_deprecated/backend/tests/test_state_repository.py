"""Unit tests for data/postgres/state_repository.py.

The merge/cap logic is pure and tested directly; the safe-default error
paths are tested by making the connection fail. Roundtrips against a real
PostgreSQL live in tests/integration/test_postgres_integration.py.
"""

import psycopg
import pytest

from data.postgres import state_repository


@pytest.fixture
def broken_db(monkeypatch):
    """Simulate PostgreSQL being unreachable."""
    def boom():
        raise psycopg.OperationalError("postgres down")
    monkeypatch.setattr(state_repository, "_connect", boom)


# ---------------------------------------------------------------------------
# _merge_seen_ids (pure merge/dedup/cap logic)
# ---------------------------------------------------------------------------

def test_merge_appends_new_ids_in_order():
    assert state_repository._merge_seen_ids(["a", "b"], ["c", "d"]) == ["a", "b", "c", "d"]


def test_merge_skips_ids_already_stored():
    assert state_repository._merge_seen_ids(["a", "b"], ["b", "c"]) == ["a", "b", "c"]


def test_merge_deduplicates_within_new_ids():
    assert state_repository._merge_seen_ids([], ["x", "x", "y"]) == ["x", "y"]


def test_merge_caps_at_max_keeping_newest():
    cap = state_repository.MAX_SEEN_IDS
    merged = state_repository._merge_seen_ids([], [f"id{i}" for i in range(cap + 10)])
    assert len(merged) == cap
    assert merged[-1] == f"id{cap + 9}"   # newest kept
    assert "id0" not in merged            # oldest dropped


def test_merge_existing_plus_new_respects_cap():
    cap = state_repository.MAX_SEEN_IDS
    existing = [f"old{i}" for i in range(cap)]
    merged = state_repository._merge_seen_ids(existing, ["new"])
    assert len(merged) == cap
    assert merged[-1] == "new"
    assert "old0" not in merged


# ---------------------------------------------------------------------------
# Safe defaults when PostgreSQL is unreachable
# ---------------------------------------------------------------------------

def test_get_last_id_db_error_defaults_to_zero(broken_db):
    assert state_repository.get_last_id("vik") == 0


def test_write_last_id_db_error_does_not_raise(broken_db):
    state_repository.write_last_id("vik", 99)  # must not raise


def test_get_seen_ids_db_error_defaults_to_empty(broken_db):
    assert state_repository.get_seen_ids("epro") == []


def test_add_seen_ids_db_error_does_not_raise(broken_db):
    state_repository.add_seen_ids("epro", ["x"])  # must not raise


def test_add_seen_ids_empty_list_is_noop(monkeypatch):
    def fail():
        pytest.fail("_connect must not be called for an empty id list")
    monkeypatch.setattr(state_repository, "_connect", fail)
    state_repository.add_seen_ids("epro", [])
