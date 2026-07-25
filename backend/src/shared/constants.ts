// Port of NotificationPreferencesService.KnownCategories — adding a new
// category here is the only schema-free change needed for a new alert source.
// Insertion order is the order the preferences endpoint returns.

export const KNOWN_CATEGORIES = new Map<string, string>([
  ["vik", "Water (ВиК)"],
  ["vt", "Traffic"],
  ["epro", "Power (ЕРП Север)"],
  ["heating", "Heating (Веолия)"],
]);

// ── AI prompts ────────────────────────────────────────────────────────────────
// The location-extraction rules are copied CHARACTER-FOR-CHARACTER from
// backend/services/common.py (OUTAGE_AI_PROMPT) and varnatraffic_service.py —
// they're tuned for Bulgarian abbreviation handling; do not "improve" them
// (§1.7). The time handling deliberately diverges from the Python original:
// start_time/end_time are now full ISO 8601 local datetimes (see
// shared/datetime.ts), not bare "HH:MM", so outages scheduled days ahead get a
// correct active window. The pipeline prepends a "CURRENT_DATE:" line the model
// uses to default the date, and normalizeDateTime backstops the model's output.

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
    "start_time": ISO 8601 local datetime "YYYY-MM-DDTHH:MM:00" or null,
    "end_time": ISO 8601 local datetime "YYYY-MM-DDTHH:MM:00" or null,
    "city_wide": bool
}

## Dates and times
- The first line of the message is "CURRENT_DATE: YYYY-MM-DD". Use that date whenever the message states a time but no date of its own.
- Output "start_time" and "end_time" as ISO 8601 local datetimes in the EXACT format "YYYY-MM-DDTHH:MM:00". The seconds are ALWAYS 00.
- Bulgarian dates are written day.month.year. Example: "На 27.07.2026 г. В периода 8:00 ч. до 13:30 ч." gives start_time "2026-07-27T08:00:00" and end_time "2026-07-27T13:30:00".
- A date without a year (e.g. "27.07") takes the year from CURRENT_DATE.
- For a date range with a single daily window (e.g. "От 27.07.2026 г. до 29.07.2026 г. В периода 8:00 ч. до 17:00 ч."), set "start_time" to the FIRST date at the start clock ("2026-07-27T08:00:00") and "end_time" to the LAST date at the end clock ("2026-07-29T17:00:00").
- If a start or end time is not stated at all, use null for that field.

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
