"""
MongoDB connection module.
Exposes get_db() which returns the application database.
Configuration is read from config.cfg (which itself reads from .env).
"""

import logging
from pymongo import MongoClient
from pymongo.database import Database
from pymongo.errors import ConnectionFailure, ConfigurationError

from config import cfg

log = logging.getLogger(__name__)

_client: MongoClient | None = None


def get_client() -> MongoClient:
    """
    Return (and lazily initialise) the shared MongoClient.
    Raises ConnectionFailure / ConfigurationError on the first call if
    the server cannot be reached so callers fail fast.
    """
    global _client
    if _client is None:
        _client = MongoClient(cfg.MONGO_URI, serverSelectionTimeoutMS=5_000)
        try:
            _client.admin.command("ping")
            log.info("[mongo] Connected to MongoDB  uri=%s  db=%s", cfg.MONGO_URI, cfg.MONGO_DB)
        except (ConnectionFailure, ConfigurationError) as exc:
            log.error("[mongo] Cannot reach MongoDB: %s", exc)
            _client = None
            raise
    return _client


def get_db() -> Database:
    """Return the application Database object."""
    return get_client()[cfg.MONGO_DB]
