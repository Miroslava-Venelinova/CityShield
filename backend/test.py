import ollama

prompt = """
You will receive a message in bulgarian from which you have to extract the information and generate a JSON file.

Rules:
- Output VALID JSON only
- No markdown, no explanations
- additionalProperties must be false
- Required fields must be listed

Data description:
A user profile object with:
- locations: string array
- start_time: format "HH:MM" or null
- end_time: format "HH:MM" or null
"""

response = ollama.chat(
        model="mistral",
        messages=[{"role": "system", "content": prompt}, {"role": "user", "content": """Поради предизвикана аватия от частна фирма на ул. " 13 - та"  ,без вода ще бъдат абонатите от висока зона на м-т "Евксиноград" и м-т "Малко Ю" от 10.30 до 17.00 ч."""}],
    )

print(response['message']['content'])