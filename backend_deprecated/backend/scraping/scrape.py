"""
Module for scraping.
"""

import logging
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)

# Some sources (e.g. api.bg) serve empty/blocked responses to the default
# python-requests User-Agent, so every fetch identifies as a browser.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "bg-BG,bg;q=0.9,en;q=0.8",
}

# Shared session: connection pooling across fetches plus automatic retries
# with exponential backoff, so a transient failure doesn't drop a message
# until the next crawl interval. GETs are idempotent, so retrying on 429/5xx
# is safe.
_retry = Retry(
    total=3,
    backoff_factor=1,  # 0s, 2s, 4s
    status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=frozenset({"GET", "HEAD"}),
)
_session = requests.Session()
_session.mount("http://", HTTPAdapter(max_retries=_retry))
_session.mount("https://", HTTPAdapter(max_retries=_retry))


def fetch_page(url, headers=None, timeout=10):
    """Fetch HTML content from a URL with retries. Raises on non-2xx status."""
    response = _session.get(url, headers=headers or DEFAULT_HEADERS, timeout=timeout)
    response.raise_for_status()
    return response


def strip_html(html: str) -> str:
    """Reduce an HTML fragment to plain text (single-space separated)."""
    return BeautifulSoup(html, "lxml").get_text(" ", strip=True)


# ---------------------------------------------------------------------------
# VIK (vikvarna.com)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# VarnaTraffic (varnatraffic.com)
# ---------------------------------------------------------------------------

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
        # None (not a sentinel string) when the attribute is missing — the
        # service derives a content-hash id so id-less entries still dedup.
        data_id     = accordion.get("data-id")
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


# ---------------------------------------------------------------------------
# Veolia Energy Varna — district heating (energy-varna.bg, Drupal)
# ---------------------------------------------------------------------------

def heating_parse_page(html, base_url):
    """
    Parse the Veolia "Ремонти и аварии" listing page.
    Returns a list of absolute message URLs (newest first),
    or None if no listing rows are found.
    """
    soup = BeautifulSoup(html, "lxml")

    rows = soup.select("div.views-row")
    if not rows:
        log.error("[scrape] heating_parse_page: no div.views-row found.")
        return None

    urls = []
    for row in rows:
        a_tag = row.select_one("a[href*='/node/']")
        if a_tag is None:
            log.warning("[scrape] heating_parse_page: views-row has no node link. Skipping.")
            continue
        urls.append(urljoin(base_url, a_tag["href"]))

    return urls


def heating_parse_message(html):
    """
    Parse a Veolia node (message) page.
    Returns a dict with title/content, or None if parsing fails.
    """
    soup = BeautifulSoup(html, "lxml")

    title = soup.find("h1")
    body  = soup.select_one("div.main .field--name-body")
    if body is None:
        log.error("[scrape] heating_parse_message: body field not found.")
        return None

    return {
        "title":   title.get_text(" ", strip=True) if title else "",
        "content": body.get_text(" ", strip=True),
    }


# ---------------------------------------------------------------------------
# API — Road Infrastructure Agency news (api.bg)
# ---------------------------------------------------------------------------

def roads_parse_page(html):
    """
    Parse the api.bg news listing page.
    Returns a list of dicts {url, title, date} (newest first),
    or None if no news panels are found.
    """
    soup = BeautifulSoup(html, "lxml")

    panels = soup.find_all("div", class_="news-panel")
    if not panels:
        log.error("[scrape] roads_parse_page: no div.news-panel found.")
        return None

    results = []
    for panel in panels:
        a_tag = panel.find("a", href=True)
        if a_tag is None:
            log.warning("[scrape] roads_parse_page: news-panel has no link. Skipping.")
            continue
        date_tag  = panel.select_one(".news-date")
        title_tag = panel.select_one(".news-panel-copy")
        results.append({
            "url":   a_tag["href"],
            "title": title_tag.get_text(" ", strip=True) if title_tag else a_tag.get("title", ""),
            "date":  date_tag.get_text(strip=True) if date_tag else None,
        })

    return results


def roads_parse_article(html):
    """
    Parse an api.bg news article page.
    Returns a dict with title/date/content, or None if parsing fails.
    """
    soup = BeautifulSoup(html, "lxml")

    section = soup.select_one("section#single-news")
    if section is None:
        log.error("[scrape] roads_parse_article: section#single-news not found.")
        return None

    title = section.find("h1")
    date  = section.select_one(".date")
    paragraphs = [p.get_text(" ", strip=True) for p in section.find_all("p")]
    content = "\n".join(p for p in paragraphs if p)

    return {
        "title":   title.get_text(" ", strip=True) if title else "",
        "date":    date.get_text(strip=True) if date else None,
        "content": content,
    }
