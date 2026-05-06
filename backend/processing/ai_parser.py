"""
Module for AI parsing.
Currently it uses a local LLM (ollama). Might change in the future.
Returns None on any failure so callers can handle it gracefully.
"""

import ollama

def ai_parse(system_prompt: str, user_prompt: str) -> str | None:
    """
    General function for AI parsing.
    Returns the raw JSON string from the model, or None if anything fails.
    """
    try:
        # uncomment the model you want to use
        response = ollama.chat(
            model="qwen3:8b",
            #model="qwen3:30b-a3b",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            format="json",
        )
    except Exception as e:
        print(f"[ai_parser] Ollama call failed: {e}")
        return None

    try:
        print(
            f"[ai_parser] tokens used: "
            f"prompt_eval={response['prompt_eval_count']} "
            f"eval={response['eval_count']}"
        )
        return response["message"]["content"]
    except (KeyError, TypeError) as e:
        print(f"[ai_parser] Unexpected response structure: {e}")
        return None