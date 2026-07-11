"""
State repository backed by MongoDB.

Generic per-source crawl state. Two shapes are supported:

  Numeric cursor (sources whose messages have increasing numeric ids):
    { "_id": "<source>", "last_id": <int> }

  Seen-id set (sources without ordered ids):
    { "_id": "<source>", "last_ids": [<str>, ...] }

All public functions return safe defaults on any error so that
a database hiccup never crashes a service.
"""

import logging
from pymongo.errors import PyMongoError
from data.mongo.mongo import get_db

log = logging.getLogger(__name__)

_COLLECTION = "state"


def _col():
    """Convenience accessor for the state collection."""
    return get_db()[_COLLECTION]


# ---------------------------------------------------------------------------
# Numeric cursor (e.g. vik, heating)
# ---------------------------------------------------------------------------

def get_last_id(source: str) -> int:
    """
    Return the last processed message id for a source.
    Returns 0 as a safe default on any error.
    """
    try:
        doc = _col().find_one({"_id": source}, {"last_id": 1})
        if doc is None:
            log.warning("[state_repo] %s state document not found — defaulting to 0.", source)
            return 0
        return int(doc["last_id"])
    except (PyMongoError, KeyError, TypeError, ValueError) as exc:
        log.error("[state_repo] get_last_id(%s) failed: %s", source, exc)
        return 0


def write_last_id(source: str, last_id: int) -> None:
    """
    Persist the latest processed message id for a source.
    Uses upsert so the document is created on first run.
    """
    try:
        _col().update_one(
            {"_id": source},
            {"$set": {"last_id": last_id}},
            upsert=True,
        )
        log.debug("[state_repo] %s last_id updated to %d", source, last_id)
    except PyMongoError as exc:
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
        doc = _col().find_one({"_id": source}, {"last_ids": 1})
        if doc is None:
            log.warning("[state_repo] %s state document not found — defaulting to [].", source)
            return []
        return list(doc.get("last_ids", []))
    except (PyMongoError, TypeError) as exc:
        log.error("[state_repo] get_seen_ids(%s) failed: %s", source, exc)
        return []


# Sources only ever compare against ids still visible on the listing page
# (a page shows a few dozen items at most), so old ids can be dropped.
# Keeping the newest few hundred stops the array growing forever.
MAX_SEEN_IDS = 500


def add_seen_ids(source: str, ids: list[str]) -> None:
    """
    Add new message ids to a source's stored set, keeping only the newest
    MAX_SEEN_IDS entries (the sources only ever compare against ids still
    visible on the listing page). Ids already stored are skipped, so
    duplicates are never stored. Uses upsert so the document is created on
    first run.
    """
    if not ids:
        return
    try:
        # $addToSet can't be combined with $slice, so dedupe here and cap
        # via $push+$slice. Each source has a single writer, so the
        # read-then-write is not racy in practice.
        existing = set(get_seen_ids(source))
        new_ids = [i for i in dict.fromkeys(ids) if i not in existing]
        if not new_ids:
            return
        _col().update_one(
            {"_id": source},
            {"$push": {"last_ids": {"$each": new_ids, "$slice": -MAX_SEEN_IDS}}},
            upsert=True,
        )
        log.debug("[state_repo] %s added %d new id(s)", source, len(new_ids))
    except PyMongoError as exc:
        log.error("[state_repo] add_seen_ids(%s) failed: %s", source, exc)
