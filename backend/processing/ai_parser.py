"""
Module for AI parsing.
Currently it uses a local LLM (ollama). Might change in the future.
"""

import ollama

def ai_parse(system_prompt: str, prompt: str) -> str:
    """
    General function for AI parsing.
    """
    # uncomment the model you want to use
    response = ollama.chat(
            #model="mistral",
            model = "qwen3:32b",
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}],
            format = "json"
        )

    return response['message']['content']