"""
Shared pipeline pieces for outage-style scraper services.

Every source service (VIK, ePro, ...) follows the same tail sequence once it
has a message's title/content in hand:

    AI parse -> schema validation -> polygon building -> payload -> POST to API

This module holds that sequence plus the Pydantic schema, so a new source
only needs its own fetch/parse logic, AI prompt and crawl-state handling.
"""

import json
import logging
import uuid

import psycopg
import requests
import urllib3
from pydantic import BaseModel
from pydantic.json_schema import SkipJsonSchema

from config import cfg
from processing import ai_parser
from processing.polygon import streets_to_geojson

if not cfg.ASP_API_VERIFY_SSL:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger(__name__)

# Session for API submissions. The POST is not idempotent (a delivered
# duplicate means duplicate notifications), so only connection-establishment
# failures are retried — those are guaranteed not to have reached the server.
_api_retry = urllib3.util.retry.Retry(
    total=None,
    connect=3,
    read=0,
    redirect=0,
    status=0,
    other=0,
    backoff_factor=1,
    allowed_methods=None,  # apply to POST too
)
_api_session = requests.Session()
_api_session.mount("http://", requests.adapters.HTTPAdapter(max_retries=_api_retry))
_api_session.mount("https://", requests.adapters.HTTPAdapter(max_retries=_api_retry))

# Geocoding area passed to streets_to_geojson; all current sources cover Varna.
POLYGON_AREA = "Варна България"

# Shared prompt for outage-style messages (VIK, ePro, heating): extracts
# affected locations/streets and the outage time window as strict JSON.
OUTAGE_AI_PROMPT = """\
You are a system that outputs strictly valid JSON.

## Task
You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.

## Clarifications
List of abbreviations and their meaning:
- "ул." /улица/ - street
- "бул." /булевард/ - boulevard
- "ж.к." /жилищен комплекс/ - residential complex
- "кв." /квартал/ - district
- "с." /село/ - village
- "гр." /град/ - city
- "м-т" (NO DOT) /местност/ (can also be encountered as "м." or "м-ст") - locality
- "к.к." /курортен комплекс/ (can also be encountered as "к.к-с") - resort complex

If something isn't from the things listed assume it's a building or something else and do not include it.
If there are details regarding what happened and who caused it - ignore it.

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "locations": [
        {
            "location_name": string,
            "sublocations": array of strings,
            "is_polygon": bool
        }
    ],
    "start_time": format "HH:MM",
    "end_time": format "HH:MM",
    "city_wide": bool
}

The "location_name" field must contain the name of the city/village/locality/district/residential complex.
The "sublocations" array includes streets/boulevards, each as a separate entry.
If you have multiple streets listed and stuff along the lines of: "затворени", "в карето", "между"; it means that the streets form a polygon and the "is_polygon" field must be set to true. In every other case leave it false.
In case there is a polygon assume all the things listed are streets.
If the message affects all clients city-wide and lists no specific locations, leave the "locations" array empty and set "city_wide" to true. In every other case "city_wide" must be false.

## Constraints
- Do not add extra fields.
- If data is unknown, use null.
- Ensure the JSON is syntactically valid.
- The abbreviations must be written EXACTLY like from the list (the variant in the leftmost position) AND CONSIDER THE DOTS.
- Leave spaces between each word (including abbreviations).
- Remove all quotation marks from the locations.
"""


# ---------------------------------------------------------------------------
# Pydantic schema for AI output validation (shared by all outage sources)
# ---------------------------------------------------------------------------

class Sublocation(BaseModel):
    location_name: str | None = None
    sublocations: list[str] = []
    is_polygon: bool = False
    # Filled in by build_polygons, never by the LLM — SkipJsonSchema keeps it
    # out of the JSON schema sent to Ollama so the model can't hallucinate it.
    polygon_geojson: SkipJsonSchema[dict | None] = None


class AiOutput(BaseModel):
    locations: list[Sublocation] = []
    start_time: str | None = None
    end_time: str | None = None
    # Explicit broadcast flag: the API only notifies the whole user base when
    # locations is empty AND this is true, so an LLM misparse that drops the
    # locations of a street-level outage can't escalate into a city-wide push.
    city_wide: bool = False
    # VT route changes only: the affected lines ("18", "31A"). The API narrows
    # the broadcast to users subscribed to one of them; None/empty/["0"]
    # (line unknown) keeps the full city-wide audience. Set programmatically
    # by the VT service (SkipJsonSchema: hidden from the outage LLM schema).
    bus_lines: SkipJsonSchema[list[str] | None] = None


# ---------------------------------------------------------------------------
# Pipeline steps
# ---------------------------------------------------------------------------

def open_pg_connection(tag: str):
    """
    Open a PostgreSQL connection for polygon resolution.
    Returns None (and logs) on failure so callers can continue without polygons.
    """
    try:
        return psycopg.connect(
            dbname=cfg.POSTGRES_DB,
            user=cfg.POSTGRES_USER,
            password=cfg.POSTGRES_PASSWORD,
            host=cfg.POSTGRES_HOST,
            port=cfg.POSTGRES_PORT,
            connect_timeout=5,
        )
    except psycopg.Error as exc:
        log.error("[%s] Cannot connect to PostgreSQL: %s. Polygon resolution will be skipped.", tag, exc)
        return None


def parse_with_ai(tag: str, prompt: str, msg_content: str, msg_ref, model=AiOutput):
    """
    Run the LLM over a message and validate the result against a Pydantic
    model (AiOutput by default; sources with their own schema pass theirs).
    The model's JSON schema is passed to Ollama as a structured-output
    constraint, so the response shape is enforced at generation time; the
    Pydantic validation below stays as the backstop.
    Returns None (and logs) on any failure. msg_ref is only used in log lines.
    """
    raw_ai_output = ai_parser.ai_parse(
        prompt, msg_content, format_schema=model.model_json_schema())
    if raw_ai_output is None:
        log.error("[%s] AI parsing failed (%s).", tag, msg_ref)
        return None

    try:
        return model.model_validate(json.loads(raw_ai_output))
    except json.JSONDecodeError as exc:
        log.error("[%s] AI output is not valid JSON (%s): %s.", tag, msg_ref, exc)
        return None
    except Exception as exc:
        log.error("[%s] AI output failed schema validation (%s): %s.", tag, msg_ref, exc)
        return None


def build_polygons(tag: str, ai_output: AiOutput, pg_conn, msg_ref) -> None:
    """
    For every location marked is_polygon, build a GeoJSON polygon from its
    street list using PostGIS / OSM data. Mutates ai_output in place; polygon
    failures are logged and leave polygon_geojson as None.
    """
    for location in ai_output.locations:
        if not location.is_polygon:
            continue

        if pg_conn is None:
            location.polygon_geojson = None
            continue

        try:
            # transaction() (not `with pg_conn:`, which in psycopg 3 would
            # close the connection) rolls back a failed polygon lookup so the
            # connection stays usable for the remaining locations.
            with pg_conn.transaction():
                location.polygon_geojson = streets_to_geojson(
                    POLYGON_AREA,
                    location.sublocations,
                    pg_conn,
                )
        except Exception as exc:
            # Not just psycopg.Error: the OSM/geometry helpers can raise
            # (e.g. ValueError on an empty GeoDataFrame), and a polygon
            # failure must never take down the whole message.
            log.error(
                "[%s] Failed to build polygon for '%s' (%s): %s. Skipping polygon.",
                tag, location.location_name, msg_ref, exc,
            )
            location.polygon_geojson = None


def submit_to_api(tag: str, category: str, title: str, content: str,
                  ai_output: AiOutput, msg_ref) -> bool:
    """
    Assemble the final payload and POST it to the ASP.NET API.
    Returns True on success.

    Authentication: when ASP_API_KEY is configured it is sent as X-Api-Key
    (must match the API's Ingest__ApiKey). SSL verification is on by default;
    set ASP_API_VERIFY_SSL=false only for self-signed local certs.
    """
    final_data = {
        "id": str(uuid.uuid4()),
        "category": category,
        "original_message": {
            "title": title,
            "content": content,
        },
        "processed_data": ai_output.model_dump(),
    }
    log.debug("[%s] Final payload: %s", tag, final_data)

    headers = {}
    if cfg.ASP_API_KEY:
        headers["X-Api-Key"] = cfg.ASP_API_KEY

    try:
        api_response = _api_session.post(
            cfg.ASP_API_URL,
            json=final_data,
            headers=headers,
            verify=cfg.ASP_API_VERIFY_SSL,
            timeout=30,
        )
        api_response.raise_for_status()
        log.info("[%s] Submitted %s  HTTP %d", tag, msg_ref, api_response.status_code)
        return True
    except requests.RequestException as exc:
        log.error("[%s] Failed to submit data for %s: %s.", tag, msg_ref, exc)
        return False


def process_and_submit(tag: str, category: str, prompt: str,
                       title: str, content: str, pg_conn, msg_ref) -> bool:
    """
    Full shared tail of the pipeline for one message:
    AI parse -> validate -> polygons -> POST. Returns True on success.
    """
    msg_content = f"{title}\n{content}"
    ai_output = parse_with_ai(tag, prompt, msg_content, msg_ref)
    if ai_output is None:
        return False

    build_polygons(tag, ai_output, pg_conn, msg_ref)
    return submit_to_api(tag, category, title, content, ai_output, msg_ref)


# ---------------------------------------------------------------------------
# Shared crawl loop for id-numbered listing sources (VIK, heating)
# ---------------------------------------------------------------------------

def crawl_id_listing(tag: str, category: str, listing_url: str, id_pattern, *,
                     fetch, parse_page, parse_message,
                     load_last_id, save_last_id,
                     prompt: str = OUTAGE_AI_PROMPT) -> None:
    """
    Crawl a listing page whose messages live at urls carrying an increasing
    numeric id (newest first), processing everything newer than the stored
    cursor oldest-first and persisting the highest successfully processed id.

    The collaborators are injected so each source keeps its own fetching/
    parsing quirks:
      fetch(url)            -> response with .text (raises on failure)
      parse_page(html)      -> list of message urls, or None on failure
      parse_message(html)   -> {"title": ..., "content": ...}, or None
      load_last_id(category) / save_last_id(category, id) -> crawl cursor
    """
    stored_id = load_last_id(category)
    log.info("[%s] Last stored id: %d", tag, stored_id)

    log.info("[%s] Starting...", tag)

    try:
        page_response = fetch(listing_url)
    except Exception as exc:
        log.error("[%s] Failed to fetch listing page: %s. Stopping.", tag, exc)
        return

    msg_urls = parse_page(page_response.text)
    if msg_urls is None:
        log.error("[%s] Could not parse message URLs from the page. Stopping.", tag)
        return

    # Collect everything newer than the cursor (listing is newest-first).
    new_messages: list[tuple[int, str]] = []
    for url in msg_urls:
        match = id_pattern.search(url)
        if not match:
            log.warning("[%s] No numeric id found in url: %s. Skipping.", tag, url)
            continue

        message_id = int(match.group(1))
        if message_id <= stored_id:
            break
        new_messages.append((message_id, url))

    if not new_messages:
        log.info("[%s] No new messages.", tag)
        return

    # Open one PG connection for the whole run; individual polygon failures
    # are caught inside the shared pipeline and don't close this connection.
    pg_conn = open_pg_connection(tag)

    # Process oldest-first and advance the cursor only past successes: a
    # failed message (LLM down, API unreachable/401) is retried next run
    # instead of being skipped forever. Newer messages behind the failure
    # wait for that retry — processing them now would re-notify users once
    # the run is repeated. A message that keeps failing blocks only until
    # it ages off the listing page.
    latest_id = stored_id
    try:
        for message_id, url in reversed(new_messages):
            log.debug("[%s] Processing url: %s", tag, url)

            submitted = False
            try:
                msg_response = fetch(url)
                message = parse_message(msg_response.text)
                if message is None:
                    log.warning("[%s] Could not parse message content (id=%d).",
                                tag, message_id)
                else:
                    submitted = process_and_submit(
                        tag, category, prompt,
                        message["title"], message["content"],
                        pg_conn, f"id={message_id}",
                    )
            except Exception as exc:
                log.error("[%s] Failed to process message (id=%d): %s.",
                          tag, message_id, exc)

            if not submitted:
                log.warning("[%s] Stopping at id=%d; it will be retried next run.",
                            tag, message_id)
                break

            latest_id = max(latest_id, message_id)
    finally:
        if pg_conn is not None:
            pg_conn.close()

    # Persist the highest successfully processed id as the next run's cursor
    if latest_id != stored_id:
        save_last_id(category, latest_id)
    log.info("[%s] Done. Latest id persisted: %d", tag, latest_id)
