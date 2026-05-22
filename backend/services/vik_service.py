"""
Core logic for extracting data from vik.
"""

import json
import logging
import re
import uuid

import psycopg2
import requests
import urllib3
from pydantic import BaseModel

from config import cfg
from data.mongo.state_repository import vik_get_last_id, vik_write_new_id
from processing.polygon import streets_to_geojson
from processing import ai_parser
from scraping.scrape import fetch_page, vik_parse_message, vik_parse_page

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger(__name__)

VIK_URL_PATTERN = re.compile(r'(\d+)\.html')

AI_PROMPT = """
    You are a system that outputs strictly valid JSON.

    === Task ===
    You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.
    
    === Clarifications ===
    List of abbreviations and their meaning:
    "ул." /улица/ - street
    "бул." /булевард/ - boulevard
    "ж.к." /жилищен комплекс/ - residential complex
    "кв." /квартал/ - district
    "с." /село/ - village
    "гр." /град/ - city
    "м-т" (NO DOT) /местност/ (can also be encountered as "м." or "м-ст") - locality
    "к.к." /курортен комплекс/ (can also be encountered as "к.к-с") - resort complex
    - If something isn't from the things listed assume it's a building or something else and do not include it.
    - If there are details regarding what happend and who caused it - ignore it
        
    === Requirements ===
    - Output ONLY valid JSON.
    - Do not include explanations, comments, or markdown.
    - Follow this exact schema:
    {
        "locations":
            [
                {
                    "location_name": string,
                    "sublocations": array of strings
                    "is_polygon": bool
                }
            ]
        "start_time": format "HH:MM",
        "end_time": format "HH:MM"
    }

    The "location_name" field must contain the name of the city/village/locality/district/residential complex.
    The "sublocations" array includes streets/boulevards, each as a separate entry.
    If you have multiple streets listed and stuff along the lines of: "затворени", "в карето", "между"; it means that the streets form a polygon and the "is_polygon" field must be set to true. In every other case leave it false.
    
    === Constraints ===:
    - Do not add extra fields.
    - If data is unknown, use null.
    - Ensure the JSON is syntactically valid.
    - The abbreviations must be written EXACTLY like from the list (the variant in the leftmost position) AND CONSIDER THE DOTS.
    - Leave spaces between each word (including abbreviations).
    - Remove all quotation marks from the locations.
    """


# ---------------------------------------------------------------------------
# Pydantic schema for AI output validation
# ---------------------------------------------------------------------------

class _Sublocation(BaseModel):
    location_name: str | None = None
    sublocations: list[str] = []
    is_polygon: bool = False
    polygon_geojson: dict | None = None


class _AiOutput(BaseModel):
    locations: list[_Sublocation] = []
    start_time: str | None = None
    end_time: str | None = None


# ---------------------------------------------------------------------------
# Main service logic
# ---------------------------------------------------------------------------

def main():
    # Step 3 (pre-loop): load the last processed message id from MongoDB
    # so we can skip already-seen messages during iteration
    msg_stored_id = vik_get_last_id()
    log.info("[VIK] Last stored id: %d", msg_stored_id)
    msg_latest_id = msg_stored_id

    log.info("[VIK] Starting...")

    # Step 1: download the main VIK listing page
    try:
        page_response = fetch_page(cfg.VIK_URL)
    except Exception as exc:
        log.error("[VIK] Failed to fetch listing page: %s. Stopping.", exc)
        return

    # Step 2: parse all message URLs out of the listing page with BeautifulSoup
    msg_urls = vik_parse_page(page_response.text)
    if msg_urls is None:
        log.error("[VIK] Could not parse message URLs from the page. Stopping.")
        return

    # Open one PG connection for the whole run; individual polygon failures
    # are caught inside the loop and don't close this connection.
    try:
        pg_conn = psycopg2.connect(
            dbname=cfg.POSTGRES_DB,
            user=cfg.POSTGRES_USER,
            password=cfg.POSTGRES_PASSWORD,
            host=cfg.POSTGRES_HOST,
            port=cfg.POSTGRES_PORT,
        )
    except psycopg2.Error as exc:
        log.error("[VIK] Cannot connect to PostgreSQL: %s. Polygon resolution will be skipped.", exc)
        pg_conn = None

    try:
        for url in msg_urls:
            log.debug("[VIK] Processing url: %s", url)

            # Step 3: extract the numeric id from the URL and compare with the stored id;
            # messages are ordered newest-first so we can stop as soon as we hit a seen id
            match = VIK_URL_PATTERN.search(url)
            if not match:
                log.warning("[VIK] No numeric id found in url: %s. Skipping.", url)
                continue

            message_id = int(match.group(1))

            if message_id <= msg_stored_id:
                # Everything from here down is already processed
                break

            msg_latest_id = max(msg_latest_id, message_id)

            # Step 4: download the individual message page and parse it with BeautifulSoup
            try:
                msg_response = fetch_page(url)
            except Exception as exc:
                log.error("[VIK] Failed to fetch message page (id=%d): %s. Skipping.", message_id, exc)
                continue

            message = vik_parse_message(msg_response.text)
            if message is None:
                log.warning("[VIK] Could not parse message content (id=%d). Skipping.", message_id)
                continue

            msg_content = f"{message['title']}\n{message['content']}"
            log.debug("[VIK] Message content:\n%s", msg_content)

            # Step 5: send the extracted text to the local LLM for structured data extraction
            raw_ai_output = ai_parser.ai_parse(AI_PROMPT, msg_content)
            if raw_ai_output is None:
                log.error("[VIK] AI parsing failed (id=%d). Skipping.", message_id)
                continue

            try:
                ai_output = _AiOutput.model_validate(json.loads(raw_ai_output))
            except json.JSONDecodeError as exc:
                log.error("[VIK] AI output is not valid JSON (id=%d): %s. Skipping.", message_id, exc)
                continue
            except Exception as exc:
                log.error("[VIK] AI output failed schema validation (id=%d): %s. Skipping.", message_id, exc)
                continue

            for location in ai_output.locations:
                if not location.is_polygon:
                    continue

                # Step 6: when a location is marked as a polygon, build a GeoJSON
                # polygon from the list of streets using PostGIS / Overpass data
                if pg_conn is not None:
                    try:
                        with pg_conn:
                            geojson = streets_to_geojson(
                                "Варна България",
                                location.sublocations,
                                pg_conn,
                            )
                        location.polygon_geojson = geojson
                    except psycopg2.Error as exc:
                        log.error(
                            "[VIK] PostGIS error while building polygon for '%s' (id=%d): %s. Skipping polygon.",
                            location.location_name, message_id, exc,
                        )
                        location.polygon_geojson = None
                else:
                    location.polygon_geojson = None

            final_data = {
                "id": str(uuid.uuid4()),
                "original_message": {
                    "title": message["title"],
                    "content": message["content"],
                },
                "processed_data": ai_output.model_dump(),
            }

            log.debug("[VIK] Final payload: %s", final_data)

            # Step 7: POST the structured data to the ASP.NET API
            # NOTE: verify=False is intentional for the local dev cert; swap for a
            # real cert bundle in production. Retries / exponential back-off should
            # also be added before going to production.
            try:
                api_response = requests.post(cfg.ASP_API_URL, json=final_data, verify=False, timeout=10)
                api_response.raise_for_status()
                log.info("[VIK] Submitted id=%d  HTTP %d", message_id, api_response.status_code)
            except requests.RequestException as exc:
                log.error("[VIK] Failed to submit data for id=%d: %s. Skipping.", message_id, exc)
                continue

    finally:
        if pg_conn is not None:
            pg_conn.close()

    # Persist the highest id seen in this run so the next run starts from here
    vik_write_new_id(msg_latest_id)
    log.info("[VIK] Done. Latest id persisted: %d", msg_latest_id)


if __name__ == "__main__":
    main()
