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
import time
import re

from geopy.geocoders import Nominatim

from scraping.scrape import fetch_page, vik_parse_page, vik_parse_message
from utility.json_wrapper import vik_get_last_id, vik_write_new_id
from processing.ai_parser import ai_parse

URL = "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown"
URL_PATTERN = re.compile(r'(\d+)\.html')
# the prompt is quite long because nominatim is picky about some stuff
AI_PROMPT = """
    You are a system that outputs strictly valid JSON.

    Task:
    You will receive a message in bulgarian from which you have to extract the information and generate a JSON file.

    Clarifications regarding the information:
    Abbreviations and their meaning: if it's said to be included, leave the abbreviation in the data. If said otherwise, do not include it in the final data e.g. "ул. Иван Вазов" -> Иван Вазов
    ул. (улица) - street; do not include
    бул. (булевард) - boulevard; include
    ж.к. (жилищен комплекс) - residential complex; include
    кв.	(квартал) - district; include
    с. (село) - village; do not include
    гр. (град) - city; do not include
    м-т (местност) - locality; include
    бл. (блок) - block; include
    If something isn't from the things listed it falls under the "other" category - assume that it's some place/building like a school, factory, etc. and leave it like it was in the original message

    Requirements:
    - Output ONLY valid JSON.
    - Do not include explanations, comments, or markdown.
    - Follow this exact schema:
    {
        "locations":
            [
                {
                    "location_name": string,
                    "sublocations": 
                    [
                        {
                            "sublocation_name": string
                            "streets": ["array of strings"]
                        }
                    ]
                }
            ]
        "start_time": format "HH:MM",
        "start_date": format "dd.MM.yyyy"
        "end_time": format "HH:MM",
        "end_date": format "dd.MM.yyyy"
    }

    The "location_name" field must contain the name of the village/city. If the village/city isn't specified, put "Варна".
    The "sublocation_name" field must contain the name of the district/locality. If there is something from the "other" category place it here.
    For each street put the name of the street/boulevard. If there is some additional information (for example block number) put it before the street and separate it with comma.
    If the start_date and end_date isn't specified in the message leave it null.
    
    Constraints:
    - Do not add extra fields.
    - If data is unknown, use null.
    - Ensure the JSON is syntactically valid.
    """

msg_stored_id = vik_get_last_id()
msg_latest_id = msg_stored_id
geolocator = Nominatim(user_agent="city_shield")

print("[VIK] Starting...")

try:
    response = fetch_page(URL)
except:
    print("[VIK] An error occurred while fetching the page. Stopping...")
    raise SystemExit(1)

msg_urls = vik_parse_page(response.text)

for url in msg_urls:
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
        print(msg_content)

        processed_data = ai_parse(AI_PROMPT, msg_content)
        data_json = json.loads(processed_data)
        print(data_json)    
        
        addresses = []
        for location in data_json.get("locations", []):
            location_name = location.get("location_name", "")
            sublocations = location.get("sublocations")

            if not sublocations:
                addresses.append(location_name)
                continue

            for sublocation in sublocations:
                sublocation_name = sublocation.get("sublocation_name", "")
                streets = sublocation.get("streets")
                
                if not streets:
                    addresses.append(f"{sublocation_name} {location_name}")
                    continue

                for street in streets:
                    addresses.append(f"{street} {sublocation_name} {location_name}")

        for address in addresses:
            full_address = f"{address} Варна България"
            print(full_address)

            # this uses the nominatim free api (max 1 request/second)
            location = geolocator.geocode(address)
            if location:
                print(f"Cords: {location.latitude} {location.longitude}")
            else:
                print("Location not found")
            
            time.sleep(2)

vik_write_new_id(msg_latest_id)