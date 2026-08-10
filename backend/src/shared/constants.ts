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
// The location-extraction rules started as a CHARACTER-FOR-CHARACTER copy of
// backend/services/common.py (OUTAGE_AI_PROMPT) and varnatraffic_service.py
// (§1.7). Two rounds of divergence since, each driven by production output
// rather than by taste:
//
//  1. Times became a `schedule` object — a date range plus the clock windows
//     inside it (shared/datetime.ts). A flat start/end pair could express
//     neither shape the sources actually publish, and asking for a schedule AND
//     a pair invites the model to contradict itself, so the pair is derived.
//  2. The rules the 28.07.2026 review found the model losing were spelled out:
//     epro's "гр. X - кв. Y" shape, the bare abbreviations and shop names it
//     emitted as locations, and the "карето" polygon cue it ignored.
//
// Everything here is a SECOND line of defence. The model is nondeterministic,
// so ingestion/normalize.ts enforces the same rules from the source text and
// is what actually holds; changes here are measured with
// spikes/ai-eval/run-eval.mjs, which imports this constant directly.
//
// The pipeline prepends a "CURRENT_DATE:" line the model uses to default the
// date, and normalizeSchedule backstops everything it produces.

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

These are NEVER locations. Leave them out entirely - do not put them in "settlement", "area" or "streets":
- a shop or a company: "м-н ..." /магазин/, "... ООД", "... ЕООД", "... АД", "фирма ..."
- an electrical installation: "ТП 726" /трафопост/, "БКТП ...", a substation, a transformer
- an abbreviation with NO name after it: a lone "м-т", "местност", "м.", "кв." or "ж.к." names no place
- a word that describes a place instead of naming one: "карето", "зона", "квартал", "улица", "блок"

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "locations": [
        {
            "settlement": string or null,
            "area": string or null,
            "streets": array of strings,
            "is_polygon": bool
        }
    ],
    "schedule": {
        "from_date": "YYYY-MM-DD" or null,
        "to_date": "YYYY-MM-DD" or null,
        "windows": [ { "start": "HH:MM" or null, "end": "HH:MM" or null } ]
    },
    "city_wide": bool
}

## Dates and times
- The first line of the message is "CURRENT_DATE: YYYY-MM-DD". Use that date whenever the message states a time but no date of its own.
- "from_date" is the FIRST day the outage affects, "to_date" the LAST. For a single day they are the SAME date.
- Bulgarian dates are written day.month.year; output them as "YYYY-MM-DD". A date without a year (e.g. "27.07") takes the year from CURRENT_DATE.
- "windows" holds the clock times as 24-hour "HH:MM". EVERY window applies to EVERY day between "from_date" and "to_date". Never stretch one window across the range.
- Example: "На 27.07.2026 г. В периода 8:00 ч. до 13:30 ч." gives {"from_date": "2026-07-27", "to_date": "2026-07-27", "windows": [{"start": "08:00", "end": "13:30"}]}
- Example: "От 30.07.2026 г. до 31.07.2026 г. В периода 8:30 ч. до 17:00 ч." gives {"from_date": "2026-07-30", "to_date": "2026-07-31", "windows": [{"start": "08:30", "end": "17:00"}]} - ONE window, because 8:30-17:00 is what happens on each of the two days.
- Example: "На 25.07.2026 г. от 9:00 до 11:00 ч. и от 15:00 до 17:00 ч." gives {"from_date": "2026-07-25", "to_date": "2026-07-25", "windows": [{"start": "09:00", "end": "11:00"}, {"start": "15:00", "end": "17:00"}]}
- If no time is stated at all, "windows" is an empty array. If only one side of a window is stated, use null for the other side.

## Locations
Every entry in "locations" describes ONE place, in three slots:
- "settlement" is the city or the village: "гр. Варна", "с. Аврен". Use null when the message names none.
- "area" is the district, residential complex, locality or resort complex INSIDE that settlement: "кв. Виница", "ж.к. Младост", "м-т Ваялар", "к.к. Чайка". Use null when the message names none.
- "streets" holds the streets and boulevards, each as a separate entry.
- List EVERY place the message names. A message naming five villages must produce five entries - do not stop early and do not merge them.
- NEVER invent a settlement the message does not name. If the message says only "кв. Чайка", then "settlement" is null.
- A district NEVER goes in "streets", and a street NEVER goes in "area".
- Many messages are written as "гр. X - кв. Y", "гр. X - ж.к. Y" or "гр. X - м-т Y". That is ONE entry: X is the "settlement" and Y is the "area". Do not make two entries out of it.
- Example: "Прекъсване на електрозахранването гр. Варна - кв. Владислав Варненчик" gives "locations": [{"settlement": "гр. Варна", "area": "кв. Владислав Варненчик", "streets": [], "is_polygon": false}]
- When streets are listed AFTER such a district, they are that district's own streets: they go in "streets" of the SAME entry, beside the "area".
- Example: "гр. Варна - кв. Виница, ул. Свети Пророк Илия, ул. Константин Павлов" gives "locations": [{"settlement": "гр. Варна", "area": "кв. Виница", "streets": ["ул. Свети Пророк Илия", "ул. Константин Павлов"], "is_polygon": false}]
- But when a street comes BEFORE the districts, the message is a flat list of separate places: ONE entry per district, each repeating the settlement, and the street goes in an entry whose "area" is null.
- Example: "гр. Варна - част от: ул. Арх. Стоян Доков, м-ст Ваялар и м-ст Свети Никола" gives "locations": [{"settlement": "гр. Варна", "area": null, "streets": ["ул. Арх. Стоян Доков"], "is_polygon": false}, {"settlement": "гр. Варна", "area": "м-т Ваялар", "streets": [], "is_polygon": false}, {"settlement": "гр. Варна", "area": "м-т Свети Никола", "streets": [], "is_polygon": false}]
- When the message names ONLY streets under the city and no district at all, "area" is null.
- Example: "гр. Варна - ул. Неофит Бозвели 46; ул. Ангел Кънчев 3" gives "locations": [{"settlement": "гр. Варна", "area": null, "streets": ["ул. Неофит Бозвели", "ул. Ангел Кънчев"], "is_polygon": false}]
- A village with its own streets fills "settlement" and "streets" and leaves "area" null.
- Example: "Без вода остава с. Аврен, ул. Тича" gives "locations": [{"settlement": "с. Аврен", "area": null, "streets": ["ул. Тича"], "is_polygon": false}]
- When the message says "улиците:" (or "ул.:") before a list, EVERY name in that list is a street. Put them all in "streets", even when one of them is also the name of a district or a village.
- Example: "гр. Суворово – улиците: Хан Аспарух, Георги Бенковски, Искър" gives "locations": [{"settlement": "гр. Суворово", "area": null, "streets": ["ул. Хан Аспарух", "ул. Георги Бенковски", "ул. Искър"], "is_polygon": false}]
- NEVER output a place the message does not name. Every "settlement", "area" and street you write must appear in the text you were given. If you are unsure, leave it out.
- Streets that say where a WATER TRUCK or a repair crew is are not affected streets: "разположена водоноска на кръстовището между ул. Юпитер и ул. Сатурн" names a junction where help is parked, so those streets do NOT go in "streets".
- "от центъра в посока гр. Варна" is a direction of travel, not a location. Do not extract a place out of "в посока …".
If you have multiple streets listed and stuff along the lines of: "затворени", "в карето", "между"; it means that the streets form a polygon and the "is_polygon" field must be set to true. In every other case leave it false.
In case there is a polygon assume all the things listed are streets.
- "карето" is the SIGNAL that "is_polygon" is true. It is never a "settlement" and never an "area".
- Example: "Без вода ще бъдат: в карето между бул. Владислав Варненчик, ул. Беласица, ул. Хан Пресиян и бул. Левски" gives "locations": [{"settlement": null, "area": null, "streets": ["бул. Владислав Варненчик", "ул. Беласица", "ул. Хан Пресиян", "бул. Левски"], "is_polygon": true}]
- If the message says "карето" TWICE it describes TWO blocks. Make TWO entries, each with "is_polygon": true and only its own streets. A street named in both blocks goes in BOTH entries - it is the side they share.
- Example: "карето, заключено между бул. Левски, ул. Девня и ул. Райко Даскалов и карето, заключено между ул. Девня, ул. Тодор Влайков и ул. Панайот Хитов" gives "locations": [{"settlement": null, "area": null, "streets": ["бул. Левски", "ул. Девня", "ул. Райко Даскалов"], "is_polygon": true}, {"settlement": null, "area": null, "streets": ["ул. Девня", "ул. Тодор Влайков", "ул. Панайот Хитов"], "is_polygon": true}]
If the message affects all clients city-wide and lists no specific locations, leave the "locations" array empty and set "city_wide" to true. In every other case "city_wide" must be false.

## Constraints
- Do not add extra fields.
- If data is unknown, use null.
- Ensure the JSON is syntactically valid.
- The abbreviations must be written EXACTLY like from the list (the variant in the leftmost position) AND CONSIDER THE DOTS.
- "settlement" ALWAYS keeps its "гр." or "с." abbreviation: write "с. Тополи", never a bare "Тополи".
- Leave spaces between each word (including abbreviations).
- Remove all quotation marks from the locations.
- A street name never carries a house number, a block, an entrance or a floor: "ул. Пловдив 25" is "ул. Пловдив", "бул. Чаталджа 20 вх. Б." is "бул. Чаталджа".
`;

export const VT_AI_PROMPT = `You are a system that outputs strictly valid JSON.

## Task
You will receive a message in Bulgarian from which you have to extract information and generate a JSON file.
It will be a message regarding some change in a bus route. You will have to extract the affected bus lines.
For buses that have a letter after their number write them in a format "number + uppercase letter" example: "31A".
Special case: if you see "209 Бърз" it's 209B.

You must also extract the period the change is in force for, when the message states one.

## Requirements
- Output ONLY valid JSON.
- Do not include explanations, comments, or markdown.
- Follow this exact schema:
{
    "bus_lines": ["array of strings"],
    "schedule": {
        "from_date": "YYYY-MM-DD" or null,
        "to_date": "YYYY-MM-DD" or null,
        "windows": [ { "start": "HH:MM" or null, "end": "HH:MM" or null } ]
    }
}

## Dates and times
- The first line of the message is "CURRENT_DATE: YYYY-MM-DD". Use that date whenever the message states a time but no date of its own.
- "from_date" is the FIRST day the route change applies, "to_date" the LAST. For a single day they are the SAME date.
- Bulgarian dates are written day.month.year; output them as "YYYY-MM-DD". A date without a year (e.g. "27.07") takes the year from CURRENT_DATE.
- "windows" holds the clock times as 24-hour "HH:MM". EVERY window applies to EVERY day between "from_date" and "to_date". Never stretch one window across the range.
- Example: "На 27.07.2026 г. от 8:00 ч. до 13:30 ч." gives {"from_date": "2026-07-27", "to_date": "2026-07-27", "windows": [{"start": "08:00", "end": "13:30"}]}
- Example: "От 30.07.2026 г. до 31.07.2026 г. в периода 8:30 ч. до 17:00 ч." gives {"from_date": "2026-07-30", "to_date": "2026-07-31", "windows": [{"start": "08:30", "end": "17:00"}]} - ONE window, because 8:30-17:00 is what happens on each of the two days.
- A change announced for a whole day, or with no clock time at all, has an EMPTY "windows" array - still fill in "from_date" and "to_date" if the message gives dates.
- If the message states no period whatsoever, "from_date" and "to_date" are null and "windows" is empty.

## Constraints
- Do not add extra fields.
- If there are no bus lines specified but the message has information for a route change, write in the array only "0".
- If the data is completely irrelevant, leave the array null.
- Ensure the JSON is syntactically valid.
`;
