"""Tests for run.py's CLI and --once single-pass mode."""

import asyncio

import run


def test_parse_args_default_is_loop_mode():
    assert run.parse_args([]).once is False


def test_parse_args_once_flag():
    assert run.parse_args(["--once"]).once is True


def test_run_once_runs_every_service_exactly_once(monkeypatch):
    calls: list[str] = []
    fake_services = [
        ("A", lambda: calls.append("A"), None),
        ("B", lambda: calls.append("B"), 300),
        ("C", lambda: calls.append("C"), None),
    ]
    monkeypatch.setattr(run, "SERVICES", fake_services)

    asyncio.run(run.run_once())

    assert sorted(calls) == ["A", "B", "C"]


def test_run_once_isolates_service_failures(monkeypatch):
    calls: list[str] = []

    def broken():
        raise RuntimeError("source website down")

    fake_services = [
        ("Broken", broken, None),
        ("Healthy", lambda: calls.append("Healthy"), None),
    ]
    monkeypatch.setattr(run, "SERVICES", fake_services)

    # Must not raise: a broken source is logged, the others still run.
    asyncio.run(run.run_once())

    assert calls == ["Healthy"]
