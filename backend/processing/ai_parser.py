"""
Module for AI parsing.
Uses a local LLM (ollama). Returns None on any failure so callers
can handle it gracefully.

Set PERSISTENT_CACHE_ENABLED = True to also persist the cache to disk.
This is intended for debugging — it survives process restarts and lets
you inspect exactly what the model returned for any given input.
"""

import hashlib
import json
import logging
import os
import ollama

from config import cfg

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Persistent cache settings (debugging aid)
# ---------------------------------------------------------------------------
# When True, the cache is read from / written to PERSISTENT_CACHE_PATH on disk.
# The file is plain JSON so you can open it and inspect cached responses.
# When False (default), only the in-process memory cache is used.
PERSISTENT_CACHE_ENABLED: bool = True
PERSISTENT_CACHE_PATH: str = os.path.join(
    os.path.dirname(__file__), ".ai_parser_cache.json"
)
# ---------------------------------------------------------------------------

def _cache_key(system_prompt: str, user_prompt: str) -> str:
    raw = f"{system_prompt}\x00{user_prompt}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _load_persistent_cache() -> dict[str, str]:
    """Load the on-disk cache file, returning an empty dict on any problem."""
    if not os.path.exists(PERSISTENT_CACHE_PATH):
        return {}
    try:
        with open(PERSISTENT_CACHE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("Cache file root is not a JSON object.")
        log.debug("[ai_parser] Loaded %d entries from persistent cache.", len(data))
        return data
    except Exception as exc:
        log.warning("[ai_parser] Could not read persistent cache: %s", exc)
        return {}


def _save_to_persistent_cache(cache: dict[str, str]) -> None:
    """Write the full cache dict to disk, ignoring errors so callers never crash."""
    try:
        with open(PERSISTENT_CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump(cache, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        log.warning("[ai_parser] Could not write persistent cache: %s", exc)


def ai_parse(system_prompt: str, user_prompt: str) -> str | None:
    """
    General function for AI parsing.
    Returns the raw JSON string from the model, or None if anything fails.

    When PERSISTENT_CACHE_ENABLED is True, checks the on-disk JSON cache
    before calling the model, and writes new results back to it.
    When False, every call goes directly to the model.
    """
    key = _cache_key(system_prompt, user_prompt)

    if PERSISTENT_CACHE_ENABLED:
        cache = _load_persistent_cache()
        if key in cache:
            log.debug("[ai_parser] Cache hit.")
            return cache[key]

    try:
        response = ollama.chat(
            model=cfg.OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            format="json",
        )
    except Exception as exc:
        log.error("[ai_parser] Ollama call failed: %s", exc)
        return None

    try:
        log.debug(
            "[ai_parser] tokens used: prompt_eval=%d eval=%d",
            response["prompt_eval_count"],
            response["eval_count"],
        )
        result = response["message"]["content"]
    except (KeyError, TypeError) as exc:
        log.error("[ai_parser] Unexpected response structure: %s", exc)
        return None

    if PERSISTENT_CACHE_ENABLED:
        cache[key] = result
        _save_to_persistent_cache(cache)
        log.debug("[ai_parser] Entry written to persistent cache.")

    return result