"""Unit tests for processing/ai_parser.py — Ollama is always mocked."""

import json

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
