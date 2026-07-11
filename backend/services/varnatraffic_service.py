"""
Core logic for extracting data from varnatraffic.
"""

import hashlib
import logging

from pydantic import BaseModel

from config import cfg
from data.mongo.state_repository import add_seen_ids, get_seen_ids
from scraping.scrape import fetch_page, vt_parse
from services import common

log = logging.getLogger(__name__)

# support for bus stops can be added in the future
AI_PROMPT = """\
You are a system that outputs strictly valid JSON.

## Task
You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.
It will be a message regarding some change in a bus route. You will have to extract the affected bus lines.
For buses that have a letter after their number write them in a format "number + uppercase letter" example: "31A".
Special case: if you see "209 Бърз" it's 209B.

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "bus_lines": ["array of strings"]
}

## Constraints
- Do not add extra fields.
- If there are no bus lines specified but the message has information for a route change, write in the array only "0".
- If the data is completely irrelevant, leave the array null.
- Ensure the JSON is syntactically valid.
"""


class VtAiOutput(BaseModel):
    """Schema for the VT prompt's output; null bus_lines = irrelevant message."""
    bus_lines: list[str] | None = None


def _message_id(msg: dict) -> str:
    """
    The accordion's data-id, or a content hash for entries missing one so
    they still deduplicate across runs instead of being reprocessed forever.
    """
    data_id = msg.get("data_id")
    if data_id:
        return data_id
    digest = hashlib.sha1(
        f"{msg.get('header', '')}\n{msg.get('body', '')}".encode("utf-8")
    ).hexdigest()
    return f"sha1:{digest}"


def main():
    log.info("[VT] Starting...")

    # Step 1: download the VarnaTraffic info page
    try:
        response = fetch_page(cfg.VT_URL)
    except Exception as exc:
        log.error("[VT] Failed to fetch page: %s. Stopping.", exc)
        return

    # Step 2: parse all accordion messages from the page with BeautifulSoup
    raw_messages = vt_parse(response.text)
    if raw_messages is None:
        log.error("[VT] Page parsing returned no data. Stopping.")
        return

    # Step 3: load already-processed ids from MongoDB and filter out known messages
    stored_ids = set(get_seen_ids("vt"))
    new_messages = [
        (msg_id, msg)
        for msg in raw_messages
        if (msg_id := _message_id(msg)) not in stored_ids
    ]

    if not new_messages:
        log.info("[VT] No new messages found.")
        return

    log.info("[VT] Found %d new message(s).", len(new_messages))
    processed_ids: list[str] = []

    try:
        for msg_id, msg in new_messages:
            msg_content = f"{msg.get('header', '')}\n{msg.get('body', '')}"

            # Step 4: send the message to the local LLM to extract affected bus
            # lines, validated against the schema (shared parse handles invalid
            # JSON and wrong shapes, e.g. a bare array instead of an object).
            parsed = common.parse_with_ai(
                "VT", AI_PROMPT, msg_content, f"id={msg_id}", model=VtAiOutput,
            )
            if parsed is None:
                continue

            # A null array means the message is irrelevant (no route change info)
            bus_lines = parsed.bus_lines
            if bus_lines is None:
                log.info("[VT] Message id=%s judged irrelevant. Skipping.", msg_id)
                processed_ids.append(msg_id)
                continue

            # Step 5: submit as a city-wide broadcast alert for the "vt" category.
            # Route changes have no residential address, so there is no location
            # matching — the API narrows the audience to users subscribed to an
            # affected bus line (users without a line filter get everything).
            title = msg.get("header") or "Промяна в градския транспорт"
            content = msg.get("body", "")
            if bus_lines and bus_lines != ["0"]:
                content = f"{content}\n\nЗасегнати линии: {', '.join(bus_lines)}"

            submitted = common.submit_to_api(
                "VT",
                "vt",
                title,
                content,
                common.AiOutput(locations=[], start_time=None, end_time=None,
                                city_wide=True, bus_lines=bus_lines),
                f"id={msg_id}",
            )
            if submitted:
                processed_ids.append(msg_id)
    finally:
        # Step 6: persist the ids from this run so they are skipped next time —
        # even if one message aborts the run, earlier submissions stay recorded
        # and are not re-broadcast on the next cycle.
        add_seen_ids("vt", processed_ids)
        log.info("[VT] Done. Persisted %d new id(s).", len(processed_ids))


if __name__ == "__main__":
    main()
