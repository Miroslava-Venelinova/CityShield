"""Unit tests for processing/ai_parser.py — model providers are always mocked."""

import json
from types import SimpleNamespace

import pytest

from processing import ai_parser


def _ollama_response(content: str) -> dict:
    return {
        "message": {"content": content},
        "prompt_eval_count": 10,
        "eval_count": 5,
    }


@pytest.fixture
def cache_disabled(monkeypatch):
    monkeypatch.setattr(ai_parser, "PERSISTENT_CACHE_ENABLED", False)


@pytest.fixture
def cache_file(monkeypatch, tmp_path):
    path = tmp_path / "cache.json"
    monkeypatch.setattr(ai_parser, "PERSISTENT_CACHE_ENABLED", True)
    monkeypatch.setattr(ai_parser, "PERSISTENT_CACHE_PATH", str(path))
    return path


# ---------------------------------------------------------------------------
# _cache_key
# ---------------------------------------------------------------------------

def test_cache_key_is_deterministic():
    assert ai_parser._cache_key("sys", "user") == ai_parser._cache_key("sys", "user")


def test_cache_key_differs_for_different_inputs():
    assert ai_parser._cache_key("sys", "a") != ai_parser._cache_key("sys", "b")
    assert ai_parser._cache_key("a", "user") != ai_parser._cache_key("b", "user")
    # The separator must prevent ("ab", "c") colliding with ("a", "bc")
    assert ai_parser._cache_key("ab", "c") != ai_parser._cache_key("a", "bc")


def test_cache_key_differs_for_different_format_schemas():
    assert ai_parser._cache_key("sys", "user") != ai_parser._cache_key("sys", "user", '{"a": 1}')
    assert ai_parser._cache_key("sys", "user", '{"a": 1}') != ai_parser._cache_key("sys", "user", '{"a": 2}')


# ---------------------------------------------------------------------------
# ai_parse — model interaction (cache off)
# ---------------------------------------------------------------------------

def test_ai_parse_returns_model_content(cache_disabled, monkeypatch):
    monkeypatch.setattr(ai_parser.ollama, "chat",
                        lambda **kw: _ollama_response('{"ok": true}'))
    assert ai_parser.ai_parse("sys", "user") == '{"ok": true}'


def test_ai_parse_passes_prompts_and_json_format(cache_disabled, monkeypatch):
    seen = {}

    def fake_chat(**kwargs):
        seen.update(kwargs)
        return _ollama_response("{}")

    monkeypatch.setattr(ai_parser.ollama, "chat", fake_chat)
    ai_parser.ai_parse("SYSTEM", "USER")

    assert seen["format"] == "json"
    assert seen["messages"] == [
        {"role": "system", "content": "SYSTEM"},
        {"role": "user", "content": "USER"},
    ]


def test_ai_parse_passes_format_schema_as_structured_output(cache_disabled, monkeypatch):
    seen = {}

    def fake_chat(**kwargs):
        seen.update(kwargs)
        return _ollama_response("{}")

    monkeypatch.setattr(ai_parser.ollama, "chat", fake_chat)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    ai_parser.ai_parse("SYSTEM", "USER", format_schema=schema)

    assert seen["format"] == schema


def test_ai_parse_ollama_exception_returns_none(cache_disabled, monkeypatch):
    def boom(**kw):
        raise RuntimeError("ollama not running")
    monkeypatch.setattr(ai_parser.ollama, "chat", boom)
    assert ai_parser.ai_parse("sys", "user") is None


def test_ai_parse_malformed_response_returns_none(cache_disabled, monkeypatch):
    monkeypatch.setattr(ai_parser.ollama, "chat", lambda **kw: {"unexpected": "shape"})
    assert ai_parser.ai_parse("sys", "user") is None


# ---------------------------------------------------------------------------
# ai_parse — persistent cache
# ---------------------------------------------------------------------------

def test_ai_parse_cache_hit_skips_model_call(cache_file, monkeypatch):
    key = ai_parser._cache_key("sys", "user")
    cache_file.write_text(json.dumps({key: "cached-result"}), encoding="utf-8")

    def fail(**kw):
        pytest.fail("ollama must not be called on a cache hit")
    monkeypatch.setattr(ai_parser.ollama, "chat", fail)

    assert ai_parser.ai_parse("sys", "user") == "cached-result"


def test_ai_parse_writes_result_to_cache(cache_file, monkeypatch):
    calls = []

    def fake_chat(**kw):
        calls.append(1)
        return _ollama_response("fresh-result")

    monkeypatch.setattr(ai_parser.ollama, "chat", fake_chat)

    assert ai_parser.ai_parse("sys", "user") == "fresh-result"
    assert ai_parser.ai_parse("sys", "user") == "fresh-result"  # second call: cache
    assert len(calls) == 1

    on_disk = json.loads(cache_file.read_text(encoding="utf-8"))
    assert on_disk[ai_parser._cache_key("sys", "user")] == "fresh-result"


def test_ai_parse_corrupt_cache_file_falls_back_to_model(cache_file, monkeypatch):
    cache_file.write_text("{corrupt json", encoding="utf-8")
    monkeypatch.setattr(ai_parser.ollama, "chat",
                        lambda **kw: _ollama_response("from-model"))
    assert ai_parser.ai_parse("sys", "user") == "from-model"


def test_ai_parse_cache_root_not_object_falls_back_to_model(cache_file, monkeypatch):
    cache_file.write_text(json.dumps(["a", "list"]), encoding="utf-8")
    monkeypatch.setattr(ai_parser.ollama, "chat",
                        lambda **kw: _ollama_response("from-model"))
    assert ai_parser.ai_parse("sys", "user") == "from-model"


# ---------------------------------------------------------------------------
# ai_parse — provider dispatch (Gemini)
# ---------------------------------------------------------------------------

def _gemini_response(text: str | None):
    return SimpleNamespace(text=text, usage_metadata=None)


@pytest.fixture
def gemini_provider(monkeypatch):
    monkeypatch.setattr(ai_parser.cfg, "AI_PROVIDER", "gemini")
    monkeypatch.setattr(ai_parser.cfg, "GEMINI_API_KEY", "test-key")
    # No real sleeping in retry tests.
    monkeypatch.setattr(ai_parser.time, "sleep", lambda s: None)
    yield
    # The lazy client is process-global; never leak a fake between tests.
    ai_parser._gemini_client = None


def _fake_gemini_client(monkeypatch, generate_content):
    client = SimpleNamespace(
        models=SimpleNamespace(generate_content=generate_content))
    monkeypatch.setattr(ai_parser, "_gemini_client", client)
    return client


def test_ai_parse_dispatches_to_gemini(cache_disabled, gemini_provider, monkeypatch):
    seen = {}

    def fake_generate(**kwargs):
        seen.update(kwargs)
        return _gemini_response('{"ok": true}')

    _fake_gemini_client(monkeypatch, fake_generate)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}

    assert ai_parser.ai_parse("SYSTEM", "USER", format_schema=schema) == '{"ok": true}'
    assert seen["contents"] == "USER"
    assert seen["config"].system_instruction == "SYSTEM"
    assert seen["config"].response_mime_type == "application/json"
    assert seen["config"].response_json_schema == schema


def test_ai_parse_gemini_never_touches_ollama(cache_disabled, gemini_provider, monkeypatch):
    def fail(**kw):
        pytest.fail("ollama must not be called when AI_PROVIDER=gemini")
    monkeypatch.setattr(ai_parser.ollama, "chat", fail)
    _fake_gemini_client(monkeypatch, lambda **kw: _gemini_response("{}"))
    assert ai_parser.ai_parse("sys", "user") == "{}"


def test_ai_parse_gemini_empty_response_returns_none(cache_disabled, gemini_provider, monkeypatch):
    _fake_gemini_client(monkeypatch, lambda **kw: _gemini_response(None))
    assert ai_parser.ai_parse("sys", "user") is None


def test_ai_parse_gemini_retries_then_succeeds(cache_disabled, gemini_provider, monkeypatch):
    calls = []

    def flaky(**kw):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("transient")
        return _gemini_response("recovered")

    _fake_gemini_client(monkeypatch, flaky)
    assert ai_parser.ai_parse("sys", "user") == "recovered"
    assert len(calls) == 3


def test_ai_parse_missing_gemini_key_returns_none(cache_disabled, gemini_provider, monkeypatch):
    monkeypatch.setattr(ai_parser.cfg, "GEMINI_API_KEY", "")
    assert ai_parser.ai_parse("sys", "user") is None


# ---------------------------------------------------------------------------
# _retry_delay_seconds
# ---------------------------------------------------------------------------

def test_retry_delay_is_exponential_by_default():
    exc = RuntimeError("boom")
    assert ai_parser._retry_delay_seconds(exc, 1) == 2.0
    assert ai_parser._retry_delay_seconds(exc, 2) == 4.0


def test_retry_delay_honors_gemini_retry_delay_on_429():
    exc = RuntimeError("429 RESOURCE_EXHAUSTED ... 'retryDelay': '37s'")
    exc.code = 429
    assert ai_parser._retry_delay_seconds(exc, 1) == 37.0


def test_retry_delay_ignores_retry_delay_without_429():
    exc = RuntimeError("something mentioning 'retryDelay': '37s' but not rate-limited")
    assert ai_parser._retry_delay_seconds(exc, 1) == 2.0
