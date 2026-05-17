"""
Module for AI parsing.
Currently uses a local LLM (ollama). Might change in the future.
Returns None on any failure so callers can handle it gracefully.
"""

import logging
import ollama

from config import cfg

log = logging.getLogger(__name__)

# NOTE: maybe its a good idea to add caching here
def ai_parse(system_prompt: str, user_prompt: str) -> str | None:
    """
    General function for AI parsing.
    Returns the raw JSON string from the model, or None if anything fails.
    """
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
        return response["message"]["content"]
    except (KeyError, TypeError) as exc:
        log.error("[ai_parser] Unexpected response structure: %s", exc)
        return None
