"""
Module for scraping.
"""

import requests
#will have to install lxml for bs
from bs4 import BeautifulSoup

def fetch_page(url, headers=None, timeout=10):
    """
    Fetch HTML content from a URL using requests.
    """
    response = requests.get(url, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response

def vik_parse(html):
    """
    Parse HTML from vikvarna using BeautifulSoup.
    Returns a dictionary containing the message info.
    """
    soup = BeautifulSoup(html, "lxml")

    container = soup.select_one("#main_content")
  
    content = container.select_one(".view p")
    if not content:
        return None

    title = container.select_one("h1")
    date = container.select_one(".list-item-date")

    return {
        "title": title.get_text(strip=True),
        "date": date.get_text(strip=True) if date else None,
        "content": content.get_text(strip=True)
    }

def vt_parse(html):
    """
    Parse HTML from varnatraffic using BeautifulSoup.
    Returns a dictionary with all messages.
    """
    soup = BeautifulSoup(html, "lxml")

    accordion_groups = soup.find_all("div", class_="accordion-group")

    results = []

    for group in accordion_groups:
        data_id = group.get("data-id", "No ID")

        header_tag = group.find("a", class_="accordion-toggle")
        header_text = header_tag.get_text(strip=True) if header_tag else "No header"

        body_tag = group.find("div", class_="accordion-inner")
        body_text = body_tag.get_text(" ", strip=True) if body_tag else "No body"

        time_tag = group.find("div", class_="info-time")
        info_time = time_tag.get_text(strip=True) if time_tag else "No time"

        results.append({
            "data_id": data_id,
            "header": header_text,
            "body": body_text,
            "info_time": info_time
        })

    return results