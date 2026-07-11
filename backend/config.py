"""
Central configuration module.

Loads .env (via python-dotenv) and exposes every runtime constant as a
typed attribute. Import this module instead of reading os.getenv() in
individual modules.

Usage:
    from config import cfg
    print(cfg.MONGO_URI)
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


def _get_bool(key: str, default: bool) -> bool:
    val = os.getenv(key, "").strip().lower()
    if not val:
        return default
    return val in ("1", "true", "yes", "on")


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
    # PostgreSQL
    # ------------------------------------------------------------------
    POSTGRES_DB:       str = _get("POSTGRES_DB",       "CityShieldDB")
    POSTGRES_USER:     str = _get("POSTGRES_USER",     "postgres")
    POSTGRES_PASSWORD: str = _get("POSTGRES_PASSWORD", "postgres")
    POSTGRES_HOST:     str = _get("POSTGRES_HOST",     "localhost")
    POSTGRES_PORT:     int = _get_int("POSTGRES_PORT", 5432)

    # ------------------------------------------------------------------
    # ASP.NET API
    # ------------------------------------------------------------------
    ASP_API_URL: str = _get("ASP_API_URL", "http://localhost:5276/api/alerts/submit-data")
    # Shared secret sent as X-Api-Key; must match the API's Ingest__ApiKey.
    # Empty = no header sent (local dev with an open ingest endpoint).
    ASP_API_KEY: str = _get("ASP_API_KEY", "")
    # Only disable for self-signed certs in local development.
    ASP_API_VERIFY_SSL: bool = _get_bool("ASP_API_VERIFY_SSL", True)

    # ------------------------------------------------------------------
    # Ollama
    # ------------------------------------------------------------------
    OLLAMA_MODEL: str = _get("OLLAMA_MODEL", "qwen3.5")
    # Persist LLM responses to disk (debugging aid; keep off in production).
    AI_PERSISTENT_CACHE: bool = _get_bool("AI_PERSISTENT_CACHE", False)

    # ------------------------------------------------------------------
    # Debugging
    # ------------------------------------------------------------------
    # Write a Folium debug map (map.html) for every polygon built.
    POLYGON_DEBUG_MAP: bool = _get_bool("POLYGON_DEBUG_MAP", False)


    # ------------------------------------------------------------------
    # Overpass
    # ------------------------------------------------------------------
    OVERPASS_URL: str = "https://overpass.kumi.systems/api/interpreter"

    # ------------------------------------------------------------------
    # Scraping source URLs
    # ------------------------------------------------------------------
    VIK_URL: str = "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown"
    VT_URL:  str = "https://www.varnatraffic.com/Info"

    # ERP Sever (Energo-Pro grid) planned-interruptions JSON endpoint
    EPRO_URL:       str = "https://www.erpsever.bg/bg/profil/xhr/?method=get_interruptions"
    EPRO_AREA_NAME: str = "Варна"

    # Veolia Energy Varna (district heating) — "Ремонти и аварии" listing
    HEATING_BASE_URL: str = "https://energy-varna.bg"
    HEATING_URL:      str = (
        "https://energy-varna.bg/bg/"
        "%D1%81%D1%8A%D0%BE%D0%B1%D1%89%D0%B5%D0%BD%D0%B8%D1%8F"
        "-%D0%B7%D0%B0-%D0%B0%D0%B2%D0%B0%D1%80%D0%B8%D0%B8-0"
    )

    # Road Infrastructure Agency (АПИ) news listing
    ROADS_URL: str = "https://www.api.bg/bg/novini"

    # ------------------------------------------------------------------
    # Polling intervals
    # ------------------------------------------------------------------
    DEFAULT_INTERVAL:  int        = _get_int("DEFAULT_INTERVAL", 600)
    VIK_INTERVAL:      int | None = _optional_int("VIK_INTERVAL")
    VT_INTERVAL:       int | None = _optional_int("VT_INTERVAL")
    EPRO_INTERVAL:     int | None = _optional_int("EPRO_INTERVAL")
    HEATING_INTERVAL:  int | None = _optional_int("HEATING_INTERVAL")
    ROADS_INTERVAL:    int | None = _optional_int("ROADS_INTERVAL")


cfg = _Config()
