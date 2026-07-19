"""
Core logic for extracting data from the Road Infrastructure Agency (api.bg)
news feed — road works, closures and traffic reorganizations.

АПИ publishes news for the whole country, so each new article is fetched and
kept only if it concerns Varna (cheap text check first, then an LLM relevance
judgement). Relevant alerts are broadcast city-wide (empty locations array)
to users subscribed to the "roads" category — road closures rarely map to
residential streets, so per-street matching would notify nobody.

Articles have no numeric id; the URL path is used as the seen-id.
"""

import logging
from urllib.parse import urlparse

from pydantic import BaseModel

from config import cfg
from data.postgres.state_repository import add_seen_ids, get_seen_ids
from scraping.scrape import fetch_page, roads_parse_article, roads_parse_page
from services import common

log = logging.getLogger(__name__)

TAG = "ROADS"
CATEGORY = "roads"

AI_PROMPT = """\
You are a system that outputs strictly valid JSON.

## Task
You will receive a news article in Bulgarian from the Bulgarian Road
Infrastructure Agency (АПИ). Decide whether it is relevant to drivers in
or around the city of Varna, and summarize it.

An article is relevant ONLY if it describes road works, road closures,
traffic restrictions or changed traffic organization that affect:
- roads inside област Варна (Varna province), or
- major routes to/from Varna (АМ "Хемус", път I-9, път I-2, ...).

Articles about other provinces, tolls, tenders, policy or statistics are
NOT relevant, even if they mention Varna in passing (e.g. "посока Варна"
for a road section in another province is NOT relevant).

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "is_relevant": bool,
    "summary": string
}

The "summary" must be 1-2 sentences in Bulgarian stating WHERE, WHEN and
WHAT is restricted. If the article is not relevant, use null.

## Constraints
- Do not add extra fields.
- Ensure the JSON is syntactically valid.
"""


class _RoadsAiOutput(BaseModel):
    is_relevant: bool = False
    summary: str | None = None


def main():
    log.info("[ROADS] Starting...")

    try:
        page_response = fetch_page(cfg.ROADS_URL)
    except Exception as exc:
        log.error("[ROADS] Failed to fetch news listing: %s. Stopping.", exc)
        return

    news_items = roads_parse_page(page_response.text)
    if news_items is None:
        log.error("[ROADS] Could not parse news listing. Stopping.")
        return

    seen_ids = set(get_seen_ids(CATEGORY))
    processed_ids = []

    for item in news_items:
        url = item["url"]
        article_id = urlparse(url).path
        if article_id in seen_ids:
            continue

        log.debug("[ROADS] Processing article: %s", url)

        try:
            article_response = fetch_page(url)
        except Exception as exc:
            log.error("[ROADS] Failed to fetch article %s: %s. Skipping.", url, exc)
            continue

        article = roads_parse_article(article_response.text)
        if article is None:
            log.warning("[ROADS] Could not parse article %s. Skipping.", url)
            processed_ids.append(article_id)
            continue

        full_text = f"{article['title']}\n{article['content']}"

        # Cheap pre-filter: the vast majority of АПИ news never mentions
        # Varna at all — don't waste an LLM call on those.
        if "Варна" not in full_text:
            log.debug("[ROADS] Article does not mention Varna. Skipping: %s", url)
            processed_ids.append(article_id)
            continue

        ai_output = common.parse_with_ai(
            TAG, AI_PROMPT, full_text, url, model=_RoadsAiOutput)
        if ai_output is None:
            continue

        if not ai_output.is_relevant or not ai_output.summary:
            log.info("[ROADS] Article judged not relevant to Varna: %s", url)
            processed_ids.append(article_id)
            continue

        # Broadcast alert: city_wide → all users with "roads" enabled
        submitted = common.submit_to_api(
            TAG,
            CATEGORY,
            article["title"],
            ai_output.summary,
            common.AiOutput(locations=[], start_time=None, end_time=None, city_wide=True),
            article_id,
        )
        if submitted:
            processed_ids.append(article_id)

    add_seen_ids(CATEGORY, processed_ids)
    log.info("[ROADS] Done. Processed %d new article(s).", len(processed_ids))


if __name__ == "__main__":
    main()
