"""
State repository backed by MongoDB.
Replaces the old utility/json_wrapper.py (file-based state.json).

Collection  : state
Documents   :
  { "_id": "vik", "last_id": <int> }
  { "_id": "vt",  "last_ids": [<str>, ...] }

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
# VIK
# ---------------------------------------------------------------------------

def vik_get_last_id() -> int:
    """
    Return the last processed VIK message id.
    Returns 0 as a safe default on any error.
    """
    try:
        doc = _col().find_one({"_id": "vik"}, {"last_id": 1})
        if doc is None:
            log.warning("[state_repo] vik state document not found — defaulting to 0.")
            return 0
        return int(doc["last_id"])
    except (PyMongoError, KeyError, TypeError, ValueError) as exc:
        log.error("[state_repo] vik_get_last_id failed: %s", exc)
        return 0


def vik_write_new_id(last_id: int) -> None:
    """
    Persist the latest processed VIK message id.
    Uses upsert so the document is created on first run.
    """
    try:
        _col().update_one(
            {"_id": "vik"},
            {"$set": {"last_id": last_id}},
            upsert=True,
        )
        log.debug("[state_repo] vik last_id updated to %d", last_id)
    except PyMongoError as exc:
        log.error("[state_repo] vik_write_new_id failed: %s", exc)


# ---------------------------------------------------------------------------
# VarnaTraffic
# ---------------------------------------------------------------------------

def vt_get_ids() -> list[str]:
    """
    Return the list of already-processed VarnaTraffic message ids.
    Returns an empty list as a safe default on any error.
    """
    try:
        doc = _col().find_one({"_id": "vt"}, {"last_ids": 1})
        if doc is None:
            log.warning("[state_repo] vt state document not found — defaulting to [].")
            return []
        return list(doc.get("last_ids", []))
    except (PyMongoError, TypeError) as exc:
        log.error("[state_repo] vt_get_ids failed: %s", exc)
        return []


def vt_write_new_ids(ids: list[str]) -> None:
    """
    Add new VarnaTraffic message ids to the stored set.
    Uses $addToSet so duplicates are never stored.
    Uses upsert so the document is created on first run.
    """
    if not ids:
        return
    try:
        _col().update_one(
            {"_id": "vt"},
            {"$addToSet": {"last_ids": {"$each": ids}}},
            upsert=True,
        )
        log.debug("[state_repo] vt added %d new id(s)", len(ids))
    except PyMongoError as exc:
        log.error("[state_repo] vt_write_new_ids failed: %s", exc)
