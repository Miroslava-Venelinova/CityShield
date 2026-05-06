"""
Core logic for extracting data from vik.

Pipeline:
1. Downloads the official page
2. Parses all message urls from the response with BeautifulSoup
3. Goes over all urls, extracts their id with regex and checks if the id comes after the one stored in state.json
4. For each new url it again downloads the page and parses it with BeautifulSoup
5. The extracted content is processed using a LLM
6. The output from the LLM is sent to the ASP server
"""

import json
import re
import uuid

import requests

from scraping.scrape import fetch_page, vik_parse_page, vik_parse_message
from utility.json_wrapper import vik_get_last_id, vik_write_new_id
from processing import ai_parser

VIK_URL = "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown"
VIK_URL_PATTERN = re.compile(r'(\d+)\.html')
API_URL = "http://localhost:5276/api/VK/submit-data"

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
    "к.к." /курортен комплекс/ (can also be encountered as "к.к-с") - resort complex
    - If something isn't from the things listed do not include it.
    - If there are details regarding what happend and who caused it - ignore it
        
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
                    "is_polygon": bool
                }
            ]
        "start_time": format "HH:MM",
        "end_time": format "HH:MM"
    }

    The "location_name" field must contain the name of the city/village/locality/district/residential complex.
    The "sublocations" array includes streets/boulevards, each as a separate entry.
    If you have multiple streets listed and stuff along the lines of: "затворени", "в карето", "между"; it means that the streets form a polygon and the "is_polygon" field must be set to true. In every other case leave it false.
    
    === Constraints ===:
    - Do not add extra fields.
    - If data is unknown, use null.
    - Ensure the JSON is syntactically valid.
    - The abbreviations must be written EXACTLY like from the list AND CONSIDER THE DOTS.
    - Leave spaces between each word (including abbreviations).
    - Remove all quotation marks from the locations.
    """

def main():
    msg_stored_id = vik_get_last_id()

    print("===== last stored id =====")
    print(msg_stored_id)
    msg_latest_id = msg_stored_id

    print("[VIK] Starting...")

    try:
        response = fetch_page(VIK_URL)
    except:
        print("[VIK] An error occurred while fetching the page. Stopping...")
        return

    msg_urls = vik_parse_page(response.text)

    for url in msg_urls:
        print("--- url ---")
        print(url)
        match = VIK_URL_PATTERN.search(url)
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
            
            final_data = {
                "id": str(uuid.uuid4()),
                "original_message":{
                    "title": message["title"],
                    "content": message["content"]
                },
                "processed_data": processed_data_json
            }

            print("--- final data ---")
            print(final_data)
            print("=================================")

            response = requests.post(API_URL, json=final_data)
            print("=== response ===")
            print(response.status_code)
            print(response.json())

    vik_write_new_id(msg_latest_id)

if __name__ == "__main__":
    main()