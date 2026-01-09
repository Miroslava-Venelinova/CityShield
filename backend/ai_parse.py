import json
import ollama
from pathlib import Path

with open('state.json', 'r') as file:
    data = json.load(file)
    last_id = data['last_id']

folder = Path("vik_json_runs")

for json_file in folder.glob("*.json"):
    with json_file.open("r", encoding="utf-8") as f:
        messages = json.load(f)

prompt = """
You will receive a message in bulgarian from which you have to extract the information and generate a JSON file.

Rules:
- Output VALID JSON only
- No markdown, no explanations
- additionalProperties must be false
- Required fields must be listed
- Return it with no intervals, escape characters and quotes

Data description:
A user profile object with:
- locations: string array,
- start_time: format "HH:MM"
- end_time: format "HH:MM"
"""

for message in messages:
    print(message['message'])
    response = ollama.chat(
        model="mistral",
        messages=[{"role": "system", "content": prompt}, {"role": "user", "content": message['message']}],
    )

    path = "ai_parse_output/" + f"result_{message["id"]}.json"

    with open(path, "w", encoding="utf-8") as f:
        json.dump(response['message']['content'], f, indent=4)

print("ok")