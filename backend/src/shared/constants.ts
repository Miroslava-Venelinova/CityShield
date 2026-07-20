// Port of NotificationPreferencesService.KnownCategories — adding a new
// category here is the only schema-free change needed for a new alert source.
// Insertion order is the order the preferences endpoint returns.

export const KNOWN_CATEGORIES = new Map<string, string>([
  ["vik", "Water (ВиК)"],
  ["vt", "Traffic"],
  ["epro", "Power (ЕРП Север)"],
  ["heating", "Heating (Веолия)"],
  ["roads", "Roads (АПИ)"],
]);

// ── AI prompts ────────────────────────────────────────────────────────────────
// Copied CHARACTER-FOR-CHARACTER from backend/services/common.py
// (OUTAGE_AI_PROMPT), varnatraffic_service.py and roads_service.py — they're
// tuned for Bulgarian abbreviation handling; do not "improve" them (§1.7).

export const OUTAGE_AI_PROMPT = `You are a system that outputs strictly valid JSON.

## Task
You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.

## Clarifications
List of abbreviations and their meaning:
- "ул." /улица/ - street
- "бул." /булевард/ - boulevard
- "ж.к." /жилищен комплекс/ - residential complex
- "кв." /квартал/ - district
- "с." /село/ - village
- "гр." /град/ - city
- "м-т" (NO DOT) /местност/ (can also be encountered as "м." or "м-ст") - locality
- "к.к." /курортен комплекс/ (can also be encountered as "к.к-с") - resort complex

If something isn't from the things listed assume it's a building or something else and do not include it.
If there are details regarding what happened and who caused it - ignore it.

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "locations": [
        {
            "location_name": string,
            "sublocations": array of strings,
            "is_polygon": bool
        }
    ],
    "start_time": format "HH:MM",
    "end_time": format "HH:MM",
    "city_wide": bool
}

The "location_name" field must contain the name of the city/village/locality/district/residential complex.
The "sublocations" array includes streets/boulevards, each as a separate entry.
If you have multiple streets listed and stuff along the lines of: "затворени", "в карето", "между"; it means that the streets form a polygon and the "is_polygon" field must be set to true. In every other case leave it false.
In case there is a polygon assume all the things listed are streets.
If the message affects all clients city-wide and lists no specific locations, leave the "locations" array empty and set "city_wide" to true. In every other case "city_wide" must be false.

## Constraints
- Do not add extra fields.
- If data is unknown, use null.
- Ensure the JSON is syntactically valid.
- The abbreviations must be written EXACTLY like from the list (the variant in the leftmost position) AND CONSIDER THE DOTS.
- Leave spaces between each word (including abbreviations).
- Remove all quotation marks from the locations.
`;

export const VT_AI_PROMPT = `You are a system that outputs strictly valid JSON.

## Task
You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.
It will be a message regarding some change in a bus route. You will have to extract the affected bus lines.
For buses that have a letter after their number write them in a format "number + uppercase letter" example: "31A".
Special case: if you see "209 Бърз" it's 209B.

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "bus_lines": ["array of strings"]
}

## Constraints
- Do not add extra fields.
- If there are no bus lines specified but the message has information for a route change, write in the array only "0".
- If the data is completely irrelevant, leave the array null.
- Ensure the JSON is syntactically valid.
`;

export const ROADS_AI_PROMPT = `You are a system that outputs strictly valid JSON.

## Task
You will receive a news article in Bulgarian from the Bulgarian Road
Infrastructure Agency (АПИ). Decide whether it is relevant to drivers in
or around the city of Varna, and summarize it.

An article is relevant ONLY if it describes road works, road closures,
traffic restrictions or changed traffic organization that affect:
- roads inside област Варна (Varna province), or
- major routes to/from Varna (АМ "Хемус", път I-9, път I-2, ...).

Articles about other provinces, tolls, tenders, policy or statistics are
NOT relevant, even if they mention Varna in passing (e.g. "посока Варна"
for a road section in another province is NOT relevant).

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "is_relevant": bool,
    "summary": string
}

The "summary" must be 1-2 sentences in Bulgarian stating WHERE, WHEN and
WHAT is restricted. If the article is not relevant, use null.

## Constraints
- Do not add extra fields.
- Ensure the JSON is syntactically valid.
`;
