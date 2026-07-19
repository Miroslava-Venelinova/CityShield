"""Integration test: the shared pipeline against a real local HTTP server.

A stub server plays the role of the ASP.NET AlertsController and records
what the Python side actually sends, verifying the cross-language contract
(same fields AlertsController.SubmitData reads). Only the LLM is faked.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from config import cfg
from services import common

pytestmark = pytest.mark.integration


class _StubApiHandler(BaseHTTPRequestHandler):
    status_code = 200
    received: list[dict] = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        type(self).received.append({"path": self.path, "body": body})
        self.send_response(type(self).status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"notified_count": 0, "user_ids": []}')

    def log_message(self, *args):  # keep pytest output clean
        pass


@pytest.fixture
def stub_api(monkeypatch):
    _StubApiHandler.received = []
    _StubApiHandler.status_code = 200
    server = HTTPServer(("127.0.0.1", 0), _StubApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    port = server.server_address[1]
    monkeypatch.setattr(
        cfg, "ASP_API_URL", f"http://127.0.0.1:{port}/api/alerts/submit-data")
    yield _StubApiHandler
    server.shutdown()
    thread.join(timeout=5)


AI_RESULT = json.dumps({
    "locations": [
        {"location_name": "гр. Варна",
         "sublocations": ["ул. Дубровник", "ул. Студентска"],
         "is_polygon": False},
    ],
    "start_time": "09:00",
    "end_time": "17:00",
})


def test_process_and_submit_posts_exact_api_contract(stub_api, monkeypatch):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: AI_RESULT)

    ok = common.process_and_submit(
        "IT", "vik", common.OUTAGE_AI_PROMPT,
        "Авария", "Спряно водоподаване", None, "id=42")

    assert ok is True
    assert len(stub_api.received) == 1

    req = stub_api.received[0]
    assert req["path"] == "/api/alerts/submit-data"

    body = req["body"]
    # Every field AlertsController.SubmitData reads must be present:
    assert body["category"] == "vik"
    assert body["original_message"]["title"] == "Авария"
    assert body["original_message"]["content"] == "Спряно водоподаване"
    assert body["processed_data"]["start_time"] == "09:00"
    assert body["processed_data"]["end_time"] == "17:00"
    loc = body["processed_data"]["locations"][0]
    assert loc["location_name"] == "гр. Варна"
    assert loc["sublocations"] == ["ул. Дубровник", "ул. Студентска"]
    assert loc["is_polygon"] is False
    assert loc["polygon_geojson"] is None
    assert isinstance(body["id"], str) and body["id"]


def test_process_and_submit_handles_api_rejection(stub_api, monkeypatch):
    monkeypatch.setattr(common.ai_parser, "ai_parse", lambda p, c, **kw: AI_RESULT)
    stub_api.status_code = 400

    ok = common.process_and_submit(
        "IT", "vik", common.OUTAGE_AI_PROMPT, "t", "c", None, "id=43")

    assert ok is False
