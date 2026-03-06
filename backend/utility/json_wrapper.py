"""
Helper module for working with json files
"""

# IMPORTANT: Currently it assumes that the file always exists. Everything should be put in try-except in case something goes wrong (like if the file isn't there or it's corrupted)  
# TODO: refactor to be safe

import json

def vik_get_last_id():
    """
    Gets the last id from state.json.
    """
    with open("state.json", "r") as file:
        state = json.load(file)
    return state["vik"]["last_id"]

def vik_write_new_id(id: int):
    """
    Writes id to state.json.
    """
    with open("state.json", "r") as file:
        state = json.load(file)

    state["vik"]["last_id"] = id

    with open("state.json", "w") as file:
        json.dump(state, file, indent=4)


def vt_get_ids():
    """
    Gets all ids from state.json
    """
    with open("state.json", "r") as file:
        state = json.load(file)
    return state["vt"]["last_ids"]

def vt_write_new_ids(ids: list):
    """
    Writes a list of ids to state.json.
    """
    with open("state.json", "r") as file:
        state = json.load(file)

    for id in ids:
        state["vt"]["last_ids"].append(id)

    with open("state.json", "w") as file:
        json.dump(state, file, indent=4)