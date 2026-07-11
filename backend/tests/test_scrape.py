"""Unit tests for scraping/scrape.py — all parsers, against HTML fixtures."""

from conftest import load_fixture

from scraping import scrape


# ---------------------------------------------------------------------------
# strip_html
# ---------------------------------------------------------------------------

def test_strip_html_flattens_markup():
    assert scrape.strip_html("<p>Hello <b>world</b></p>") == "Hello world"


def test_strip_html_empty_input():
    assert scrape.strip_html("") == ""


# ---------------------------------------------------------------------------
# VIK
# ---------------------------------------------------------------------------

def test_vik_parse_page_extracts_urls_and_skips_malformed_rows():
    urls = scrape.vik_parse_page(load_fixture("vik_listing.html"))
    assert urls == [
        "https://vikvarna.com/bg/messages/1053.html",
        "https://vikvarna.com/bg/messages/1052.html",
        "https://vikvarna.com/bg/messages/1050.html",
    ]


def test_vik_parse_page_missing_container_returns_none():
    assert scrape.vik_parse_page("<html><body><p>nope</p></body></html>") is None


def test_vik_parse_page_empty_listing_returns_empty_list():
    assert scrape.vik_parse_page('<div id="main_content"></div>') == []


def test_vik_parse_message_happy_path():
    msg = scrape.vik_parse_message(load_fixture("vik_message.html"))
    assert msg["title"] == "Авария на водопровод в кв. Аспарухово"
    assert msg["date"] == "10.06.2026"
    assert "спряно водоподаването" in msg["content"]


def test_vik_parse_message_missing_container_returns_none():
    assert scrape.vik_parse_message("<html><body></body></html>") is None


def test_vik_parse_message_missing_content_returns_none():
    html = '<div id="main_content"><h1>Title only</h1></div>'
    assert scrape.vik_parse_message(html) is None


def test_vik_parse_message_missing_title_and_date_are_defaulted():
    html = '<div id="main_content"><div class="view"><p>Само съдържание</p></div></div>'
    msg = scrape.vik_parse_message(html)
    assert msg == {"title": "", "date": None, "content": "Само съдържание"}


# ---------------------------------------------------------------------------
# VarnaTraffic
# ---------------------------------------------------------------------------

def test_vt_parse_extracts_all_accordions():
    messages = scrape.vt_parse(load_fixture("vt_page.html"))
    assert len(messages) == 3
    assert messages[0] == {
        "data_id": "778",
        "header": "Промяна на маршрута на линия 31А",
        "body": "Поради ремонт линия 31А ще се движи по обходен маршрут.",
        "info_time": "10.06.2026 08:15",
    }
    # Row with everything missing: data_id is None (the service derives a
    # content-hash id), text fields fall back to placeholder values
    assert messages[2] == {
        "data_id": None,
        "header": "No header",
        "body": "No body",
        "info_time": "No time",
    }


def test_vt_parse_missing_container_returns_none():
    assert scrape.vt_parse("<html><body></body></html>") is None


# ---------------------------------------------------------------------------
# Heating (Veolia)
# ---------------------------------------------------------------------------

def test_heating_parse_page_returns_absolute_node_urls():
    urls = scrape.heating_parse_page(
        load_fixture("heating_listing.html"), "https://energy-varna.bg")
    assert urls == [
        "https://energy-varna.bg/bg/node/912",
        "https://energy-varna.bg/bg/node/911",
    ]


def test_heating_parse_page_no_rows_returns_none():
    assert scrape.heating_parse_page("<html><body></body></html>", "https://x") is None


def test_heating_parse_message_happy_path():
    msg = scrape.heating_parse_message(load_fixture("heating_message.html"))
    assert msg["title"] == "Спиране на топлоподаването в район Младост"
    assert "спираме топлоподаването" in msg["content"]


def test_heating_parse_message_missing_body_returns_none():
    assert scrape.heating_parse_message("<html><h1>Заглавие</h1></html>") is None


# ---------------------------------------------------------------------------
# Roads (api.bg)
# ---------------------------------------------------------------------------

def test_roads_parse_page_extracts_items_and_skips_broken_panels():
    items = scrape.roads_parse_page(load_fixture("roads_listing.html"))
    assert len(items) == 2
    assert items[0] == {
        "url": "https://www.api.bg/bg/novini/remont-am-hemus",
        "title": 'Ограничава се движението по АМ "Хемус" в посока Варна',
        "date": "10.06.2026",
    }
    # Panel without .news-panel-copy falls back to the anchor title attribute
    assert items[1]["title"] == "Статистика"
    assert items[1]["date"] is None


def test_roads_parse_page_no_panels_returns_none():
    assert scrape.roads_parse_page("<html><body></body></html>") is None


def test_roads_parse_article_happy_path():
    article = scrape.roads_parse_article(load_fixture("roads_article.html"))
    assert article["title"] == 'Ограничава се движението по АМ "Хемус" в посока Варна'
    assert article["date"] == "10.06.2026"
    # Empty <p> tags are dropped, remaining ones joined with newlines
    assert article["content"] == (
        "Поради ремонтни дейности се ограничава движението в участъка от км 350 до км 355."
        "\nМолим шофьорите да карат внимателно."
    )


def test_roads_parse_article_missing_section_returns_none():
    assert scrape.roads_parse_article("<html><body></body></html>") is None
