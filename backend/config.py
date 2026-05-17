"""
Central configuration module.

Loads .env (via python-dotenv) and exposes every runtime constant as a
typed attribute. Import this module instead of reading os.getenv() in
individual modules.

Usage:
    from config import cfg
    print(cfg.MONGO_URI)

TODO: imo a lot of the stuff shouldnt be in the .env
"""

import logging
import os

from dotenv import load_dotenv

load_dotenv()  # reads .env from the working directory (i.e. backend/)

log = logging.getLogger(__name__)


def _require(key: str) -> str:
    """Return the value of a mandatory env var, raise if missing/empty."""
    val = os.getenv(key, "").strip()
    if not val:
        raise EnvironmentError(f"Required environment variable '{key}' is not set.")
    return val


def _get(key: str, default: str) -> str:
    return os.getenv(key, default).strip() or default


def _get_int(key: str, default: int) -> int:
    val = os.getenv(key, "").strip()
    if not val:
        return default
    try:
        return int(val)
    except ValueError:
        log.warning("[config] %s='%s' is not a valid integer — using default %d.", key, val, default)
        return default


def _optional_int(key: str) -> int | None:
    """Return int if the env var is set and valid, otherwise None."""
    val = os.getenv(key, "").strip()
    if not val:
        return None
    try:
        return int(val)
    except ValueError:
        log.warning("[config] %s='%s' is not a valid integer — ignoring.", key, val)
        return None


class _Config:
    # ------------------------------------------------------------------
    # MongoDB
    # ------------------------------------------------------------------
    MONGO_URI: str = _get("MONGO_URI", "mongodb://localhost:27017")
    MONGO_DB:  str = _get("MONGO_DB",  "cityshield")

    # ------------------------------------------------------------------
    # PostgreSQL  (PostGIS — polygon resolution)
    # ------------------------------------------------------------------
    POSTGRES_DB:       str = _get("POSTGRES_DB",       "mydb")
    POSTGRES_USER:     str = _get("POSTGRES_USER",     "postgres")
    POSTGRES_PASSWORD: str = _get("POSTGRES_PASSWORD", "postgres")
    POSTGRES_HOST:     str = _get("POSTGRES_HOST",     "localhost")
    POSTGRES_PORT:     int = _get_int("POSTGRES_PORT", 5432)

    # ------------------------------------------------------------------
    # ASP.NET API
    # ------------------------------------------------------------------
    ASP_API_URL: str = _get("ASP_API_URL", "https://localhost:7180/api/VK/submit-data")

    # ------------------------------------------------------------------
    # Ollama
    # ------------------------------------------------------------------
    OLLAMA_MODEL: str = _get("OLLAMA_MODEL", "qwen3.5")

    # ------------------------------------------------------------------
    # Nominatim  (self-hosted OSM geocoder)
    # ------------------------------------------------------------------
    NOMINATIM_HOST:       str = _get("NOMINATIM_HOST",       "localhost:8080")
    NOMINATIM_SCHEME:     str = _get("NOMINATIM_SCHEME",     "http")
    NOMINATIM_USER_AGENT: str = _get("NOMINATIM_USER_AGENT", "city_shield")

    # ------------------------------------------------------------------
    # Overpass  (OSM query API)
    # ------------------------------------------------------------------
    OVERPASS_URL: str = _get("OVERPASS_URL", "https://overpass.kumi.systems/api/interpreter")

    # ------------------------------------------------------------------
    # Scraping source URLs
    # ------------------------------------------------------------------
    VIK_URL: str = _get(
        "VIK_URL",
        "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown",
    )
    VT_URL: str = _get("VT_URL", "https://www.varnatraffic.com/Info")

    # ------------------------------------------------------------------
    # Polling intervals (seconds)
    # None → service will fall back to DEFAULT_INTERVAL in run.py
    # ------------------------------------------------------------------
    DEFAULT_INTERVAL: int        = _get_int("DEFAULT_INTERVAL", 600)
    VIK_INTERVAL:     int | None = _optional_int("VIK_INTERVAL")
    VT_INTERVAL:      int | None = _optional_int("VT_INTERVAL")
    EPRO_INTERVAL:    int | None = _optional_int("EPRO_INTERVAL")


cfg = _Config()
