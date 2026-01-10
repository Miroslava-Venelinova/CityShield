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

content = """Поради предизвикана аватия от частна фирма на ул. " 13 - та"  ,без вода ще бъдат абонатите от висока зона на м-т "Евксиноград" и м-т "Малко Ю" от 10.30 до 17.00 ч."""

response = ollama.chat(
        #model="mistral",
        model = "qwen3:32b",
        messages=[{"role": "system", "content": prompt}, {"role": "user", "content": content}]
    )

print(response['message']['content'])