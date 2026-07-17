"""
Module for AI parsing.
Dispatches to the configured provider (AI_PROVIDER):
  - "ollama": local LLM, structured output via `format=<schema>`
  - "gemini": hosted Gemini API, structured output via a JSON response schema
Returns None on any failure so callers can handle it gracefully.

Set PERSISTENT_CACHE_ENABLED = True to also persist the cache to disk.
This is intended for debugging — it survives process restarts and lets
you inspect exactly what the model returned for any given input.
The cache is keyed on prompts + schema only, so it is provider-agnostic.
"""

import hashlib
import json
import logging
import os
import re
import time

import ollama

from config import cfg

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Persistent cache settings (debugging aid)
# ---------------------------------------------------------------------------
# When True, the cache is read from / written to PERSISTENT_CACHE_PATH on disk.
# The file is plain JSON so you can open it and inspect cached responses.
# Controlled by the AI_PERSISTENT_CACHE env var (default: off — production
# should always call the model so prompt/model changes take effect).
PERSISTENT_CACHE_ENABLED: bool = cfg.AI_PERSISTENT_CACHE
PERSISTENT_CACHE_PATH: str = os.path.join(
    os.path.dirname(__file__), ".ai_parser_cache.json"
)
# ---------------------------------------------------------------------------

def _cache_key(system_prompt: str, user_prompt: str, format_repr: str = "") -> str:
    raw = f"{system_prompt}\x00{user_prompt}\x00{format_repr}"
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


# ---------------------------------------------------------------------------
# Providers
# Each returns the raw response string and raises on any failure; the retry
# loop in ai_parse() is provider-agnostic.
# ---------------------------------------------------------------------------

def _call_ollama(system_prompt: str, user_prompt: str,
                 format_schema: dict | None) -> str:
    response = ollama.chat(
        model=cfg.OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        format=format_schema if format_schema is not None else "json",
    )
    log.debug(
        "[ai_parser] tokens used: prompt_eval=%s eval=%s",
        response.get("prompt_eval_count"),
        response.get("eval_count"),
    )
    result = response["message"]["content"]
    if not result:
        raise ValueError("Empty response from Ollama.")
    return result


_gemini_client = None


def _get_gemini_client():
    """Create the Gemini client once per process (lazy import so ollama-only
    setups don't need the google-genai package installed)."""
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        if not cfg.GEMINI_API_KEY:
            raise RuntimeError(
                "AI_PROVIDER=gemini but GEMINI_API_KEY is not set.")
        _gemini_client = genai.Client(api_key=cfg.GEMINI_API_KEY)
    return _gemini_client


def _call_gemini(system_prompt: str, user_prompt: str,
                 format_schema: dict | None) -> str:
    from google.genai import types

    config = types.GenerateContentConfig(
        system_instruction=system_prompt,
        response_mime_type="application/json",
        # Raw JSON Schema (same dicts we hand to Ollama, e.g. from
        # pydantic's model_json_schema()); supported on gemini-2.5 models.
        response_json_schema=format_schema,
    )
    response = _get_gemini_client().models.generate_content(
        model=cfg.GEMINI_MODEL,
        contents=user_prompt,
        config=config,
    )
    usage = getattr(response, "usage_metadata", None)
    if usage is not None:
        log.debug(
            "[ai_parser] tokens used: prompt=%s candidates=%s",
            usage.prompt_token_count, usage.candidates_token_count,
        )
    result = response.text
    if not result:
        raise ValueError("Empty response from Gemini (possibly blocked).")
    return result


def _retry_delay_seconds(exc: Exception, attempt: int) -> float:
    """
    Exponential backoff (2s, 4s, 8s, ...), except when the provider tells us
    how long to wait: Gemini 429 errors carry a RetryInfo retryDelay (and the
    free tier's requests-per-minute cap makes 429 the failure mode we actually
    hit), in which case we honor it.
    """
    delay = float(2 ** attempt)
    if getattr(exc, "code", None) == 429 or getattr(exc, "status_code", None) == 429:
        match = re.search(r"retryDelay['\"]?\s*:\s*['\"]?(\d+(?:\.\d+)?)s", str(exc))
        if match:
            delay = max(delay, float(match.group(1)))
    return delay


_PROVIDERS = {
    "ollama": _call_ollama,
    "gemini": _call_gemini,
}


def ai_parse(system_prompt: str, user_prompt: str,
             format_schema: dict | None = None) -> str | None:
    """
    General function for AI parsing.
    Returns the raw JSON string from the model, or None if anything fails.

    format_schema: a JSON schema (e.g. SomeModel.model_json_schema()) passed
    to the provider as a structured-output constraint, so the model is forced
    to generate exactly that shape. When None, falls back to free-form JSON
    mode.

    When PERSISTENT_CACHE_ENABLED is True, checks the on-disk JSON cache
    before calling the model, and writes new results back to it.
    When False, every call goes directly to the model.
    """
    key = _cache_key(system_prompt, user_prompt,
                     json.dumps(format_schema, sort_keys=True) if format_schema else "")

    if PERSISTENT_CACHE_ENABLED:
        cache = _load_persistent_cache()
        if key in cache:
            log.debug("[ai_parser] Cache hit.")
            return cache[key]

    call = _PROVIDERS[cfg.AI_PROVIDER]

    # Retry transient failures (server restarting, model still loading,
    # rate limits) so one blip doesn't drop the message until the next crawl.
    attempts = 3
    result = None
    for attempt in range(1, attempts + 1):
        try:
            result = call(system_prompt, user_prompt, format_schema)
            break
        except Exception as exc:
            if attempt == attempts:
                log.error("[ai_parser] %s call failed after %d attempts: %s",
                          cfg.AI_PROVIDER, attempts, exc)
                return None
            delay = _retry_delay_seconds(exc, attempt)
            log.warning("[ai_parser] %s call failed (attempt %d/%d): %s. "
                        "Retrying in %.0fs.",
                        cfg.AI_PROVIDER, attempt, attempts, exc, delay)
            time.sleep(delay)

    if PERSISTENT_CACHE_ENABLED:
        cache[key] = result
        _save_to_persistent_cache(cache)
        log.debug("[ai_parser] Entry written to persistent cache.")

    return result
