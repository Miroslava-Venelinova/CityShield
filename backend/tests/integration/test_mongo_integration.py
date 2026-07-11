"""Integration test: state_repository against a real MongoDB.

Skipped automatically when no MongoDB is reachable at cfg.MONGO_URI.
Uses uniquely named test sources and cleans up after itself.
"""

import uuid

import pytest
from pymongo import MongoClient

from config import cfg
from data.mongo import state_repository

pytestmark = pytest.mark.integration


def _mongo_available() -> bool:
    try:
        client = MongoClient(cfg.MONGO_URI, serverSelectionTimeoutMS=1500)
        client.admin.command("ping")
        client.close()
        return True
    except Exception:
        return False


requires_mongo = pytest.mark.skipif(
    not _mongo_available(), reason=f"MongoDB not reachable at {cfg.MONGO_URI}")


@pytest.fixture
def test_source():
    source = f"pytest_{uuid.uuid4().hex[:12]}"
    yield source
    client = MongoClient(cfg.MONGO_URI, serverSelectionTimeoutMS=1500)
    client[cfg.MONGO_DB]["state"].delete_one({"_id": source})
    client.close()


@requires_mongo
def test_numeric_cursor_roundtrip_against_real_mongo(test_source):
    assert state_repository.get_last_id(test_source) == 0
    state_repository.write_last_id(test_source, 123)
    assert state_repository.get_last_id(test_source) == 123
    state_repository.write_last_id(test_source, 456)
    assert state_repository.get_last_id(test_source) == 456


@requires_mongo
def test_seen_ids_roundtrip_and_dedup_against_real_mongo(test_source):
    assert state_repository.get_seen_ids(test_source) == []
    state_repository.add_seen_ids(test_source, ["a", "b"])
    state_repository.add_seen_ids(test_source, ["b", "c"])
    assert sorted(state_repository.get_seen_ids(test_source)) == ["a", "b", "c"]
