"""
Alert review — a local UI for judging what the LLM made of a raw source message.

Ingestion turns scraped Bulgarian text into a structured alert: title, content,
severity, a time window, and locations with coordinates. That parse is
nondeterministic and sometimes wrong in ways only a person notices — a district
pinned on one of its streets, a window that landed on the wrong day, a body cut
off mid-sentence. This tool puts real rows in front of a reviewer, records a
verdict per alert, and exports a report the prompt work can be argued from.

The same defect usually spans dozens of alerts, so a finding is a first-class
object here: name it once as an *issue*, stamp it on every alert it appears in,
and the report groups by issue instead of by loose notes.

Run it with:

    python tools/alert-review/app.py [--csv alerts_export.csv]

It prints a tokenized http://127.0.0.1:<port>/?t=<token> URL and opens it. As in
the push tester, the token is checked on every call and the Host header is
pinned to loopback — this process shells out to `wrangler d1 execute --remote`,
so no other page in the browser gets to reach it.

Nothing here writes to D1: the only statement is a constant SELECT. The only
files written are judgments.json, issues.json and settings.json (all gitignored)
and whatever lands in reports/.

Standard library only: this is a developer tool that should run from a fresh
checkout without a pip install.
"""

import argparse
import csv
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import targeting

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
BACKEND_DIR = REPO_ROOT / "backend"

# One verdict per alert id, the shared issue library, and the cutoff date.
# All gitignored: one reviewer's opinions and scope, not repo data. Reports are
# the shareable artefact.
JUDGMENTS_FILE = HERE / "judgments.json"
ISSUES_FILE = HERE / "issues.json"
SETTINGS_FILE = HERE / "settings.json"
REPORTS_DIR = HERE / "reports"

D1_DATABASE = "cityshield-db"

# Constant SQL — nothing from a request is ever interpolated into a command.
# The limit is here so a year-old table can't turn one click into a 200 MB
# subprocess read; the UI says when it bites.
D1_ROW_LIMIT = 2000
ALERTS_SQL = (
    "SELECT id, category, title, content, severity, start_time, end_time, "
    "windows_json, locations_json, created_on_utc FROM alerts "
    f"ORDER BY created_on_utc DESC LIMIT {D1_ROW_LIMIT}"
)

# The four tables the Worker's targeting reads, in one call. Same statements as
# db/queries.ts, including the region_aliases union — an alias is a name a
# location can match on, so leaving it out would under-report the audience.
#
# Only opt-OUTs are stored in user_notification_preferences (migration 0004), so
# `is_enabled = 0` is the whole table's meaningful content.
AUDIENCE_SQL = (
    "SELECT id, region_name AS name, lat, lng, settlement_id FROM regions "
    "UNION ALL "
    "SELECT r.id, a.alias AS name, r.lat, r.lng, r.settlement_id "
    "FROM region_aliases a JOIN regions r ON r.id = a.region_id;"
    " SELECT id, street_name AS name, lat, lng, region_id FROM streets;"
    " SELECT user_id, email, latitude, longitude, region_id, street_id,"
    " receives_all_alerts, subscribed_bus_lines FROM users;"
    " SELECT user_id, category FROM user_notification_preferences WHERE is_enabled = 0"
)
# Positional, because that is the order D1 answers a multi-statement command in
# — but each document is checked against the columns it must have before it is
# used, so a wrangler that ever reorders them fails loudly instead of silently
# targeting streets against the users table.
AUDIENCE_TABLES = (
    ("regions", ("id", "name", "settlement_id")),
    ("streets", ("id", "name", "region_id")),
    ("users", ("user_id", "email", "region_id", "street_id")),
    ("opt_outs", ("user_id", "category")),
)

# The CSV export's columns, which are the alerts table's columns minus the
# ingestion bookkeeping (source_ref, notified_at) a reviewer has no use for.
CSV_COLUMNS = ("id", "category", "title", "content", "severity",
               "start_time", "end_time", "windows_json", "locations_json",
               "created_on_utc")

# Mirrors backend/src/shared/constants.ts. Only used for labels — an unknown
# category still loads and still shows up in the filters.
CATEGORY_LABELS = {
    "vik": "Water (ВиК)",
    "vt": "Traffic",
    "epro": "Power (ЕРП Север)",
    "heating": "Heating (Веолия)",
}

# Three dispositions, because "wrong" and "not built yet" are different work.
# There is deliberately no verdict for "too old to argue about": a backlog from
# a superseded pipeline is a property of when the alert was created, not a
# judgment about it, and the cutoff below takes those out wholesale.
VERDICTS = {
    "accurate": {"label": "Accurate", "key": "y"},
    "inaccurate": {"label": "Inaccurate", "key": "n"},
    "unimplemented": {"label": "Not implemented yet", "key": "m"},
}
# The two that describe a defect: they carry reasons and issues, and they are
# what the report is about.
FINDING_VERDICTS = ("inaccurate", "unimplemented")

# The fixed taxonomy. Order is the order the UI shows them in and the number key
# that selects each one, so appending is safe and reordering rewrites muscle
# memory. Ids are what judgments.json stores; labels live only here.
REASONS = [
    {"id": "wrong_location", "label": "Wrong location",
     "hint": "Names a place the source text doesn't, or misses one it does."},
    {"id": "wrong_coordinates", "label": "Wrong coordinates",
     "hint": "Right name, wrong pin — a district pinned on one of its streets counts."},
    {"id": "wrong_severity", "label": "Wrong severity",
     "hint": "Severity is mapped from the category, so this usually means the category is wrong."},
    {"id": "wrong_time", "label": "Wrong or garbled time",
     "hint": "Missing, swapped, on the wrong date, or not a time at all."},
    {"id": "bad_content", "label": "Truncated or garbled content",
     "hint": "Cut off mid-sentence, mojibake, or boilerplate swallowed whole."},
    {"id": "wrong_category", "label": "Wrong category",
     "hint": "Filed under the wrong source."},
    {"id": "duplicate", "label": "Duplicate",
     "hint": "The same real-world event is already stored under another id."},
    {"id": "other", "label": "Other",
     "hint": "Anything else — say what in the note."},
]
REASON_IDS = {reason["id"] for reason in REASONS}
REASON_LABELS = {reason["id"]: reason["label"] for reason in REASONS}

MAX_NOTE_LENGTH = 2000
MAX_TITLE_LENGTH = 120

# Enough to keep an issue id readable when the title is written in Bulgarian.
CYRILLIC_TO_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p",
    "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch",
    "ш": "sh", "щ": "sht", "ъ": "a", "ь": "y", "ю": "yu", "я": "ya",
}


class ToolError(Exception):
    """Anything the UI should show as a message rather than a stack trace."""


# Guards the judgments mirror, the issue library and the loaded dataset. One
# reviewer, but ThreadingHTTPServer means a save and a report can still overlap.
_lock = threading.Lock()
_judgments: dict[str, dict] = {}
_issues: dict[str, dict] = {}
_dataset: dict = {"source": "", "detail": "", "loaded_at": "", "truncated": False, "alerts": []}
# The one setting: alerts created before this local date are out of scope
# entirely. "" means everything loaded is in scope.
_cutoff: str = ""
# The regions/streets/users/preferences snapshot the audience is computed
# against, or None when there is none — a CSV carries alerts and nothing else,
# and a database whose users table could not be read has to say so rather than
# answer "nobody".
_audience: targeting.Tables | None = None
_audience_error: str = ""


# ── the JSON stores ───────────────────────────────────────────────────────────


def read_store(path: Path) -> dict[str, dict]:
    """
    The judgments and the issues are plain {id: object} maps so they can be
    eyeballed and scripted against. A corrupt one is not silently discarded —
    losing a review session to a stray keystroke would be worse than failing to
    start. (settings.json is the exception, see read_cutoff.)
    """
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path} is not valid JSON ({e}). Fix or move it, then rerun.")
    if not isinstance(data, dict):
        raise SystemExit(f"{path} should be an object keyed by id.")
    return {str(k): v for k, v in data.items() if isinstance(v, dict)}


def write_store_locked(path: Path, store: dict) -> None:
    """
    Whole-file rewrite through a temp file, on every change. Sorted keys and an
    indent keep the diff readable; os.replace keeps a crash from truncating the
    session's work.
    """
    payload = json.dumps(store, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temp = path.with_suffix(".json.tmp")
    temp.write_text(payload, encoding="utf-8")
    os.replace(temp, path)


# ── the cutoff ────────────────────────────────────────────────────────────────


def read_cutoff() -> str:
    """A corrupt settings file is not worth failing to start over — the cutoff
    is one date the reviewer can retype, unlike a session's verdicts."""
    if not SETTINGS_FILE.exists():
        return ""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        return valid_cutoff(data.get("cutoff", "")) if isinstance(data, dict) else ""
    except (json.JSONDecodeError, ToolError, OSError):
        return ""


def valid_cutoff(value) -> str:
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise ToolError(f"A cutoff is a date like 2026-07-01, not {value!r}.")


def set_cutoff(value) -> dict:
    """
    Move the line between "this review is about it" and "this predates the
    question". Nothing is deleted: the alerts stay loaded and come straight back
    when the cutoff moves or clears, and judgments made before it was set keep
    their entry in the file.
    """
    global _cutoff
    value = valid_cutoff(value)
    with _lock:
        _cutoff = value
        write_store_locked(SETTINGS_FILE, {"cutoff": value})
    return dataset_payload()


def local_day(created_on_utc: str) -> str:
    """
    The local calendar day an alert was created on, as `YYYY-MM-DD`.

    `created_on_utc` really is an instant (unlike start_time/end_time — see the
    README), so it converts rather than reformats. Computed once per alert on
    load: the cutoff, the created-from/to filter and the browser all compare
    the same string, and 2000 rows are not reparsed on every request.
    """
    text = (created_on_utc or "").strip()
    if not text:
        return ""
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone().strftime("%Y-%m-%d")


def in_scope(alert: dict) -> bool:
    # An alert whose timestamp will not parse is always in scope: hiding a row
    # because its date is unreadable is exactly the kind of silent loss this
    # tool exists to catch.
    return not _cutoff or not alert["created_day"] or alert["created_day"] >= _cutoff


def visible() -> list:
    """The alerts this review is about — everything loaded, minus what the
    cutoff puts out of scope. Every count, list and report goes through here."""
    return [alert for alert in _dataset["alerts"] if in_scope(alert)]


# ── issues ────────────────────────────────────────────────────────────────────


def slugify(text: str) -> str:
    out: list[str] = []
    for char in text.strip().lower():
        if char.isascii() and char.isalnum():
            out.append(char)
        elif char in CYRILLIC_TO_LATIN:
            out.append(CYRILLIC_TO_LATIN[char])
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")[:60]


def save_issue(issue_id: str, title: str, kind: str, reasons: list, detail: str) -> dict:
    """
    Create or update a named finding. An `inaccurate` issue must carry at least
    one reason, so that stamping it on an untouched alert can always produce a
    valid judgment without asking anything further.
    """
    title = (title or "").strip()[:MAX_TITLE_LENGTH]
    if not title:
        raise ToolError("An issue needs a title.")
    if kind not in FINDING_VERDICTS:
        raise ToolError(f"An issue is either {' or '.join(FINDING_VERDICTS)}, not {kind!r}.")

    reasons = clean_reasons(reasons)
    if kind == "inaccurate" and not reasons:
        raise ToolError("An inaccurate issue needs at least one reason.")

    issue_id = (issue_id or "").strip()
    with _lock:
        if issue_id and issue_id not in _issues:
            raise ToolError(f"No such issue: {issue_id}")
        if not issue_id:
            base = slugify(title) or "issue"
            issue_id = base
            n = 2
            while issue_id in _issues:
                issue_id, n = f"{base}-{n}", n + 1

        _issues[issue_id] = {
            "title": title,
            "kind": kind,
            "reasons": reasons,
            "detail": (detail or "").strip()[:MAX_NOTE_LENGTH],
            "created_at": _issues.get(issue_id, {}).get("created_at") or now_utc(),
        }
        write_store_locked(ISSUES_FILE, _issues)
    return {"issue_id": issue_id, **state_payload()}


def delete_issue(issue_id: str) -> dict:
    """
    Removing an issue unstamps it everywhere. The judgments themselves survive
    with their verdict, reasons and note — only the grouping is withdrawn.
    """
    with _lock:
        if issue_id not in _issues:
            raise ToolError(f"No such issue: {issue_id}")
        del _issues[issue_id]
        touched = 0
        for judgment in _judgments.values():
            if issue_id in judgment.get("issues", []):
                judgment["issues"] = [i for i in judgment["issues"] if i != issue_id]
                if not judgment["issues"]:
                    del judgment["issues"]
                touched += 1
        write_store_locked(ISSUES_FILE, _issues)
        if touched:
            write_store_locked(JUDGMENTS_FILE, _judgments)
    return {"unstamped": touched, **state_payload()}


def stamp(issue_id: str, alert_ids: list) -> dict:
    """
    Apply one issue to many alerts in a single pass — the answer to "this same
    thing is wrong in forty of them". An untouched alert takes the issue's
    verdict and reasons; an alert already judged keeps its verdict and gains the
    issue. Alerts judged accurate are left alone rather than silently overruled,
    and the count of those comes back for the UI to report.
    """
    with _lock:
        issue = _issues.get(issue_id)
        if issue is None:
            raise ToolError(f"No such issue: {issue_id}")

        known = {alert["id"] for alert in visible()}
        stamped, skipped = 0, 0
        for alert_id in dict.fromkeys(str(i) for i in alert_ids):
            if alert_id not in known:
                continue
            judgment = _judgments.get(alert_id)
            if judgment and judgment.get("verdict") == "accurate":
                skipped += 1
                continue
            if judgment is None:
                judgment = {"verdict": issue["kind"], "reasons": [], "note": ""}
                _judgments[alert_id] = judgment

            issues = set(judgment.get("issues", [])) | {issue_id}
            judgment["issues"] = sorted(issues)
            judgment["reasons"] = order_reasons(set(judgment.get("reasons", [])) | set(issue["reasons"]))
            judgment["judged_at"] = now_utc()
            annotate(alert_id, judgment)
            stamped += 1

        if stamped:
            write_store_locked(JUDGMENTS_FILE, _judgments)
    return {"stamped": stamped, "skipped": skipped, **state_payload()}


# ── judgments ─────────────────────────────────────────────────────────────────


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_reasons(reasons: list) -> list:
    values = [r for r in (reasons or []) if isinstance(r, str)]
    unknown = [r for r in values if r not in REASON_IDS]
    if unknown:
        raise ToolError(f"Unknown reason(s): {', '.join(unknown)}")
    return order_reasons(set(values))


def order_reasons(values: set) -> list:
    """Taxonomy order rather than click order, so two alerts flagged for the
    same things produce the same line in the file."""
    return [reason["id"] for reason in REASONS if reason["id"] in values]


def annotate(alert_id: str, judgment: dict) -> None:
    """A title snapshot so the file reads as something on its own, and so a
    report can still name an alert that has since aged out of the dataset."""
    alert = find_alert(alert_id)
    if alert:
        judgment["title"] = alert["title"][:200]
        judgment["category"] = alert["category"]


def judge(alert_id: str, verdict: str, reasons: list, note: str,
          issues: list, important: bool) -> dict:
    """
    Record one verdict, written to disk before returning: the reviewer is going
    to close this tab without ceremony, and a batched save would lose the tail
    of the session.
    """
    alert_id = (alert_id or "").strip()
    if not alert_id:
        raise ToolError("No alert id.")

    if verdict in ("", None, "unreviewed"):
        with _lock:
            _judgments.pop(alert_id, None)
            write_store_locked(JUDGMENTS_FILE, _judgments)
        return {"id": alert_id, "judgment": None, **state_payload()}

    if verdict not in VERDICTS:
        raise ToolError(f"Unknown verdict: {verdict}")

    reasons = clean_reasons(reasons)
    issues = [i for i in (issues or []) if isinstance(i, str)]
    unknown = [i for i in issues if i not in _issues]
    if unknown:
        raise ToolError(f"Unknown issue(s): {', '.join(unknown)}")

    if verdict == "inaccurate" and not reasons:
        raise ToolError("An inaccurate alert needs at least one reason.")
    if verdict not in FINDING_VERDICTS:
        # Nothing is wrong with it, or it is out of scope: reasons and issues
        # would be dangling claims about an alert nobody is going to fix.
        reasons, issues = [], []

    entry = {
        "verdict": verdict,
        "reasons": reasons,
        "note": (note or "").strip()[:MAX_NOTE_LENGTH],
        "judged_at": now_utc(),
    }
    # Written only when set, so the common entry stays two lines and an older
    # file keeps its exact shape.
    if issues:
        entry["issues"] = sorted(set(issues))
    if important and verdict in FINDING_VERDICTS:
        entry["important"] = True
    annotate(alert_id, entry)

    with _lock:
        _judgments[alert_id] = entry
        write_store_locked(JUDGMENTS_FILE, _judgments)
    return {"id": alert_id, "judgment": entry, **state_payload()}


def find_alert(alert_id: str) -> dict | None:
    for alert in _dataset["alerts"]:
        if alert["id"] == alert_id:
            return alert
    return None


def counts() -> dict:
    """Progress over the alerts in scope — judgments for alerts that aren't
    loaded, or that the cutoff excludes, are real but are not this session's
    remaining work."""
    loaded = visible()
    judged = [_judgments[a["id"]] for a in loaded if a["id"] in _judgments]
    tally = {verdict: sum(1 for j in judged if j.get("verdict") == verdict) for verdict in VERDICTS}
    return {
        **tally,
        "loaded": len(loaded),
        "judged": len(judged),
        "unreviewed": len(loaded) - len(judged),
        "important": sum(1 for j in judged if j.get("important")),
        "excluded": len(_dataset["alerts"]) - len(loaded),
        "orphans": len(_judgments) - len(judged),
    }


# ── loading alerts ────────────────────────────────────────────────────────────


def normalize(row: dict) -> dict | None:
    """
    One CSV/D1 row into what the UI reviews. locations_json is parsed here
    rather than in the browser, because a row that fails to parse is itself a
    finding — the Worker degrades that alert to no locations at all.
    """
    alert_id = str(row.get("id") or "").strip()
    if not alert_id:
        return None

    raw = row.get("locations_json")
    raw = "" if raw is None else str(raw).strip()
    locations: list = []
    error = ""
    if raw and raw != "[]":
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as e:
            error = f"locations_json is not valid JSON: {e}"
            parsed = None
        if parsed is not None:
            if isinstance(parsed, list):
                locations = [item for item in parsed if isinstance(item, dict)]
                if len(locations) != len(parsed):
                    error = "locations_json has entries that are not objects."
            else:
                error = "locations_json is not a JSON array."

    def text(key: str) -> str:
        value = row.get(key)
        return "" if value is None else str(value)

    return {
        "id": alert_id,
        "category": text("category"),
        "title": text("title"),
        "content": text("content"),
        "severity": text("severity"),
        "start_time": text("start_time"),
        "end_time": text("end_time"),
        # Migration 0012: the daily recurrence / extra windows the start-end
        # envelope cannot hold. NULL on every alert whose envelope says it all.
        "windows_json": text("windows_json"),
        "locations_json": raw,
        "locations": locations,
        "locations_error": error,
        "created_on_utc": text("created_on_utc"),
        "created_day": local_day(text("created_on_utc")),
        # Which columns are SQL NULL, so the raw view can show `null` where the
        # row means it rather than the empty string every other field is
        # normalized to. Always empty for a CSV, which cannot express NULL.
        "null_columns": [c for c in CSV_COLUMNS if row.get(c) is None],
    }


def set_dataset(source: str, detail: str, rows: list, truncated: bool) -> dict:
    alerts = [alert for alert in (normalize(row) for row in rows) if alert]
    with _lock:
        _dataset.update({
            "source": source,
            "detail": detail,
            "loaded_at": datetime.now().strftime("%d.%m.%Y %H:%M"),
            "truncated": truncated,
            "alerts": alerts,
            "skipped": len(rows) - len(alerts),
        })
    return dataset_payload()


def state_payload() -> dict:
    """Everything the page mirrors, minus the alerts themselves — returned by
    every mutation so the UI never has to guess what the file now says."""
    return {"judgments": _judgments, "issues": _issues, "counts": counts()}


def audience_state() -> dict:
    """Whether "who gets notified" can be answered at all, and why not when it
    cannot — an empty audience and an unavailable one are different findings."""
    if _audience is None:
        return {"available": False, "detail": _audience_error
                or "No user data loaded. Pick a D1 database to see who an alert notifies."}
    return {
        "available": True,
        "users": len(_audience.users),
        "regions": len(_audience.regions),
        "streets": len(_audience.streets),
        "detail": f"{len(_audience.users)} user(s) from {_audience.scope}, "
                  f"loaded {_audience.loaded_at}",
    }


def dataset_payload() -> dict:
    return {
        "source": _dataset["source"],
        "detail": _dataset["detail"],
        "loaded_at": _dataset["loaded_at"],
        "truncated": _dataset["truncated"],
        "skipped": _dataset.get("skipped", 0),
        "cutoff": _cutoff,
        "audience": audience_state(),
        # Only what the cutoff leaves in scope — the browser never sees the
        # excluded rows, so no filter or count can accidentally include them.
        "alerts": visible(),
        **state_payload(),
    }


def load_csv(path_text: str) -> dict:
    text = path_text.strip().strip('"')
    if not text:
        raise ToolError("Give the path to a CSV export.")

    # Relative to where the tool was started, then relative to the repo — so
    # both `--csv alerts_export.csv` from the repo root and a path typed into
    # the UI from anywhere resolve to the file the reviewer meant.
    path = Path(text).expanduser()
    if not path.is_file() and not path.is_absolute():
        path = (REPO_ROOT / path).resolve()
    if not path.is_file():
        raise ToolError(f"No such file: {text}")

    # Scraped bodies are long and full of newlines; the default field cap is
    # 128 KB and a quoted multi-line content column can pass it.
    csv.field_size_limit(10_000_000)
    try:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            missing = [c for c in CSV_COLUMNS if c not in (reader.fieldnames or [])]
            if missing:
                raise ToolError(
                    f"{path.name} is missing column(s): {', '.join(missing)}. "
                    f"Expected the alerts export: {', '.join(CSV_COLUMNS)}.")
            rows = list(reader)
    except UnicodeDecodeError as e:
        raise ToolError(f"{path.name} is not UTF-8: {e}") from e
    except csv.Error as e:
        raise ToolError(f"Could not read {path.name}: {e}") from e

    # A CSV is alerts and nothing else: there is no users table in it, so the
    # audience from whichever database was loaded before would be an answer
    # about a different dataset. Drop it and say why.
    global _audience, _audience_error
    with _lock:
        _audience = None
        _audience_error = ("A CSV export holds alerts only. Load a D1 database to see "
                           "who an alert notifies.")
    return set_dataset("csv", str(path.resolve()), rows, truncated=False)


def d1_documents(scope: str, sql: str) -> list:
    """One `wrangler d1 execute --json`, as the list of result documents — one
    per statement, in statement order."""
    result = run_command([
        "npx", "wrangler", "d1", "execute", D1_DATABASE,
        "--remote" if scope == "remote" else "--local", "--json",
        "--command", sql,
    ])
    if result["exit_code"] != 0:
        raise ToolError(f"wrangler failed:\n{result['output']}")

    # wrangler prints banner lines before the JSON payload; take the document.
    start = result["output"].find("[")
    if start < 0:
        raise ToolError(f"wrangler returned no JSON:\n{result['output']}")
    try:
        documents = json.loads(result["output"][start:])
    except json.JSONDecodeError as e:
        raise ToolError(f"Could not parse wrangler's output:\n{result['output']}") from e
    return documents if isinstance(documents, list) else [documents]


def load_d1(scope: str) -> dict:
    if scope not in ("local", "remote"):
        raise ToolError(f"Unknown database: {scope}")

    rows: list = []
    for document in d1_documents(scope, ALERTS_SQL):
        rows.extend(document.get("results", []))

    set_dataset(f"d1-{scope}", f"{D1_DATABASE} ({scope})", rows,
                truncated=len(rows) >= D1_ROW_LIMIT)

    # A second call rather than four more statements on the first: reading the
    # audience is the part that can fail on a database seeded differently, and
    # failing it must not cost the alerts the reviewer came for.
    global _audience, _audience_error
    try:
        tables = load_audience(scope)
        with _lock:
            _audience, _audience_error = tables, ""
    except ToolError as e:
        with _lock:
            _audience, _audience_error = None, f"Could not read the user tables: {e}"
    return dataset_payload()


def load_audience(scope: str) -> targeting.Tables:
    """
    The regions, streets, users and opt-outs the Worker targets against.

    Read at load time rather than per alert: wrangler costs seconds per call and
    the four tables are a few thousand rows that every alert then matches
    against in memory, which is also how the Worker sees them (its own ref cache
    holds regions and streets for six hours).
    """
    documents = d1_documents(scope, AUDIENCE_SQL)
    if len(documents) != len(AUDIENCE_TABLES):
        raise ToolError(f"expected {len(AUDIENCE_TABLES)} result sets, got {len(documents)}.")

    named: dict[str, list] = {}
    for document, (table, required) in zip(documents, AUDIENCE_TABLES):
        results = document.get("results", [])
        if results and not all(column in results[0] for column in required):
            raise ToolError(f"the result set for {table} has columns "
                            f"{sorted(results[0])}, which is not that table.")
        named[table] = results

    def number(value):
        return float(value) if isinstance(value, (int, float)) else None

    def integer(value):
        return int(value) if isinstance(value, (int, float)) else None

    regions = [targeting.Named(int(r["id"]), str(r["name"]), number(r["lat"]), number(r["lng"]),
                               settlement_id=integer(r.get("settlement_id")))
               for r in named["regions"]]
    streets = [targeting.Named(int(r["id"]), str(r["name"]), number(r["lat"]), number(r["lng"]),
                               region_id=integer(r.get("region_id")))
               for r in named["streets"]]
    users = [targeting.User(
        user_id=str(r["user_id"]), email=str(r.get("email") or ""),
        latitude=number(r.get("latitude")), longitude=number(r.get("longitude")),
        region_id=integer(r.get("region_id")), street_id=integer(r.get("street_id")),
        receives_all=bool(r.get("receives_all_alerts")),
        bus_lines=str(r.get("subscribed_bus_lines") or "[]"),
    ) for r in named["users"]]

    opt_outs: dict[str, set] = {}
    for row in named["opt_outs"]:
        opt_outs.setdefault(str(row["user_id"]), set()).add(str(row["category"]))

    if not users:
        raise ToolError(f"the users table in the {scope} database is empty.")

    return targeting.Tables(
        regions=regions, streets=streets, users=users, disabled=opt_outs,
        scope=f"{D1_DATABASE} ({scope})",
        loaded_at=datetime.now().strftime("%d.%m.%Y %H:%M"))


def alert_audience(alert_id: str) -> dict:
    """Who one stored alert would notify, computed on demand — the reviewer
    walks the list with j/k and only ever looks at one."""
    with _lock:
        tables, unavailable = _audience, audience_state()
    if tables is None:
        return {"ok": False, "detail": unavailable["detail"]}
    alert = find_alert((alert_id or "").strip())
    if alert is None:
        raise ToolError(f"No such alert: {alert_id}")
    return targeting.audience(alert, tables)


def run_command(argv: list[str], timeout: int = 180) -> dict:
    """
    Run a fixed argument vector in backend/. The SQL is a constant; nothing from
    the request body is ever interpolated into a command.
    """
    try:
        completed = subprocess.run(
            argv, cwd=BACKEND_DIR, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            # npx is a .cmd shim on Windows, which CreateProcess will not execute
            # without a shell. argv is constant, so this adds no injection surface.
            shell=(sys.platform == "win32"),
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as e:
        raise ToolError(f"{argv[0]} was not found on PATH.") from e
    except subprocess.TimeoutExpired as e:
        raise ToolError(f"`{' '.join(argv[:6])} …` did not finish within {timeout} s.") from e

    return {
        "exit_code": completed.returncode,
        "output": (completed.stdout + completed.stderr).strip(),
    }


# ── report ────────────────────────────────────────────────────────────────────


def ring_points(polygon) -> int:
    total = 0
    for ring in polygon if isinstance(polygon, list) else []:
        if isinstance(ring, list) and len(ring) >= 3:
            total += sum(1 for point in ring if isinstance(point, list) and len(point) >= 2)
    return total


def polygon_points(geometry, depth: int = 0) -> int:
    """
    Vertices across every ring of whatever GeoJSON a location carries: a bare
    Polygon on stored rows, a FeatureCollection on ones written before the
    pipeline unwrapped it, and a MultiPolygon in principle.

    Zero means there is no usable geometry, which is worth saying next to
    `is_polygon`: without a ring the Worker targets that location by name and
    radius instead, so the two flags disagreeing changes who was notified.
    """
    if depth > 5 or not isinstance(geometry, (dict, list)):
        return 0
    if isinstance(geometry, list):
        return sum(polygon_points(item, depth + 1) for item in geometry)
    if "features" in geometry:
        return polygon_points(geometry["features"], depth + 1)
    if "geometry" in geometry:
        return polygon_points(geometry["geometry"], depth + 1)
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list):
        return 0
    if geometry.get("type") == "Polygon":
        return ring_points(coordinates)
    if geometry.get("type") == "MultiPolygon":
        return sum(ring_points(polygon) for polygon in coordinates)
    return 0


def summarize() -> dict:
    """
    Everything in scope, never the current filter: a report that silently
    described a subset would be read as describing everything. The cutoff is
    the one thing that narrows it, and the report says so at the top rather
    than quietly reporting on less than it looks like.
    """
    with _lock:
        alerts = visible()
        judgments = dict(_judgments)
        issues = {k: dict(v) for k, v in _issues.items()}
        source, detail = _dataset["source"], _dataset["detail"]

    tally = {verdict: 0 for verdict in VERDICTS}
    reason_counts = {reason["id"]: 0 for reason in REASONS}
    by_category: dict[str, dict] = {}
    by_severity: dict[str, dict] = {}
    by_issue: dict[str, list] = {issue_id: [] for issue_id in issues}
    findings: list = []
    important: list = []

    for alert in alerts:
        judgment = judgments.get(alert["id"]) or {}
        verdict = judgment.get("verdict", "")
        if verdict in tally:
            tally[verdict] += 1

        for bucket, key in((by_category, alert["category"] or "(none)"),
                            (by_severity, alert["severity"] or "(none)")):
            row = bucket.setdefault(key, {"loaded": 0, "accurate": 0,
                                          "inaccurate": 0, "unimplemented": 0})
            row["loaded"] += 1
            if verdict in row:
                row[verdict] += 1

        if verdict not in FINDING_VERDICTS:
            continue
        for reason in judgment.get("reasons", []):
            if reason in reason_counts:
                reason_counts[reason] += 1

        finding = {
            "id": alert["id"],
            "category": alert["category"],
            "severity": alert["severity"],
            "title": alert["title"],
            "created_on_utc": alert["created_on_utc"],
            "start_time": alert["start_time"],
            "end_time": alert["end_time"],
            "windows_json": alert["windows_json"],
            "verdict": verdict,
            "reasons": judgment.get("reasons", []),
            "issues": [i for i in judgment.get("issues", []) if i in issues],
            "important": bool(judgment.get("important")),
            "note": judgment.get("note", ""),
            "locations": [
                {
                    "location_name": str(location.get("location_name", "")),
                    # The slots behind the display name. Without them the review
                    # renders {"гр. Варна", "кв. Виница"} and {null, "кв. Виница"}
                    # identically, and telling those apart is the whole point of
                    # reviewing a three-slot parse. None on pre-split alerts.
                    "settlement": location.get("settlement"),
                    "area": location.get("area"),
                    "lat": location.get("lat"),
                    "lng": location.get("lng"),
                    "is_polygon": bool(location.get("is_polygon")),
                    "polygon_points": polygon_points(location.get("polygon_geojson")),
                    "region_wide": bool(location.get("region_wide")),
                    "sublocations": [str(s) for s in location.get("sublocations", [])
                                     if isinstance(s, (str, int, float))],
                }
                for location in alert["locations"]
            ],
            "locations_error": alert["locations_error"],
        }
        findings.append(finding)
        for issue_id in finding["issues"]:
            by_issue[issue_id].append(finding)
        if finding["important"]:
            important.append(finding)

    findings.sort(key=lambda f: f["created_on_utc"], reverse=True)
    important.sort(key=lambda f: f["created_on_utc"], reverse=True)
    return {
        "generated_at": datetime.now().strftime("%d.%m.%Y %H:%M"),
        "source": source or "(nothing loaded)",
        "source_detail": detail,
        "cutoff": _cutoff,
        "counts": counts(),
        "verdict_counts": tally,
        "reason_counts": reason_counts,
        "by_category": by_category,
        "by_severity": by_severity,
        "issues": issues,
        "by_issue": by_issue,
        "findings": findings,
        "important": important,
    }


def finding_line(finding: dict) -> str:
    """One flagged alert as a single scannable line, for the grouped lists."""
    stamp_mark = "**★** " if finding["important"] else ""
    when = finding["created_on_utc"][:10]
    verdict = "" if finding["verdict"] == "inaccurate" else f" · _{VERDICTS[finding['verdict']]['label'].lower()}_"
    return (f"- {stamp_mark}`{finding['id']}` · {finding['category']} · {when} · "
            f"{finding['title'] or '(no title)'}{verdict}")


def render_markdown(summary: dict) -> str:
    counted, tally = summary["counts"], summary["verdict_counts"]
    findings = summary["findings"]
    lines = [
        f"# CityShield alert review — {summary['generated_at']}",
        "",
        f"Source: **{summary['source']}**"
        + (f" · `{summary['source_detail']}`" if summary["source_detail"] else ""),
        "",
        f"{counted['loaded']} alerts in scope · {tally['accurate']} accurate · "
        f"{tally['inaccurate']} inaccurate · {tally['unimplemented']} not implemented · "
        f"{counted['unreviewed']} unreviewed",
    ]
    # What the report is about is a decision, so it is stated rather than left
    # to be inferred from a number that looks lower than expected.
    if summary["cutoff"]:
        since = datetime.strptime(summary["cutoff"], "%Y-%m-%d").strftime("%d.%m.%Y")
        lines += ["", f"*Covers alerts created on or after **{since}**"
                      + (f" — {counted['excluded']} older alert(s) are out of scope "
                         "and appear in no number below." if counted["excluded"] else ".") + "*"]
    if counted["orphans"]:
        lines += ["", f"*{counted['orphans']} judgment(s) in `judgments.json` refer to alerts "
                      "outside this review — not loaded, or before the cutoff — and are not "
                      "counted here.*"]

    if summary["important"]:
        lines += ["", f"## Fix first — {len(summary['important'])} marked important", ""]
        for finding in summary["important"]:
            lines.append(finding_line(finding))
            for issue_id in finding["issues"]:
                lines.append(f"  - {summary['issues'][issue_id]['title']}")
            if finding["note"]:
                lines.append(f"  - {finding['note']}")

    ranked = sorted(summary["by_issue"].items(), key=lambda kv: -len(kv[1]))
    named = [(issue_id, group) for issue_id, group in ranked if group]
    if named:
        lines += ["", f"## Issues — {len(named)}", ""]
        lines.append("Each of these was named once and stamped on every alert it appears in.")
        for issue_id, group in named:
            issue = summary["issues"][issue_id]
            starred = sum(1 for f in group if f["important"])
            lines += [
                "",
                f"### {issue['title']} — {len(group)} alert(s)"
                + (f", {starred} important" if starred else ""),
                "",
                f"`{issue_id}` · {VERDICTS[issue['kind']]['label'].lower()}"
                + (" · " + ", ".join(REASON_LABELS.get(r, r) for r in issue["reasons"])
                   if issue["reasons"] else ""),
            ]
            if issue["detail"]:
                lines += ["", issue["detail"]]
            lines.append("")
            for finding in group:
                lines.append(finding_line(finding))
                if finding["note"]:
                    lines.append(f"  - {finding['note']}")

    inaccurate = tally["inaccurate"]
    lines += ["", "## Inaccuracy reasons", ""]
    if inaccurate:
        lines += ["| Reason | Alerts | Share of inaccurate |", "|---|---:|---:|"]
        for reason in sorted(REASONS, key=lambda r: -summary["reason_counts"][r["id"]]):
            count = summary["reason_counts"][reason["id"]]
            if count:
                lines.append(f"| {reason['label']} | {count} | {count / inaccurate:.0%} |")
        lines += ["", "An alert can carry several reasons, so the shares do not add to 100%."]
    else:
        lines.append("No alert has been flagged inaccurate.")

    for title, bucket in (("category", summary["by_category"]), ("severity", summary["by_severity"])):
        lines += ["", f"## By {title}", "",
                  f"| {title.capitalize()} | Loaded | Accurate | Inaccurate | Not implemented | Inaccurate % |",
                  "|---|---:|---:|---:|---:|---:|"]
        for key in sorted(bucket, key=lambda k: -bucket[k]["loaded"]):
            row = bucket[key]
            judged = row["accurate"] + row["inaccurate"]
            share = f"{row['inaccurate'] / judged:.0%}" if judged else "—"
            label = (f"{key} — {CATEGORY_LABELS[key]}"
                     if title == "category" and key in CATEGORY_LABELS else key)
            lines.append(f"| {label} | {row['loaded']} | {row['accurate']} | "
                         f"{row['inaccurate']} | {row['unimplemented']} | {share} |")

    # Everything already listed under an issue is left out here: the point of
    # grouping was to stop repeating the same alert under the same complaint.
    loose = [f for f in findings if not f["issues"]]
    lines += ["", f"## Individual findings — {len(loose)} with no shared issue", ""]
    if not loose:
        lines.append("None: every flagged alert belongs to a named issue.")
    for finding in loose:
        reasons = ", ".join(REASON_LABELS.get(r, r) for r in finding["reasons"]) or "—"
        lines += [
            f"### {'★ ' if finding['important'] else ''}{finding['category']} · "
            f"{finding['title'] or '(no title)'}",
            "",
            f"`{finding['id']}` · created `{finding['created_on_utc']}` · "
            f"severity `{finding['severity']}` · {VERDICTS[finding['verdict']]['label'].lower()}",
            "",
            f"**Reasons:** {reasons}",
            "",
            f"**Window:** `{finding['start_time'] or '—'}` → `{finding['end_time'] or '—'}`",
        ]
        # Only set when the envelope above loses detail (migration 0012): a
        # window repeating over a date range, or several windows in one day.
        if finding.get("windows_json"):
            lines += ["", f"**Windows:** `{finding['windows_json']}`"]
        if finding["locations"]:
            lines += ["", "**Locations:**", ""]
            for location in finding["locations"]:
                pin = (f"{location['lat']}, {location['lng']}"
                       if location["lat"] is not None and location["lng"] is not None
                       else "no coordinates")
                subs = (" — " + ", ".join(location["sublocations"])) if location["sublocations"] else ""
                # The flag and the geometry decide different things and can
                # disagree: a ring means everyone inside it was notified, no
                # ring means the location fell back to name-and-radius.
                points = location["polygon_points"]
                if location["is_polygon"]:
                    polygon = f" · polygon, {points} pts" if points else " · **polygon flagged, no geometry**"
                else:
                    polygon = f" · **geometry not flagged**, {points} pts" if points else ""
                # The streets below were listed but not targeted — say so, or the
                # line reads as street-level targeting that it deliberately isn't.
                wide = " · region-wide" if location["region_wide"] else ""
                # The settlement is shown beside the name, not instead of it:
                # what a review has to be able to see is whether the model put
                # the district and its city in the right slots.
                scope = f" [in {location['settlement']}]" if location["settlement"] else ""
                lines.append(
                    f"- {location['location_name'] or '(unnamed)'}{scope} → {pin}{polygon}{wide}{subs}")
        elif finding["locations_error"]:
            lines += ["", f"**Locations:** {finding['locations_error']}"]
        else:
            lines += ["", "**Locations:** none"]
        if finding["note"]:
            lines += ["", f"**Note:** {finding['note']}"]
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def generate_report(fmt: str) -> dict:
    if fmt not in ("md", "json"):
        raise ToolError(f"Unknown report format: {fmt}")

    summary = summarize()
    if fmt == "md":
        text = render_markdown(summary)
    else:
        text = json.dumps({**summary, "reason_labels": REASON_LABELS},
                          ensure_ascii=False, indent=2) + "\n"

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / f"review-{datetime.now().strftime('%Y%m%d-%H%M%S')}.{fmt}"
    path.write_text(text, encoding="utf-8")
    return {"path": str(path), "relative": repo_path(path), "text": text,
            "revealed": reveal(path)}


def repo_path(path: Path) -> str:
    """Repo-relative and forward-slashed, because these paths get pasted into
    discussions rather than into a Windows shell."""
    return os.path.relpath(path, REPO_ROOT).replace("\\", "/")


def reveal(path: Path) -> bool:
    """
    Show the finished report in the file manager, selected. Best effort: the
    report is written either way, and a headless or unusual desktop is not a
    reason to fail the request.
    """
    if sys.platform == "win32":
        # One argument, comma-joined — `explorer /select, path` as two words
        # opens Documents instead. Explorer also exits 1 on success, so the
        # return code says nothing and is not checked.
        argv = ["explorer", f"/select,{path}"]
    elif sys.platform == "darwin":
        argv = ["open", "-R", str(path)]
    else:
        argv = ["xdg-open", str(path.parent)]
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError:
        return False


# ── HTTP ──────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "AlertReview/1.0"
    token = ""

    def log_message(self, fmt, *args):  # quieter console; errors still surface in the UI
        pass

    def _authorized(self) -> bool:
        """
        Loopback Host + matching token. The Host check blocks DNS rebinding; the
        token blocks plain CSRF from any other local page. This process can read
        the production database, so both guards apply to every call.
        """
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        supplied = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("t", [""])[0]
        if not supplied:
            supplied = self.headers.get("X-Tool-Token", "")
        return secrets.compare_digest(supplied, self.token)

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: dict, status: int = 200):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ToolError("Malformed JSON request body.") from e

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send(403, b"Forbidden: open the tokenized URL printed in the terminal.",
                       "text/plain; charset=utf-8")
            return

        if path == "/":
            self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/config":
            self._send_json({
                "reasons": REASONS,
                "verdicts": VERDICTS,
                "finding_verdicts": list(FINDING_VERDICTS),
                "category_labels": CATEGORY_LABELS,
                "row_limit": D1_ROW_LIMIT,
                "max_note_length": MAX_NOTE_LENGTH,
                "judgments_file": repo_path(JUDGMENTS_FILE),
                # Column order for the raw-row view, so it reads as the table row
                # it is rather than as whatever order a dict happens to hold.
                "columns": list(CSV_COLUMNS),
            })
        elif path == "/api/alerts":
            self._send_json(dataset_payload())
        else:
            self._send(404, b"Not found", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send_json({"error": "Forbidden."}, 403)
            return

        try:
            body = self._read_json()
            if path == "/api/load":
                source = body.get("source", "")
                if source == "csv":
                    self._send_json(load_csv(body.get("path", "")))
                elif source in ("local", "remote"):
                    self._send_json(load_d1(source))
                else:
                    raise ToolError(f"Unknown source: {source}")
            elif path == "/api/audience":
                self._send_json(alert_audience(body.get("id", "")))
            elif path == "/api/cutoff":
                self._send_json(set_cutoff(body.get("cutoff", "")))
            elif path == "/api/judge":
                self._send_json(judge(
                    body.get("id", ""), body.get("verdict", ""), body.get("reasons", []),
                    body.get("note", ""), body.get("issues", []), bool(body.get("important"))))
            elif path == "/api/issue":
                self._send_json(save_issue(
                    body.get("id", ""), body.get("title", ""), body.get("kind", ""),
                    body.get("reasons", []), body.get("detail", "")))
            elif path == "/api/issue/delete":
                self._send_json(delete_issue(body.get("id", "")))
            elif path == "/api/stamp":
                self._send_json(stamp(body.get("issue_id", ""), body.get("ids", [])))
            elif path == "/api/report":
                self._send_json(generate_report(body.get("format", "md")))
            else:
                self._send_json({"error": "Not found."}, 404)
        except ToolError as e:
            self._send_json({"error": str(e)}, 400)
        except (KeyError, ValueError, TypeError) as e:
            self._send_json({"error": f"Bad request: {e}"}, 400)
        except OSError as e:
            self._send_json({"error": f"Filesystem error: {e}"}, 500)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description="Review LLM-parsed CityShield alerts.")
    parser.add_argument("--csv", metavar="PATH",
                        help="load an alerts export at startup (columns: "
                             + ", ".join(CSV_COLUMNS) + ")")
    args = parser.parse_args()

    if not BACKEND_DIR.is_dir():
        sys.exit(f"Expected the backend at {BACKEND_DIR} — run this from the CityShield repo.")

    global _cutoff
    _judgments.update(read_store(JUDGMENTS_FILE))
    _issues.update(read_store(ISSUES_FILE))
    _cutoff = read_cutoff()

    # `old — excluded` used to be a verdict; it is the cutoff now. An entry left
    # over from that era would otherwise sit in the file as an unknown verdict,
    # counted nowhere and reachable from nothing.
    retired = [i for i, j in _judgments.items() if j.get("verdict") not in VERDICTS]
    for alert_id in retired:
        del _judgments[alert_id]
    if retired:
        write_store_locked(JUDGMENTS_FILE, _judgments)
        print(f"Dropped {len(retired)} judgment(s) with a retired verdict — "
              "set a cutoff date instead to leave old alerts out.")

    if args.csv:
        try:
            load_csv(args.csv)
        except ToolError as e:
            sys.exit(str(e))

    Handler.token = secrets.token_urlsafe(24)
    port = free_port()
    url = f"http://127.0.0.1:{port}/?t={Handler.token}"

    in_scope_count = len(visible())
    loaded = (f"{in_scope_count} alert(s) from {_dataset['detail']}"
              + (f" ({len(_dataset['alerts']) - in_scope_count} before the {_cutoff} cutoff)"
                 if len(_dataset["alerts"]) != in_scope_count else "")
              if _dataset["alerts"] else "nothing loaded yet — pick a source in the UI")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Alert review → {url}\n"
          f"Alerts: {loaded}\n"
          f"Audience: {audience_state()['detail']}\n"
          f"Judgments: {len(_judgments)} in {JUDGMENTS_FILE.name}, "
          f"{len(_issues)} issue(s) in {ISSUES_FILE.name}\n"
          "Ctrl+C to stop.")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
