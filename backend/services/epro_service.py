"""
Core logic for extracting data from ERP Sever (Energo-Pro grid operator) —
planned power interruptions for the Varna area.

Unlike the HTML sources, ERP Sever exposes a JSON XHR endpoint (the same one
its interruptions map uses). Entries carry no stable numeric id, so already-
processed messages are tracked by a SHA-256 hash of their content.
"""

import hashlib
import json
import logging

from config import cfg
from data.mongo.state_repository import add_seen_ids, get_seen_ids
from scraping.scrape import DEFAULT_HEADERS, fetch_page, strip_html
from services import common

log = logging.getLogger(__name__)

TAG = "EPRO"
CATEGORY = "epro"

TITLE = "Прекъсване на електрозахранването"

# Interruption buckets published per area; "archive" is deliberately excluded.
_ACTIVE_KEYS = ("area_locations_for_next_48_hours", "area_locations_all_active")


def _entry_id(period: str, text: str) -> str:
    """Stable id for an interruption entry (the site provides none)."""
    return hashlib.sha256(f"{period}|{text}".encode("utf-8")).hexdigest()[:24]


def _fetch_varna_entries():
    """
    Call the interruptions endpoint and return the list of active entries
    for the configured area, or None on failure.
    """
    headers = {**DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest"}
    try:
        response = fetch_page(cfg.EPRO_URL, headers=headers, timeout=30)
        areas = response.json()
    except Exception as exc:
        log.error("[EPRO] Failed to fetch interruptions endpoint: %s.", exc)
        return None

    area = next((a for a in areas if a.get("area_name") == cfg.EPRO_AREA_NAME), None)
    if area is None:
        log.error("[EPRO] Area '%s' not found in endpoint response.", cfg.EPRO_AREA_NAME)
        return None

    entries = []
    for key in _ACTIVE_KEYS:
        raw = area.get(key) or "[]"
        try:
            items = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError as exc:
            log.warning("[EPRO] Could not decode '%s': %s. Skipping bucket.", key, exc)
            continue
        entries.extend(items)

    return entries


def main():
    log.info("[EPRO] Starting...")

    entries = _fetch_varna_entries()
    if entries is None:
        return
    if not entries:
        log.info("[EPRO] No active planned interruptions for %s.", cfg.EPRO_AREA_NAME)
        return

    seen_ids = set(get_seen_ids(CATEGORY))
    processed_ids = []

    pg_conn = common.open_pg_connection(TAG)

    try:
        for entry in entries:
            period = strip_html(entry.get("location_period", ""))
            text   = strip_html(entry.get("location_text", ""))
            # Drop the boilerplate footer ("Публикувано на ..." + portal link)
            text = text.split("Публикувано на")[0].strip()

            if not text:
                continue

            entry_id = _entry_id(period, text)
            if entry_id in seen_ids or entry_id in processed_ids:
                continue

            content = f"{period}\n{text}" if period else text
            log.debug("[EPRO] New interruption (%s): %s", entry_id, content[:120])

            if common.process_and_submit(
                TAG,
                CATEGORY,
                common.OUTAGE_AI_PROMPT,
                TITLE,
                content,
                pg_conn,
                f"id={entry_id}",
            ):
                processed_ids.append(entry_id)
    finally:
        if pg_conn is not None:
            pg_conn.close()

    add_seen_ids(CATEGORY, processed_ids)
    log.info("[EPRO] Done. Processed %d new interruption(s).", len(processed_ids))


if __name__ == "__main__":
    main()
