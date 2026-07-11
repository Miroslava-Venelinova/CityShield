"""
Core logic for extracting data from vik.

A listing page with links to numbered message pages (<id>.html, newest
first), crawled incrementally by id via the shared crawler in common.
"""

import re

from config import cfg
from data.mongo.state_repository import get_last_id, write_last_id
from scraping.scrape import fetch_page, vik_parse_message, vik_parse_page
from services import common

TAG = "VIK"
CATEGORY = "vik"

VIK_URL_PATTERN = re.compile(r'(\d+)\.html')


def main():
    common.crawl_id_listing(
        TAG,
        CATEGORY,
        cfg.VIK_URL,
        VIK_URL_PATTERN,
        fetch=fetch_page,
        parse_page=vik_parse_page,
        parse_message=vik_parse_message,
        load_last_id=get_last_id,
        save_last_id=write_last_id,
    )


if __name__ == "__main__":
    main()
