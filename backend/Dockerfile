FROM python:3.13-slim

# gcc + libpq headers are required to build psycopg2 from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Configuration comes from environment variables (see config.py / .env.example).
# When running against a containerized Ollama, also set OLLAMA_HOST.
CMD ["python", "run.py"]
