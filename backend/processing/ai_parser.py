"""
Module for AI parsing.
Currently it uses a local LLM (ollama). Might change in the future.
"""

import ollama

def ai_parse(system_prompt: str, user_prompt: str) -> str:
    """
    General function for AI parsing.
    """
    # uncomment the model you want to use
    response = ollama.chat(
            model = "qwen3.5",
            #model = "qwen3.5:27b",
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            format = "json"
        )
    
    print(f"tokens used: prompt_eval={response["prompt_eval_count"]} eval={response["eval_count"]}")

    return response['message']['content']