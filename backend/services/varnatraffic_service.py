"""
Core logic for extracting data from varnatraffic.
"""

import json
import logging
import uuid

from config import cfg
from data.mongo.state_repository import vt_get_ids, vt_write_new_ids
from processing.ai_parser import ai_parse
from scraping.scrape import fetch_page, vt_parse

log = logging.getLogger(__name__)

# support for bus stops can be added in the future
AI_PROMPT = """
    You are a system that outputs strictly valid JSON.

    Task:
    You will receive a message in bulgarian from which you have to extract information and generate a JSON file.
    It will be a message regarding some change in a bus route. You will have to extract the affected bus lines.
    For buses that have a letter after their number write them in a format "number + uppercase letter" example: "31A".
    Special case: if you see "209 Бърз" its 209B.

    Requirements:
    - Output ONLY valid JSON.
    - Do not include explanations, comments, or markdown.
    - Follow this exact schema:
    {
        "bus_lines": ["array of strings"]
    }

    Constraints:
    - Do not add extra fields.
    - If they're are no bus lines specified but the message has information for a route change, write in the array only "0".
    - If the data is completely irrelevant, leave the array null.
    - Ensure the JSON is syntactically valid.
    """

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
    stored_ids = set(vt_get_ids())
    filtered_messages = [
        msg for msg in raw_messages
        if msg.get("data_id") not in stored_ids
    ]

    if not filtered_messages:
        log.info("[VT] No new messages found.")
        return

    log.info("[VT] Found %d new message(s).", len(filtered_messages))
    curr_data_ids = [item["data_id"] for item in filtered_messages if "data_id" in item]

    for msg in filtered_messages:
        msg_content = f"{msg.get('header', '')}\n{msg.get('body', '')}"

        # Step 4: send the message to the local LLM to extract affected bus lines
        raw_ai_output = ai_parse(AI_PROMPT, msg_content)
        if raw_ai_output is None:
            log.error("[VT] AI parsing failed for id=%s. Skipping.", msg.get("data_id"))
            continue

        try:
            bus_lines_json = json.loads(raw_ai_output)
        except json.JSONDecodeError as exc:
            log.error("[VT] AI output is not valid JSON for id=%s: %s. Skipping.", msg.get("data_id"), exc)
            continue

        # Step 5: assemble the final record and hand it off
        # (API submission to be added here — see vik_service for reference)
        final_data = {
            "id": str(uuid.uuid4()),
            "original_message": msg,
            **bus_lines_json,
        }
        log.debug("[VT] Final payload: %s", final_data)

    # Step 6: persist the ids from this run so they are skipped next time
    vt_write_new_ids(curr_data_ids)
    log.info("[VT] Done. Persisted %d new id(s).", len(curr_data_ids))


if __name__ == "__main__":
    main()
