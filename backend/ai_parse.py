import json
from pathlib import Path
import ollama

prompt = """
You are a JSON generator.
You will receive a message in bulgarian from which you have to extract the information and generate a JSON file.

Rules:
- Output VALID JSON only
- No markdown, no explanations
- Required fields must be listed

Data description:
- locations: string array
- start_time: format "HH:MM" or null
- end_time: format "HH:MM" or null

Return ONLY THE JSON on a single line.
"""

def ai_parse_json(data):
    for item in data:
        content = item['message']

        response = ollama.chat(
            # model="mistral",
            model="qwen3:32b",
            messages=[{"role": "system", "content": prompt}, {"role": "user", "content": content}]
        )

        path = "ai_parse_output/" + f"result_{item["id"]}.json"
        with open(path, "w", encoding="utf-8") as f:
            f.write(response['message']['content'])

    print(f"Processing data: {data}")


def check_and_process_json_files(directory):
    directory_path = Path(directory)

    for file_path in directory_path.glob("*.json"):  # Find all JSON files in the directory
        # Skip if the file has already been processed (starts with 'processed_')
        if file_path.name.startswith("processed_"):
            print(f"Skipping already processed file: {file_path.name}")
            continue

        try:
            content = file_path.read_text(encoding='utf-8').strip()

            # If the file is empty or contains an empty JSON array, delete it
            if not content or content == "[]":
                print(f"File is empty or contains an empty array. Deleting: {file_path.name}")
                file_path.unlink()  # Deletes the file
            else:
                # Try to load the JSON data
                try:
                    data = json.loads(content)

                    # If the JSON is an empty array, delete the file
                    if data == []:
                        print(f"File contains an empty array. Deleting: {file_path.name}")
                        file_path.unlink()  # Deletes the file
                    else:
                        # Process the data
                        ai_parse_json(data)

                        # Rename the file to mark it as processed
                        processed_file_path = file_path.with_name(f"processed_{file_path.name}")
                        file_path.rename(processed_file_path)
                        print(f"File processed and renamed: {processed_file_path.name}")
                except json.JSONDecodeError:
                    print(f"Invalid JSON in file: {file_path.name}. Skipping...")
        except Exception as e:
            print(f"Error reading file {file_path.name}: {e}")


directory = 'json_test'
check_and_process_json_files(directory)


# with open('state.json', 'r') as file:
#     data = json.load(file)
#     last_id = data['last_id']
#
# folder = Path("vik_json_runs")
#
# for json_file in folder.glob("*.json"):
#     with json_file.open("r", encoding="utf-8") as f:
#         messages = json.load(f)
#
# prompt = """
# You will receive a message in bulgarian from which you have to extract the information and generate a JSON file.
#
# Rules:
# - Output VALID JSON only
# - No markdown, no explanations
# - additionalProperties must be false
# - Required fields must be listed
# - Return it with no intervals, escape characters and quotes
#
# Data description:
# A user profile object with:
# - locations: string array,
# - start_time: format "HH:MM"
# - end_time: format "HH:MM"
# """
#
# for message in messages:
#     print(message['message'])
#     response = ollama.chat(
#         model="mistral",
#         messages=[{"role": "system", "content": prompt}, {"role": "user", "content": message['message']}],
#     )
#
#     path = "ai_parse_output/" + f"result_{message["id"]}.json"
#
#     with open(path, "w", encoding="utf-8") as f:
#         json.dump(response['message']['content'], f, indent=4)
#
# print("ok")