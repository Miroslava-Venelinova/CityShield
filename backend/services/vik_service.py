"""
Core logic for extracting data from vik.
Currently it works for the whole region. Might refactor it to scrape only for the city of Varna

Pipeline:
1. Downloads the official page
    - if an error occurrs, it stops
2. Parses the response with BeautifulSoup
    - if the content is empty three times in a row, it stops
3. The extracted content is processed using a LLM
4. The output from the LLM is geocoded
...
"""

import json
import time

from geopy.geocoders import Nominatim

from scraping.scrape import fetch_page, vik_parse
from utility.json_wrapper import vik_get_last_id, vik_write_new_id
from processing.ai_parser import ai_parse


MISS_THRESHOLD = 3
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

consecutive_miss = 0
msg_id = vik_get_last_id()
geolocator = Nominatim(user_agent="city_shield")

print("[VIK] Starting...")

while True:
    if consecutive_miss >= MISS_THRESHOLD:
        print(f"[VIK] {consecutive_miss} misses in a row. Stopping...")
        vik_write_new_id(msg_id)
        break
    
    try:
        response = fetch_page(f"https://vikvarna.com/bg/messages/breakdown/{msg_id}.html")
    except:
        print("[VIK] An error occurred while fetching the page. Stopping...")
        vik_write_new_id(msg_id)
        break

    data = vik_parse(response.text)

    if not data:
        consecutive_miss += 1
        continue
    else:
        consecutive_miss = 0

    # this might take some time if you are using a high param local llm 
    # TODO: implement fallback in case the llm messes up
    msg_content = f"{data["title"]}\n{data["content"]}"
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

    msg_id += 1

    time.sleep(3)