"""
One-time seeding script: loads seed data from JSON files into PostgreSQL.
Run manually when setting up a new environment.
"""

import json
import logging
import sys
import os
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

from config import cfg

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")


_SEEDS_DIR = Path(__file__).parent / "seeds"
BUSES_FILE   = _SEEDS_DIR / "buses.json"
REGIONS_FILE = _SEEDS_DIR / "regions.json"
STREETS_FILE = _SEEDS_DIR / "streets.json"


def seed_json_list(cur, filepath: str, table_name: str, column_name: str) -> None:
    """Helper function to create a table and seed it with a flat JSON list of strings."""
    if not os.path.exists(filepath):
        log.warning("File '%s' not found. Skipping seeding for table '%s'.", filepath, table_name)
        return

    log.info("Loading %s into table '%s'...", filepath, table_name)
    
    with open(filepath, encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        log.error("Expected a JSON array in %s", filepath)
        return

    # Create the table dynamically using the passed column_name
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            id   SERIAL PRIMARY KEY,
            {column_name} TEXT UNIQUE
        );
    """)
    
    # Filter out any empty strings and prepare tuples for insertion
    rows = [(item,) for item in data if item]
    
    # Insert data, ignoring duplicates if the script is run multiple times
    execute_values(
        cur,
        f"INSERT INTO {table_name} ({column_name}) VALUES %s",
        rows,
        template="(%s)"
    )
    log.info("Table '%s' ready. Inserted/Verified %d records.", table_name, len(rows))


def main() -> None:
    log.info("Connecting to PostgreSQL at %s:%d/%s ...", cfg.POSTGRES_HOST, cfg.POSTGRES_PORT, cfg.POSTGRES_DB)
    try:
        conn = psycopg2.connect(
            dbname=cfg.POSTGRES_DB,
            user=cfg.POSTGRES_USER,
            password=cfg.POSTGRES_PASSWORD,
            host=cfg.POSTGRES_HOST,
            port=cfg.POSTGRES_PORT,
        )
    except psycopg2.Error as exc:
        log.error("Could not connect to PostgreSQL: %s", exc)
        sys.exit(1)

    try:
        with conn:
            with conn.cursor() as cur:
                # Pass the custom column names to the helper function
                seed_json_list(cur, BUSES_FILE, "buses", "number")
                seed_json_list(cur, REGIONS_FILE, "regions", "region_name")
                seed_json_list(cur, STREETS_FILE, "streets", "street_name") 

    except (psycopg2.Error, OSError) as exc:
        log.error("Seeding failed: %s", exc)
        sys.exit(1)
    finally:
        conn.close()

    log.info("Done.")


if __name__ == "__main__":
    main()