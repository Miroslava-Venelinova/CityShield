"""
Helper module for working with json files.
All functions are wrapped in try/except so that a missing or corrupted
state.json never crashes a service — callers receive a safe default value
and an error message is printed instead.
"""

import json

STATE_FILE = "state.json"


def _read_state() -> dict | None:
    """Read and return the full state dict, or None on any error."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"[json_wrapper] {STATE_FILE} not found.")
    except json.JSONDecodeError as e:
        print(f"[json_wrapper] {STATE_FILE} is corrupted: {e}")
    except OSError as e:
        print(f"[json_wrapper] Could not open {STATE_FILE}: {e}")
    return None


def _write_state(state: dict) -> bool:
    """Write state dict to file.  Returns True on success."""
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=4)
        return True
    except OSError as e:
        print(f"[json_wrapper] Could not write {STATE_FILE}: {e}")
        return False


# ---------------------------------------------------------------------------
# VIK
# ---------------------------------------------------------------------------

def vik_get_last_id() -> int:
    """
    Gets the last id from state.json.
    Returns 0 as a safe default if something goes wrong.
    """
    state = _read_state()
    if state is None:
        return 0
    try:
        return int(state["vik"]["last_id"])
    except (KeyError, TypeError, ValueError) as e:
        print(f"[json_wrapper] Could not read vik.last_id: {e}")
        return 0


def vik_write_new_id(id: int) -> None:
    """Writes id to state.json."""
    state = _read_state()
    if state is None:
        return
    try:
        state["vik"]["last_id"] = id
    except (KeyError, TypeError) as e:
        print(f"[json_wrapper] Could not set vik.last_id: {e}")
        return
    _write_state(state)


# ---------------------------------------------------------------------------
# VarnaTraffic
# ---------------------------------------------------------------------------

def vt_get_ids() -> list:
    """
    Gets all ids from state.json.
    Returns an empty list as a safe default if something goes wrong.
    """
    state = _read_state()
    if state is None:
        return []
    try:
        return list(state["vt"]["last_ids"])
    except (KeyError, TypeError) as e:
        print(f"[json_wrapper] Could not read vt.last_ids: {e}")
        return []


def vt_write_new_ids(ids: list) -> None:
    """Writes a list of ids to state.json."""
    state = _read_state()
    if state is None:
        return
    try:
        for id in ids:
            state["vt"]["last_ids"].append(id)
    except (KeyError, TypeError) as e:
        print(f"[json_wrapper] Could not update vt.last_ids: {e}")
        return
    _write_state(state)