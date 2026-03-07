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

def vik_parse_message(html):
    """
    Parse message HTML from vikvarna using BeautifulSoup.
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

def vik_parse_page(html):
    """
    Parse page HTML from vikvarna using BeautifulSoup.
    Returns a list of all message urls.
    """
    soup = BeautifulSoup(html, "lxml")

    container = soup.select_one("#main_content")

    messages = container.find_all("div", class_="list-item")

    urls = []

    for msg in messages:
        url = msg.find("a").get("href")
        urls.append(url)

    return urls

def vt_parse(html):
    """
    Parse HTML from varnatraffic using BeautifulSoup.
    Returns a dictionary with all messages.
    """
    soup = BeautifulSoup(html, "lxml")

    container = soup.select_one("#infoAccordion")

    accordion_groups = container.find_all("div", class_="accordion-group")

    results = []

    for accordion in accordion_groups:
        data_id = accordion.get("data-id", "No ID")

        header_tag = accordion.find("a", class_="accordion-toggle")
        header_text = header_tag.get_text(strip=True) if header_tag else "No header"

        body_tag = accordion.find("div", class_="accordion-inner")
        body_text = body_tag.get_text(" ", strip=True) if body_tag else "No body"

        time_tag = accordion.find("div", class_="info-time")
        info_time = time_tag.get_text(strip=True) if time_tag else "No time"

        results.append({
            "data_id": data_id,
            "header": header_text,
            "body": body_text,
            "info_time": info_time
        })

    return results