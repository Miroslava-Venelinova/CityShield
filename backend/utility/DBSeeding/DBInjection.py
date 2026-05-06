import json
import psycopg2
from psycopg2.extras import execute_batch

# Connect to PostgreSQL
conn = psycopg2.connect(
    dbname="CityShieldDB",
    user="postgres",
    password="Niki_2009",
    host="localhost",
    port="5432"
)

cur = conn.cursor()

#SEED STREETS
cur.execute("""
    CREATE TABLE IF NOT EXISTS Streets (
        id SERIAL PRIMARY KEY,
        street_name TEXT NOT NULL
    );
""")

# Load JSON (array of strings)
with open("streets.json", "r", encoding="UTF=8") as f:
    streets = json.load(f)

data = [(street,) for street in streets]

insert_query = "INSERT INTO Streets (street_name) VALUES (%s);"
execute_batch(cur, insert_query, data)

#SEED REGIONS
cur.execute("""
    CREATE TABLE IF NOT EXISTS Regions (
        id SERIAL PRIMARY KEY,
        region_name TEXT NOT NULL
    );
""")

# Load JSON (array of strings)
with open("regions.json", "r", encoding="UTF=8") as f:
    regions = json.load(f)

data = [(region,) for region in regions]

insert_query = "INSERT INTO Regions (region_name) VALUES (%s);"
execute_batch(cur, insert_query, data)

# Commit and close
conn.commit()
cur.close()
conn.close()

print("Inserted", len(streets), "streets and.", len(regions), "regions.")