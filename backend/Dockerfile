FROM python:3.13-slim

WORKDIR /app

# psycopg ships prebuilt binaries (psycopg[binary]) — no compiler needed.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Configuration comes from environment variables (see config.py / .env.example).
# When running against a containerized Ollama, also set OLLAMA_HOST.
CMD ["python", "run.py"]
