"""Unit tests for data/mongo/state_repository.py using mongomock."""

import mongomock
import pytest
from pymongo.errors import PyMongoError

from data.mongo import state_repository


@pytest.fixture
def db(monkeypatch):
    """Replace the real Mongo database with an in-memory mongomock one."""
    fake_db = mongomock.MongoClient()["cityshield_test"]
    monkeypatch.setattr(state_repository, "get_db", lambda: fake_db)
    return fake_db


@pytest.fixture
def broken_db(monkeypatch):
    """Simulate Mongo being unreachable."""
    def boom():
        raise PyMongoError("mongo down")
    monkeypatch.setattr(state_repository, "get_db", boom)


# ---------------------------------------------------------------------------
# Numeric cursor (vik, heating)
# ---------------------------------------------------------------------------

def test_get_last_id_defaults_to_zero_when_missing(db):
    assert state_repository.get_last_id("vik") == 0


def test_write_and_read_last_id_roundtrip(db):
    state_repository.write_last_id("vik", 1053)
    assert state_repository.get_last_id("vik") == 1053


def test_write_last_id_updates_existing_document(db):
    state_repository.write_last_id("vik", 10)
    state_repository.write_last_id("vik", 20)
    assert state_repository.get_last_id("vik") == 20
    assert db["state"].count_documents({"_id": "vik"}) == 1


def test_sources_are_isolated(db):
    state_repository.write_last_id("vik", 5)
    state_repository.write_last_id("heating", 7)
    assert state_repository.get_last_id("vik") == 5
    assert state_repository.get_last_id("heating") == 7


def test_get_last_id_corrupt_value_defaults_to_zero(db):
    db["state"].insert_one({"_id": "vik", "last_id": "not-a-number"})
    assert state_repository.get_last_id("vik") == 0


def test_get_last_id_missing_field_defaults_to_zero(db):
    db["state"].insert_one({"_id": "vik", "something_else": 1})
    assert state_repository.get_last_id("vik") == 0


def test_get_last_id_mongo_error_defaults_to_zero(broken_db):
    assert state_repository.get_last_id("vik") == 0


def test_write_last_id_mongo_error_does_not_raise(broken_db):
    state_repository.write_last_id("vik", 99)  # must not raise


# ---------------------------------------------------------------------------
# Seen-id set (vt, epro, roads)
# ---------------------------------------------------------------------------

def test_get_seen_ids_defaults_to_empty_list(db):
    assert state_repository.get_seen_ids("epro") == []


def test_add_and_get_seen_ids_roundtrip(db):
    state_repository.add_seen_ids("epro", ["a", "b"])
    assert sorted(state_repository.get_seen_ids("epro")) == ["a", "b"]


def test_add_seen_ids_deduplicates(db):
    state_repository.add_seen_ids("epro", ["a", "b"])
    state_repository.add_seen_ids("epro", ["b", "c"])
    assert sorted(state_repository.get_seen_ids("epro")) == ["a", "b", "c"]


def test_add_seen_ids_caps_at_max_keeping_newest(db):
    cap = state_repository.MAX_SEEN_IDS
    state_repository.add_seen_ids("epro", [f"id{i}" for i in range(cap + 10)])
    stored = state_repository.get_seen_ids("epro")
    assert len(stored) == cap
    assert stored[-1] == f"id{cap + 9}"   # newest kept
    assert "id0" not in stored            # oldest dropped


def test_add_seen_ids_empty_list_is_noop(monkeypatch):
    def fail():
        pytest.fail("get_db must not be called for an empty id list")
    monkeypatch.setattr(state_repository, "get_db", fail)
    state_repository.add_seen_ids("epro", [])


def test_get_seen_ids_document_without_field_defaults_to_empty(db):
    db["state"].insert_one({"_id": "epro", "last_id": 3})
    assert state_repository.get_seen_ids("epro") == []


def test_get_seen_ids_mongo_error_defaults_to_empty(broken_db):
    assert state_repository.get_seen_ids("epro") == []


def test_add_seen_ids_mongo_error_does_not_raise(broken_db):
    state_repository.add_seen_ids("epro", ["x"])  # must not raise
