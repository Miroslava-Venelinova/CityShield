"""
Core logic for extracting data from varnatraffic.

Pipeline:
1. Downloads the official page
    - if an error occurrs, it stops
2. Parses the response with BeautifulSoup
3. Checks if there are new ids. If there are none, it stops
4. The extracted messages are processed using a LLM
...
"""

import json
import uuid

from scraping.scrape import fetch_page, vt_parse
from utility.json_wrapper import vt_get_ids, vt_write_new_ids
from processing.ai_parser import ai_parse

URL = "https://www.varnatraffic.com/Info"
# support for bus stops can be added in the future
AI_PROMPT = """
    You are a system that outputs strictly valid JSON.

    Task:
    You will receive a message in bulgarian from which you have to extract information and generate a JSON file.
    It will be a message regarding some change in a bus route. You will have to extract the affected bus lines.
    For buses that have a letter after their number write them in a format "number + uppercase letter" example: "31A".
    Special case: if you see "209 Бърз" its 209B.

    Requirements:
    - Output ONLY valid JSON.
    - Do not include explanations, comments, or markdown.
    - Follow this exact schema:
    {
        "bus_lines": ["array of strings"]
    }

    Constraints:
    - Do not add extra fields.
    - If they're are no bus lines specified but the message has information for a route change, write in the array only "0".
    - If the data is completely irrelevant, leave the array null.
    - Ensure the JSON is syntactically valid.
    """

print("[VT] Starting...")

try:
    response = fetch_page(URL)
except:
    print("[VT] An error occurred while fetching the page. Stopping...")
    raise SystemExit(1)

raw_messages = vt_parse(response.text)

# IMPORTANT: Currently all ids are stored in state.json. It works for now, but something like SQLite should be used in prod.
stored_ids = set(vt_get_ids())

# filters all messages that are already processed
filtered_messages = [
    msg for msg in raw_messages
    if msg["data_id"] not in stored_ids
]

if not filtered_messages:
    print("[VT] No new messages found.") 
else:
    curr_data_ids = [item["data_id"] for item in filtered_messages if "data_id" in item]

    for msg in filtered_messages:
        msg_content = f"{msg["header"]}\n{msg["body"]}"
        bus_lines = ai_parse(AI_PROMPT, msg_content)
        bus_lines_json = json.loads(bus_lines)
        final_data = {
            "id": str(uuid.uuid4()),
            "original_message": msg,
            **bus_lines_json
        }
        print(final_data)
    vt_write_new_ids(curr_data_ids)