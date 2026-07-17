"""
One-time seeding / schema-maintenance script for PostgreSQL.
Run manually when setting up a new environment (after the ASP.NET API has
applied its EF migrations, which own the streets/regions tables):

    python -m data.postgres.seeding.seeder

Besides loading the reference data it also ensures the pieces EF does not
manage: the pg_trgm extension, unique + trigram (GIN) indexes on the name
columns (both this backend's resolve_street_names and the API's fuzzy
matching filter with `%` / similarity(), which without an index means a
sequential scan per lookup), and the ingestion crawl_state table.
Everything is idempotent — safe to re-run.
"""

import json
import logging
import sys
from pathlib import Path

import psycopg

from config import cfg
from data.postgres.state_repository import _TABLE_DDL as CRAWL_STATE_DDL

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")


_SEEDS_DIR = Path(__file__).parent / "seeds"
REGIONS_FILE = _SEEDS_DIR / "regions.json"
STREETS_FILE = _SEEDS_DIR / "streets.json"


def seed_json_list(cur, filepath: Path, table_name: str, column_name: str) -> None:
    """
    Create (if standalone) and seed a reference table from a flat JSON list
    of strings, then ensure its unique + trigram indexes. Idempotent.
    """
    if not filepath.exists():
        log.warning("File '%s' not found. Skipping seeding for table '%s'.", filepath, table_name)
        return

    log.info("Loading %s into table '%s'...", filepath, table_name)

    with open(filepath, encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        log.error("Expected a JSON array in %s", filepath)
        return

    # Normally created by the EF InitialCreate migration; this keeps the
    # seeder usable against a standalone database too.
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            id   SERIAL PRIMARY KEY,
            {column_name} TEXT NOT NULL
        );
    """)

    # Older seeder versions could insert duplicates (no unique constraint on
    # EF-created tables) — collapse them before adding the unique index.
    cur.execute(f"""
        DELETE FROM {table_name} a
        USING {table_name} b
        WHERE a.id > b.id AND a.{column_name} = b.{column_name};
    """)

    # Unique index doubles as the ON CONFLICT target below.
    cur.execute(f"""
        CREATE UNIQUE INDEX IF NOT EXISTS ux_{table_name}_{column_name}
        ON {table_name} ({column_name});
    """)

    # GIN trigram index: powers the pg_trgm `%` operator / similarity()
    # lookups used by polygon street resolution and the API's fuzzy match.
    cur.execute(f"""
        CREATE INDEX IF NOT EXISTS ix_{table_name}_{column_name}_trgm
        ON {table_name} USING gin ({column_name} gin_trgm_ops);
    """)

    rows = [(item,) for item in data if item]
    cur.executemany(
        f"INSERT INTO {table_name} ({column_name}) VALUES (%s) "
        f"ON CONFLICT ({column_name}) DO NOTHING",
        rows,
    )
    log.info("Table '%s' ready. Inserted/verified %d records.", table_name, len(rows))


def main() -> None:
    log.info("Connecting to PostgreSQL at %s:%d/%s ...", cfg.POSTGRES_HOST, cfg.POSTGRES_PORT, cfg.POSTGRES_DB)
    try:
        conn = psycopg.connect(
            dbname=cfg.POSTGRES_DB,
            user=cfg.POSTGRES_USER,
            password=cfg.POSTGRES_PASSWORD,
            host=cfg.POSTGRES_HOST,
            port=cfg.POSTGRES_PORT,
            sslmode=cfg.POSTGRES_SSLMODE,
        )
    except psycopg.Error as exc:
        log.error("Could not connect to PostgreSQL: %s", exc)
        sys.exit(1)

    try:
        with conn.transaction():
            with conn.cursor() as cur:
                # Needed by the trigram indexes and the `%` operator; the EF
                # model declares it too, but ensure it for standalone setups.
                cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")

                seed_json_list(cur, REGIONS_FILE, "regions", "region_name")
                seed_json_list(cur, STREETS_FILE, "streets", "street_name")

                # Ingestion crawl-state table (also auto-created lazily by
                # data.postgres.state_repository on first service run).
                cur.execute(CRAWL_STATE_DDL)

                # The buses table was seeded historically but nothing reads
                # it (bus-line subscriptions are stored as strings on users).
                cur.execute("DROP TABLE IF EXISTS buses;")

    except (psycopg.Error, OSError) as exc:
        log.error("Seeding failed: %s", exc)
        sys.exit(1)
    finally:
        conn.close()

    log.info("Done.")


if __name__ == "__main__":
    main()
