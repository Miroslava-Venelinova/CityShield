"""
Module for scraping.
"""

import logging
import requests
from bs4 import BeautifulSoup

log = logging.getLogger(__name__)


def fetch_page(url, headers=None, timeout=10):
    """Fetch HTML content from a URL. Raises on non-2xx status."""
    response = requests.get(url, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response


def vik_parse_message(html):
    """
    Parse a single VIK message page.
    Returns a dict with title/date/content, or None if parsing fails.
    """
    soup = BeautifulSoup(html, "lxml")

    container = soup.select_one("#main_content")
    if container is None:
        log.error("[scrape] vik_parse_message: #main_content not found.")
        return None

    content = container.select_one(".view p")
    if not content:
        log.warning("[scrape] vik_parse_message: .view p not found.")
        return None

    title = container.select_one("h1")
    date  = container.select_one(".list-item-date")

    return {
        "title":   title.get_text(strip=True) if title else "",
        "date":    date.get_text(strip=True)  if date  else None,
        "content": content.get_text(strip=True),
    }


def vik_parse_page(html):
    """
    Parse the VIK listing page.
    Returns a list of message URLs, or None if the container is missing.
    """
    soup = BeautifulSoup(html, "lxml")

    container = soup.select_one("#main_content")
    if container is None:
        log.error("[scrape] vik_parse_page: #main_content not found.")
        return None

    urls = []
    for msg in container.find_all("div", class_="list-item"):
        a_tag = msg.find("a")
        if a_tag is None:
            log.warning("[scrape] vik_parse_page: list-item has no <a> tag. Skipping.")
            continue
        url = a_tag.get("href")
        if url:
            urls.append(url)

    return urls


def vt_parse(html):
    """
    Parse the VarnaTraffic accordion page.
    Returns a list of message dicts, or None if the container is missing.
    """
    soup = BeautifulSoup(html, "lxml")

    container = soup.select_one("#infoAccordion")
    if container is None:
        log.error("[scrape] vt_parse: #infoAccordion not found.")
        return None

    results = []
    for accordion in container.find_all("div", class_="accordion-group"):
        data_id     = accordion.get("data-id", "No ID")
        header_tag  = accordion.find("a",   class_="accordion-toggle")
        body_tag    = accordion.find("div", class_="accordion-inner")
        time_tag    = accordion.find("div", class_="info-time")

        results.append({
            "data_id":   data_id,
            "header":    header_tag.get_text(strip=True)       if header_tag else "No header",
            "body":      body_tag.get_text(" ", strip=True)    if body_tag   else "No body",
            "info_time": time_tag.get_text(strip=True)         if time_tag   else "No time",
        })

    return results