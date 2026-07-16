"""Unit tests for services/common.py — the shared scraper pipeline tail."""

import json
from unittest.mock import MagicMock

import psycopg
import pytest

from config import cfg
from services import common
from services.common import AiOutput, Sublocation


VALID_AI_JSON = json.dumps({
    "locations": [
        {"location_name": "гр. Варна", "sublocations": ["ул. Дубровник"], "is_polygon": False},
    ],
    "start_time": "09:00",
    "end_time": "17:00",
})


# ---------------------------------------------------------------------------
# parse_with_ai
# ---------------------------------------------------------------------------

def test_parse_with_ai_valid_output(monkeypatch):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: VALID_AI_JSON)

    result = common.parse_with_ai("T", "prompt", "msg", "id=1")

    assert isinstance(result, AiOutput)
    assert result.start_time == "09:00"
    assert result.end_time == "17:00"
    assert result.locations[0].location_name == "гр. Варна"
    assert result.locations[0].sublocations == ["ул. Дубровник"]
    assert result.locations[0].is_polygon is False
    assert result.locations[0].polygon_geojson is None


def test_parse_with_ai_ai_failure_returns_none(monkeypatch):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: None)
    assert common.parse_with_ai("T", "prompt", "msg", "id=1") is None


def test_parse_with_ai_invalid_json_returns_none(monkeypatch):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: "{not json")
    assert common.parse_with_ai("T", "prompt", "msg", "id=1") is None


def test_parse_with_ai_schema_violation_returns_none(monkeypatch):
    # "locations" must be a list — a string must fail Pydantic validation
    bad = json.dumps({"locations": "не е списък"})
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: bad)
    assert common.parse_with_ai("T", "prompt", "msg", "id=1") is None


def test_parse_with_ai_missing_fields_use_defaults(monkeypatch):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: "{}")
    result = common.parse_with_ai("T", "prompt", "msg", "id=1")
    assert result == AiOutput(locations=[], start_time=None, end_time=None)


def test_parse_with_ai_sends_structured_output_schema(monkeypatch):
    seen = {}

    def fake_ai_parse(prompt, content, format_schema=None):
        seen["format_schema"] = format_schema
        return VALID_AI_JSON

    monkeypatch.setattr(common.ai_parser, "ai_parse", fake_ai_parse)
    common.parse_with_ai("T", "prompt", "msg", "id=1")

    schema = seen["format_schema"]
    assert schema == AiOutput.model_json_schema()
    # Pipeline-internal fields must be hidden from the LLM's output schema
    assert "polygon_geojson" not in schema["$defs"]["Sublocation"]["properties"]
    assert "bus_lines" not in schema["properties"]
    # ...but the LLM-facing fields must be there
    assert "city_wide" in schema["properties"]
    assert "sublocations" in schema["$defs"]["Sublocation"]["properties"]


# ---------------------------------------------------------------------------
# build_polygons
# ---------------------------------------------------------------------------

def _polygon_location(**overrides):
    defaults = dict(
        location_name="гр. Варна",
        sublocations=["ул. А", "ул. Б", "ул. В"],
        is_polygon=True,
    )
    defaults.update(overrides)
    return Sublocation(**defaults)


def test_build_polygons_skips_non_polygon_locations(monkeypatch):
    called = []
    monkeypatch.setattr(common, "streets_to_geojson",
                        lambda *a, **k: called.append(a) or {"type": "FeatureCollection"})
    output = AiOutput(locations=[_polygon_location(is_polygon=False)])

    common.build_polygons("T", output, MagicMock(), "id=1")

    assert called == []
    assert output.locations[0].polygon_geojson is None


def test_build_polygons_no_pg_connection_sets_none(monkeypatch):
    monkeypatch.setattr(common, "streets_to_geojson",
                        lambda *a, **k: pytest.fail("must not be called"))
    output = AiOutput(locations=[_polygon_location()])

    common.build_polygons("T", output, None, "id=1")

    assert output.locations[0].polygon_geojson is None


def test_build_polygons_success_sets_geojson(monkeypatch):
    geojson = {"type": "FeatureCollection", "features": []}
    captured = {}

    def fake_streets_to_geojson(area, streets, conn):
        captured["area"] = area
        captured["streets"] = streets
        return geojson

    monkeypatch.setattr(common, "streets_to_geojson", fake_streets_to_geojson)
    output = AiOutput(locations=[_polygon_location()])

    common.build_polygons("T", output, MagicMock(), "id=1")

    assert output.locations[0].polygon_geojson == geojson
    assert captured["area"] == common.POLYGON_AREA
    assert captured["streets"] == ["ул. А", "ул. Б", "ул. В"]


def test_build_polygons_postgis_error_sets_none_and_continues(monkeypatch):
    def boom(*a, **k):
        raise psycopg.Error("postgis exploded")

    monkeypatch.setattr(common, "streets_to_geojson", boom)
    output = AiOutput(locations=[_polygon_location(), _polygon_location()])

    common.build_polygons("T", output, MagicMock(), "id=1")

    assert output.locations[0].polygon_geojson is None
    assert output.locations[1].polygon_geojson is None


# ---------------------------------------------------------------------------
# submit_to_api
# ---------------------------------------------------------------------------

def test_submit_to_api_success_and_payload_contract(requests_mock):
    requests_mock.post(cfg.ASP_API_URL, json={"notified_count": 0}, status_code=200)
    output = AiOutput(locations=[_polygon_location()], start_time="09:00", end_time="17:00")

    ok = common.submit_to_api("T", "vik", "Заглавие", "Съдържание", output, "id=1")

    assert ok is True
    payload = requests_mock.last_request.json()
    # Exact contract expected by the ASP.NET AlertsController
    assert set(payload) == {"id", "category", "original_message", "processed_data"}
    assert payload["category"] == "vik"
    assert payload["original_message"] == {"title": "Заглавие", "content": "Съдържание"}
    assert payload["processed_data"]["start_time"] == "09:00"
    assert payload["processed_data"]["end_time"] == "17:00"
    assert payload["processed_data"]["locations"][0]["location_name"] == "гр. Варна"
    assert payload["processed_data"]["locations"][0]["is_polygon"] is True


def test_submit_to_api_http_error_returns_false(requests_mock):
    requests_mock.post(cfg.ASP_API_URL, status_code=500)
    ok = common.submit_to_api("T", "vik", "t", "c", AiOutput(), "id=1")
    assert ok is False


def test_submit_to_api_connection_error_returns_false(requests_mock):
    import requests as requests_lib
    requests_mock.post(cfg.ASP_API_URL, exc=requests_lib.ConnectionError)
    ok = common.submit_to_api("T", "vik", "t", "c", AiOutput(), "id=1")
    assert ok is False


# ---------------------------------------------------------------------------
# process_and_submit (orchestration)
# ---------------------------------------------------------------------------

def test_process_and_submit_full_flow(monkeypatch, requests_mock):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: VALID_AI_JSON)
    requests_mock.post(cfg.ASP_API_URL, status_code=200)

    ok = common.process_and_submit(
        "T", "vik", "prompt", "Заглавие", "Съдържание", None, "id=1")

    assert ok is True
    payload = requests_mock.last_request.json()
    assert payload["original_message"]["title"] == "Заглавие"


def test_process_and_submit_joins_title_and_content_for_ai(monkeypatch, requests_mock):
    seen = {}

    def fake_ai_parse(prompt, content, **kwargs):
        seen["content"] = content
        return VALID_AI_JSON

    monkeypatch.setattr(common.ai_parser, "ai_parse", fake_ai_parse)
    requests_mock.post(cfg.ASP_API_URL, status_code=200)

    common.process_and_submit("T", "vik", "prompt", "Заглавие", "Съдържание", None, "id=1")

    assert seen["content"] == "Заглавие\nСъдържание"


def test_process_and_submit_ai_failure_skips_submission(monkeypatch, requests_mock):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: None)
    requests_mock.post(cfg.ASP_API_URL, status_code=200)

    ok = common.process_and_submit("T", "vik", "prompt", "t", "c", None, "id=1")

    assert ok is False
    assert requests_mock.call_count == 0
