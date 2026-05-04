"""
Core logic for extracting data from vik.

Pipeline:
1. Downloads the official page
2. Parses all message urls from the response with BeautifulSoup
3. Goes over all urls, extracts their id with regex and checks if the id comes after the one stored in state.json
4. For each new url it again downloads the page and parses it with BeautifulSoup
5. The extracted content is processed using a LLM
6. The output from the LLM is geocoded
...
"""

import json
import re
import uuid

from geopy import Photon

from scraping.scrape import fetch_page, vik_parse_page, vik_parse_message
from utility.json_wrapper import vik_get_last_id, vik_write_new_id
from processing import ai_parser, geocode_wrapper

URL = "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown"
URL_PATTERN = re.compile(r'(\d+)\.html')

AI_PROMPT = """
    You are a system that outputs strictly valid JSON.

    === Task ===
    You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.
    
    === Clarifications ===
    List of abbreviations and their meaning:
    "ул." /улица/ - street
    "бул." /булевард/ - boulevard
    "ж.к." /жилищен комплекс/ - residential complex
    "кв." /квартал/ - district
    "с." /село/ - village
    "гр." /град/ - city
    "м-т" (NO DOT) /местност/ (can also be encountered as "м." or "м-ст") - locality
    "к.к." /курортен комплекс/ (can also be encountered as "к.к-с")- resort complex
    - If something isn't from the things listed do not include it.
    - If there are details regarding what happend and who caused it - ignore it.
    - The abbreviations must be written EXACTLY like from the list AND CONSIDER THE DOTS.
    - Leave spaces between each word (including abbreviations)
    - Remove all quotation marks from the locations
        
    === Requirements ===
    - Output ONLY valid JSON.
    - Do not include explanations, comments, or markdown.
    - Follow this exact schema:
    {
        "locations":
            [
                {
                    "location_name": string,
                    "sublocations": array of strings
                }
            ]
        "start_time": format "HH:MM",
        "end_time": format "HH:MM"
    }

    The "location_name" field must contain the name of the city/village/locality/district/residential complex.
    The "sublocations" array includes streets/boulevards, each as a separate entry.
    
    === Constraints ===:
    - Do not add extra fields.
    - If data is unknown, use null.
    - Ensure the JSON is syntactically valid.
    """

geolocator = Photon(user_agent="city_shield", domain="localhost:2322", scheme="http")

msg_stored_id = vik_get_last_id()

print("===== last stored id =====")
print(msg_stored_id)
msg_latest_id = msg_stored_id

print("[VIK] Starting...")

try:
    response = fetch_page(URL)
except:
    print("[VIK] An error occurred while fetching the page. Stopping...")
    raise SystemExit(1)

msg_urls = vik_parse_page(response.text)

for url in msg_urls:
    print("--- url ---")
    print(url)
    match = URL_PATTERN.search(url)
    if not match:
        print("[VIK] Couldn't find a match for this url: " + url)
        continue

    message_id = int(match.group(1))

    if message_id > msg_stored_id:
        msg_latest_id = max(msg_latest_id, message_id)
        try:
            response = fetch_page(url)
        except:
            print("[VIK] An error occurred while fetching the message page.")
            continue

        message = vik_parse_message(response.text)
        msg_content = f"{message["title"]}\n{message["content"]}"
        print("--- message ---")
        print(msg_content)

        ai_extracted_data = ai_parser.ai_parse(AI_PROMPT, msg_content)
        processed_data_json = json.loads(ai_extracted_data)
        print("--- extracted data ---")
        print(processed_data_json)

        final_data = {
            "id": str(uuid.uuid4()),
            "original_message":{
                "tile": message["title"],
                "content": message["content"]
            },
            "locations": []
        }

        locations_data = { "locations": [] }
        
        for location in processed_data_json.get("locations", []):
            location_name = location.get("location_name", "")
            
            location_entry = {"location_name": location_name, "coords": [], "sublocations": []}

            if location_name:
                coords = geolocator.geocode(location_name + " Варна Варна България")
                if coords:
                    location_entry["coords"] = [coords.latitude, coords.longitude]

            sublocations = location.get("sublocations")

            for sublocation in sublocations:
                sublocation_entry = {"sublocation_name": sublocation, "coords": []}
                coords = geolocator.geocode(sublocation + " Варна Варна България")
                if coords:
                    sublocation_entry["coords"] = [coords.latitude, coords.longitude]

                location_entry["sublocations"].append(sublocation_entry)
               
            locations_data["locations"].append(location_entry)

        final_data["locations"] = locations_data["locations"]
        print("--- final data ---")
        print(final_data)
        print("=================================")

vik_write_new_id(msg_latest_id)