"""Unit tests for the per-source service main loops.

Everything external (HTTP, Mongo state, Postgres, the AI pipeline) is
patched out — these tests only verify the crawl/orchestration logic.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from processing import ai_parser
from services import common
from services import epro_service, heating_service, roads_service
from services import varnatraffic_service, vik_service


def _response(text="<html></html>", json_data=None):
    resp = SimpleNamespace(text=text)
    if json_data is not None:
        resp.json = lambda: json_data
    return resp


@pytest.fixture
def no_pg(monkeypatch):
    """Polygon DB is not needed for loop-logic tests."""
    monkeypatch.setattr(common, "open_pg_connection", lambda tag: None)


# ---------------------------------------------------------------------------
# VIK — numeric-cursor crawl of vikvarna.com
# ---------------------------------------------------------------------------

class TestVikService:

    @pytest.fixture
    def env(self, monkeypatch, no_pg):
        """Patch all collaborators; returns a namespace to tweak per test."""
        state = SimpleNamespace(
            stored_id=1050,
            written_ids=[],
            urls=[
                "https://vikvarna.com/bg/messages/1053.html",
                "https://vikvarna.com/bg/messages/1052.html",
                "https://vikvarna.com/bg/messages/1050.html",
                "https://vikvarna.com/bg/messages/1049.html",
            ],
            message={"title": "Заглавие", "date": None, "content": "Съдържание"},
            processed=[],
            fetch_failures=set(),
        )

        def fake_fetch(url, *a, **k):
            if url in state.fetch_failures:
                raise RuntimeError("boom")
            return _response()

        monkeypatch.setattr(vik_service, "get_last_id", lambda src: state.stored_id)
        monkeypatch.setattr(vik_service, "write_last_id",
                            lambda src, i: state.written_ids.append((src, i)))
        monkeypatch.setattr(vik_service, "fetch_page", fake_fetch)
        monkeypatch.setattr(vik_service, "vik_parse_page", lambda html: state.urls)
        monkeypatch.setattr(vik_service, "vik_parse_message", lambda html: state.message)
        monkeypatch.setattr(
            common, "process_and_submit",
            lambda tag, cat, prompt, title, content, conn, ref:
                state.processed.append(ref) or True)
        return state

    def test_processes_only_messages_newer_than_stored_id(self, env):
        vik_service.main()
        # 1053 and 1052 are new (collection stops at 1050 <= stored) and are
        # processed oldest-first so the cursor only ever covers successes
        assert env.processed == ["id=1052", "id=1053"]
        assert env.written_ids == [("vik", 1053)]

    def test_no_new_messages_does_not_rewrite_state(self, env):
        env.stored_id = 1053
        vik_service.main()
        assert env.processed == []
        assert env.written_ids == []

    def test_url_without_numeric_id_is_skipped(self, env):
        env.urls = ["https://vikvarna.com/bg/messages/nonumber.htm",
                    "https://vikvarna.com/bg/messages/1052.html"]
        vik_service.main()
        assert env.processed == ["id=1052"]

    def test_listing_fetch_failure_stops_without_touching_state(self, env, monkeypatch):
        def boom(url, *a, **k):
            raise RuntimeError("network down")
        monkeypatch.setattr(vik_service, "fetch_page", boom)
        vik_service.main()
        assert env.processed == []
        assert env.written_ids == []

    def test_unparseable_listing_stops_without_touching_state(self, env, monkeypatch):
        monkeypatch.setattr(vik_service, "vik_parse_page", lambda html: None)
        vik_service.main()
        assert env.processed == []
        assert env.written_ids == []

    def test_message_fetch_failure_keeps_cursor_for_retry(self, env):
        # 1052 (older) succeeds, then 1053 fails to fetch: the cursor stops at
        # 1052 so 1053 is retried next run instead of being skipped forever
        env.fetch_failures = {"https://vikvarna.com/bg/messages/1053.html"}
        vik_service.main()
        assert env.processed == ["id=1052"]
        assert env.written_ids == [("vik", 1052)]

    def test_unparseable_message_stops_cursor_for_retry(self, env, monkeypatch):
        monkeypatch.setattr(vik_service, "vik_parse_message", lambda html: None)
        vik_service.main()
        assert env.processed == []
        assert env.written_ids == []

    def test_failed_submission_stops_cursor_for_retry(self, env, monkeypatch):
        monkeypatch.setattr(
            common, "process_and_submit",
            lambda tag, cat, prompt, title, content, conn, ref:
                env.processed.append(ref) or False)
        vik_service.main()
        # Oldest fails -> stop immediately; nothing persisted, all retried
        assert env.processed == ["id=1052"]
        assert env.written_ids == []

    def test_pg_connection_closed_and_run_survives_processing_exception(self, env, monkeypatch):
        conn = MagicMock()
        monkeypatch.setattr(common, "open_pg_connection", lambda tag: conn)

        def boom(*a, **k):
            raise RuntimeError("unexpected")
        monkeypatch.setattr(common, "process_and_submit", boom)

        vik_service.main()  # exception is contained; treated as a failed message
        conn.close.assert_called_once()
        assert env.written_ids == []


# ---------------------------------------------------------------------------
# Heating — same shape as VIK, /node/<id> urls
# ---------------------------------------------------------------------------

class TestHeatingService:

    @pytest.fixture
    def env(self, monkeypatch, no_pg):
        state = SimpleNamespace(written_ids=[], processed=[])
        monkeypatch.setattr(heating_service, "get_last_id", lambda src: 910)
        monkeypatch.setattr(heating_service, "write_last_id",
                            lambda src, i: state.written_ids.append((src, i)))
        monkeypatch.setattr(heating_service, "fetch_page", lambda url, *a, **k: _response())
        monkeypatch.setattr(heating_service, "heating_parse_page",
                            lambda html, base: [
                                "https://energy-varna.bg/bg/node/912",
                                "https://energy-varna.bg/bg/node/911",
                                "https://energy-varna.bg/bg/node/910",
                            ])
        monkeypatch.setattr(heating_service, "heating_parse_message",
                            lambda html: {"title": "Т", "content": "С"})
        monkeypatch.setattr(
            common, "process_and_submit",
            lambda tag, cat, prompt, title, content, conn, ref:
                state.processed.append((cat, ref)) or True)
        return state

    def test_processes_new_nodes_and_persists_latest(self, env):
        heating_service.main()
        assert env.processed == [("heating", "id=911"), ("heating", "id=912")]
        assert env.written_ids == [("heating", 912)]


# ---------------------------------------------------------------------------
# EPRO — JSON endpoint, hash-based seen-ids
# ---------------------------------------------------------------------------

class TestEproService:

    def test_entry_id_is_stable_and_content_sensitive(self):
        a = epro_service._entry_id("period", "text")
        assert a == epro_service._entry_id("period", "text")
        assert a != epro_service._entry_id("period", "other")
        assert len(a) == 24

    def _areas(self):
        return [
            {"area_name": "София"},
            {
                "area_name": "Варна",
                "area_locations_for_next_48_hours":
                    '[{"location_period": "<b>10.06 09:00-17:00</b>",'
                    ' "location_text": "гр. Варна ул. Дубровник'
                    ' Публикувано на 09.06.2026 <a href=\'#\'>портал</a>"}]',
                "area_locations_all_active": "[]",
            },
        ]

    @pytest.fixture
    def env(self, monkeypatch, no_pg):
        state = SimpleNamespace(
            areas=self._areas(), seen=[], added=[], submissions=[], submit_ok=True)
        monkeypatch.setattr(epro_service, "fetch_page",
                            lambda url, *a, **k: _response(json_data=state.areas))
        monkeypatch.setattr(epro_service, "get_seen_ids", lambda src: state.seen)
        monkeypatch.setattr(epro_service, "add_seen_ids",
                            lambda src, ids: state.added.append((src, ids)))
        monkeypatch.setattr(
            common, "process_and_submit",
            lambda tag, cat, prompt, title, content, conn, ref:
                state.submissions.append((title, content)) or state.submit_ok)
        return state

    def test_fetch_varna_entries_selects_configured_area(self, env):
        entries = epro_service._fetch_varna_entries()
        assert len(entries) == 1
        assert "Дубровник" in entries[0]["location_text"]

    def test_fetch_varna_entries_area_missing_returns_none(self, env):
        env.areas = [{"area_name": "София"}]
        assert epro_service._fetch_varna_entries() is None

    def test_fetch_varna_entries_bad_bucket_json_is_skipped(self, env):
        env.areas[1]["area_locations_for_next_48_hours"] = "{broken"
        assert epro_service._fetch_varna_entries() == []

    def test_fetch_varna_entries_http_failure_returns_none(self, env, monkeypatch):
        def boom(url, *a, **k):
            raise RuntimeError("down")
        monkeypatch.setattr(epro_service, "fetch_page", boom)
        assert epro_service._fetch_varna_entries() is None

    def test_main_strips_html_and_boilerplate_footer(self, env):
        epro_service.main()
        assert len(env.submissions) == 1
        title, content = env.submissions[0]
        assert title == epro_service.TITLE
        assert content == "10.06 09:00-17:00\nгр. Варна ул. Дубровник"
        assert env.added[0][0] == "epro"
        assert len(env.added[0][1]) == 1

    def test_main_skips_already_seen_entries(self, env):
        expected_id = epro_service._entry_id(
            "10.06 09:00-17:00", "гр. Варна ул. Дубровник")
        env.seen = [expected_id]
        epro_service.main()
        assert env.submissions == []
        assert env.added == [("epro", [])]

    def test_main_failed_submission_not_marked_seen(self, env):
        env.submit_ok = False
        epro_service.main()
        assert len(env.submissions) == 1
        assert env.added == [("epro", [])]


# ---------------------------------------------------------------------------
# ROADS — relevance-filtered news, URL-path seen-ids
# ---------------------------------------------------------------------------

class TestRoadsService:

    ITEM = {"url": "https://www.api.bg/bg/novini/remont", "title": "t", "date": None}

    @pytest.fixture
    def env(self, monkeypatch):
        state = SimpleNamespace(
            items=[dict(self.ITEM)],
            article={"title": "Ремонт", "date": None,
                     "content": "Ограничения край Варна по АМ Хемус."},
            ai_json='{"is_relevant": true, "summary": "Ограничено движение край Варна."}',
            seen=[], added=[], submitted=[], submit_ok=True, ai_calls=[],
        )
        monkeypatch.setattr(roads_service, "fetch_page", lambda url, *a, **k: _response())
        monkeypatch.setattr(roads_service, "roads_parse_page", lambda html: state.items)
        monkeypatch.setattr(roads_service, "roads_parse_article", lambda html: state.article)
        monkeypatch.setattr(ai_parser, "ai_parse",
                            lambda prompt, text: state.ai_calls.append(text) or state.ai_json)
        monkeypatch.setattr(roads_service, "get_seen_ids", lambda src: state.seen)
        monkeypatch.setattr(roads_service, "add_seen_ids",
                            lambda src, ids: state.added.append((src, ids)))
        monkeypatch.setattr(
            common, "submit_to_api",
            lambda tag, cat, title, content, ai_output, ref:
                state.submitted.append((cat, title, content, ai_output)) or state.submit_ok)
        return state

    def test_relevant_article_is_submitted_as_citywide_broadcast(self, env):
        roads_service.main()
        assert len(env.submitted) == 1
        cat, title, content, ai_output = env.submitted[0]
        assert cat == "roads"
        assert title == "Ремонт"
        assert content == "Ограничено движение край Варна."
        assert ai_output.locations == []  # broadcast: empty locations
        assert env.added == [("roads", ["/bg/novini/remont"])]

    def test_article_not_mentioning_varna_skipped_without_ai_call(self, env):
        env.article = {"title": "Ремонт", "date": None, "content": "София"}
        roads_service.main()
        assert env.ai_calls == []
        assert env.submitted == []
        # ...but still marked processed so it is never re-fetched
        assert env.added == [("roads", ["/bg/novini/remont"])]

    def test_irrelevant_article_marked_processed_without_submission(self, env):
        env.ai_json = '{"is_relevant": false, "summary": null}'
        roads_service.main()
        assert env.submitted == []
        assert env.added == [("roads", ["/bg/novini/remont"])]

    def test_already_seen_article_not_refetched(self, env):
        env.seen = ["/bg/novini/remont"]
        roads_service.main()
        assert env.ai_calls == []
        assert env.added == [("roads", [])]

    def test_article_fetch_failure_not_marked_processed(self, env, monkeypatch):
        calls = {"n": 0}

        def fetch(url, *a, **k):
            calls["n"] += 1
            if calls["n"] > 1:  # first call fetches the listing page
                raise RuntimeError("down")
            return _response()

        monkeypatch.setattr(roads_service, "fetch_page", fetch)
        roads_service.main()
        # Not marked seen -> will be retried next run
        assert env.added == [("roads", [])]

    def test_ai_failure_not_marked_processed(self, env, monkeypatch):
        monkeypatch.setattr(ai_parser, "ai_parse", lambda p, t: None)
        roads_service.main()
        assert env.submitted == []
        assert env.added == [("roads", [])]

    def test_failed_submission_not_marked_processed(self, env):
        env.submit_ok = False
        roads_service.main()
        assert env.added == [("roads", [])]


# ---------------------------------------------------------------------------
# VT — VarnaTraffic accordion messages
# ---------------------------------------------------------------------------

class TestVarnaTrafficService:

    @pytest.fixture
    def env(self, monkeypatch):
        state = SimpleNamespace(
            messages=[
                {"data_id": "778", "header": "Линия 31А", "body": "обходен маршрут",
                 "info_time": "10.06"},
                {"data_id": "777", "header": "Линия 209", "body": "не обслужва Явор",
                 "info_time": "09.06"},
            ],
            seen=[], added=[], ai_calls=[], submitted=[], submit_ok=True,
            ai_json='{"bus_lines": ["31A"]}',
        )
        monkeypatch.setattr(varnatraffic_service, "fetch_page",
                            lambda url, *a, **k: _response())
        monkeypatch.setattr(varnatraffic_service, "vt_parse", lambda html: state.messages)
        monkeypatch.setattr(ai_parser, "ai_parse",
                            lambda prompt, text: state.ai_calls.append(text) or state.ai_json)
        monkeypatch.setattr(varnatraffic_service, "get_seen_ids", lambda src: state.seen)
        monkeypatch.setattr(varnatraffic_service, "add_seen_ids",
                            lambda src, ids: state.added.append((src, ids)))
        monkeypatch.setattr(
            common, "submit_to_api",
            lambda tag, cat, title, content, ai_output, ref:
                state.submitted.append((cat, title, content, ai_output)) or state.submit_ok)
        return state

    def test_new_messages_are_submitted_and_ids_persisted(self, env):
        varnatraffic_service.main()
        assert len(env.ai_calls) == 2
        assert len(env.submitted) == 2
        cat, title, content, ai_output = env.submitted[0]
        assert cat == "vt"
        assert title == "Линия 31А"
        assert "Засегнати линии: 31A" in content
        assert ai_output.locations == []  # broadcast: empty locations
        assert ai_output.city_wide is True
        assert ai_output.bus_lines == ["31A"]  # API narrows to subscribers
        assert env.added == [("vt", ["778", "777"])]

    def test_seen_messages_are_filtered_out(self, env):
        env.seen = ["777"]
        varnatraffic_service.main()
        assert len(env.ai_calls) == 1
        assert "Линия 31А" in env.ai_calls[0]
        assert env.added == [("vt", ["778"])]

    def test_no_new_messages_does_not_write_state(self, env):
        env.seen = ["778", "777"]
        varnatraffic_service.main()
        assert env.ai_calls == []
        assert env.added == []

    def test_irrelevant_message_marked_seen_without_submission(self, env):
        env.ai_json = '{"bus_lines": null}'
        varnatraffic_service.main()
        assert env.submitted == []
        assert env.added == [("vt", ["778", "777"])]

    def test_ai_failure_skips_message_and_id_not_persisted(self, env, monkeypatch):
        monkeypatch.setattr(ai_parser, "ai_parse", lambda p, t: None)
        varnatraffic_service.main()
        # Failed messages are retried next run
        assert env.submitted == []
        assert env.added == [("vt", [])]

    def test_failed_submission_not_marked_seen(self, env):
        env.submit_ok = False
        varnatraffic_service.main()
        assert len(env.submitted) == 2
        assert env.added == [("vt", [])]

    def test_page_parse_failure_stops_without_writing_state(self, env, monkeypatch):
        monkeypatch.setattr(varnatraffic_service, "vt_parse", lambda html: None)
        varnatraffic_service.main()
        assert env.added == []
