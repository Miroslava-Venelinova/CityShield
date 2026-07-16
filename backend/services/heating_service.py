"""
Core logic for extracting data from Veolia Energy Varna (energy-varna.bg) —
district-heating repairs and outages ("Ремонти и аварии").

Same shape as the VIK service: a listing page with links to numbered
message pages (/bg/node/<id>, newest first), crawled incrementally by id
via the shared crawler in common.
"""

import re

from config import cfg
from data.postgres.state_repository import get_last_id, write_last_id
from scraping.scrape import fetch_page, heating_parse_message, heating_parse_page
from services import common

TAG = "HEATING"
CATEGORY = "heating"

NODE_URL_PATTERN = re.compile(r'/node/(\d+)')


def main():
    common.crawl_id_listing(
        TAG,
        CATEGORY,
        cfg.HEATING_URL,
        NODE_URL_PATTERN,
        fetch=fetch_page,
        parse_page=lambda html: heating_parse_page(html, cfg.HEATING_BASE_URL),
        parse_message=heating_parse_message,
        load_last_id=get_last_id,
        save_last_id=write_last_id,
    )


if __name__ == "__main__":
    main()
