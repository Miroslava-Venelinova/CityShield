"""
Central configuration module.

A pydantic-settings model: every runtime constant is a typed, validated
field, overridable via environment variables or backend/.env. Import this
module instead of reading os.getenv() in individual modules.

Usage:
    from config import cfg
    print(cfg.POSTGRES_HOST)

Invalid values (e.g. a non-numeric interval) fail fast at startup with a
clear validation error instead of being silently ignored. Blank values
("VAR=") fall back to the field's default, so optional entries can stay
empty in .env / docker-compose.
"""

import logging

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG")


class _Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",          # read from the working directory (backend/)
        env_file_encoding="utf-8",
        extra="ignore",           # unrelated env vars (PATH, ...) are not fields
    )

    # ------------------------------------------------------------------
    # PostgreSQL (crawl state, street/region fuzzy matching, PostGIS)
    # ------------------------------------------------------------------
    POSTGRES_DB:       str = "CityShieldDB"
    POSTGRES_USER:     str = "postgres"
    POSTGRES_PASSWORD: str = "postgres"
    POSTGRES_HOST:     str = "localhost"
    POSTGRES_PORT:     int = 5432

    # ------------------------------------------------------------------
    # ASP.NET API
    # ------------------------------------------------------------------
    ASP_API_URL: str = "http://localhost:5276/api/alerts/submit-data"
    # Shared secret sent as X-Api-Key; must match the API's Ingest__ApiKey.
    # Empty = no header sent (local dev with an open ingest endpoint).
    ASP_API_KEY: str = ""
    # Only disable for self-signed certs in local development.
    ASP_API_VERIFY_SSL: bool = True

    # ------------------------------------------------------------------
    # Ollama
    # ------------------------------------------------------------------
    OLLAMA_MODEL: str = "qwen3.5"
    # Persist LLM responses to disk (debugging aid; keep off in production).
    AI_PERSISTENT_CACHE: bool = False

    # ------------------------------------------------------------------
    # Logging / debugging
    # ------------------------------------------------------------------
    LOG_LEVEL: str = "INFO"
    # Write a Folium debug map (map.html) for every polygon built.
    POLYGON_DEBUG_MAP: bool = False

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
    # Polling intervals (seconds; None → DEFAULT_INTERVAL)
    # ------------------------------------------------------------------
    DEFAULT_INTERVAL:  int        = 600
    VIK_INTERVAL:      int | None = None
    VT_INTERVAL:       int | None = None
    EPRO_INTERVAL:     int | None = None
    HEATING_INTERVAL:  int | None = None
    ROADS_INTERVAL:    int | None = None

    @field_validator("*", mode="before")
    @classmethod
    def _blank_falls_back_to_default(cls, value, info):
        """Treat 'VAR=' (blank) as unset, mirroring the old os.getenv handling."""
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name].default
        return value

    @field_validator("LOG_LEVEL")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        level = value.strip().upper()
        if level not in _LOG_LEVELS:
            raise ValueError(f"LOG_LEVEL must be one of {_LOG_LEVELS}, got '{value}'")
        return level

    @property
    def log_level(self) -> int:
        """LOG_LEVEL as the numeric value logging.basicConfig expects."""
        return getattr(logging, self.LOG_LEVEL)


cfg = _Config()
