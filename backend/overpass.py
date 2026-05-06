import requests
import json

OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"

QUERY = """
[out:json][timeout:120];

area["name"="Варна"]["boundary"="administrative"]->.varna;

(
  // administrative districts
  relation(area.varna)
    ["boundary"="administrative"]
    ["admin_level"~"7|8|9|10"];

  // suburbs
  node(area.varna)["place"="suburb"];
  way(area.varna)["place"="suburb"];
  relation(area.varna)["place"="suburb"];

  // neighbourhoods
  node(area.varna)["place"="neighbourhood"];
  way(area.varna)["place"="neighbourhood"];
  relation(area.varna)["place"="neighbourhood"];
);

out tags center;

"""

OUTPUT_FILE = "names.json"


def fetch_overpass_data(query: str) -> dict:
    response = requests.post(
        OVERPASS_URL,
        data=query,
        timeout=120
    )
    response.raise_for_status()
    return response.json()


def extract_names(data: dict) -> list[str]:
    return [
        el["tags"]["name"]
        for el in data.get("elements", [])
        if "tags" in el and "name" in el["tags"]
    ]


def main():
    print("Querying Overpass API...")
    data = fetch_overpass_data(QUERY)

    print("Extracting names...")
    names = sorted(set(extract_names(data)))

    print(f"Saving {len(names)} names to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(names, f, ensure_ascii=False, indent=2)

    print("Done.")


if __name__ == "__main__":
    main()