"""
Manual end-to-end notification test: submits a battery of realistic
"processed" payloads to the running ASP API — the exact shapes the scraper
services produce after the LLM step — so real FCM pushes go out.

Reuses the pipeline's own Pydantic models (services.common.AiOutput /
Sublocation), retry session and config (ASP_API_URL / ASP_API_KEY /
ASP_API_VERIFY_SSL), so a payload accepted here is byte-for-byte what
common.submit_to_api would send. The POST itself is done locally instead of
through submit_to_api only so the API's notified_count can be printed.

Prerequisites: the API is running with real Firebase credentials, and your
app account has a location + registered device token. Only the case matching
your account's street (default: ул. Сирма войвода, кв. Бриз) actually
delivers a push; the rest exercise storage, matching and broadcast paths.

Usage (from backend/):
    python scripts/send_test_alerts.py          # send every case
    python scripts/send_test_alerts.py --list   # show cases without sending
    python scripts/send_test_alerts.py --only vik-street --only vt
    python scripts/send_test_alerts.py --neighborhood "кв. Аспарухово" --street "Дубровник"
    python scripts/send_test_alerts.py --live-polygons  # build polygons via PostGIS/OSM
"""

import argparse
import logging
import sys
import time
import uuid
from pathlib import Path

# Backend modules import each other as top-level packages, so backend/
# (the parent of scripts/) must be on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import cfg
from services import common
from services.common import AiOutput, Sublocation

log = logging.getLogger("send_test_alerts")

# Approximate block in the Varna city centre (Дебър/Кракра/Сливница/Драгоман)
# in the FeatureCollection shape streets_to_geojson produces. Used unless
# --live-polygons resolves the real one from PostGIS/OSM.
CANNED_POLYGON = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [27.9075, 43.2079],
                        [27.9114, 43.2085],
                        [27.9110, 43.2110],
                        [27.9070, 43.2104],
                        [27.9075, 43.2079],
                    ]
                ],
            },
        }
    ],
}


def build_cases(neighborhood: str, street: str) -> list[dict]:
    """
    One entry per realistic scraper output. Texts are modeled on real VIK
    Varna / Енерго-Про / АПИ / Varna Traffic messages; processed_data is what
    the outage LLM prompt extracts from them.
    """

    return [
        {
            "name": "vik-street",
            "category": "vik",
            "note": f"street-level outage on your street ({street}) — should deliver a push",
            "title": "Авария на уличен водопровод",
            "content": (
                f"Поради отстраняване на авария на уличен водопровод на "
                f"ул. {street} е нарушено водоподаването на абонатите в "
                f"{neighborhood}. Очаквано възстановяване на водоподаването "
                f"– 17:00 ч."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name=neighborhood,
                        sublocations=[street],
                        is_polygon=False,
                    )
                ],
                start_time="09:00",
                end_time="17:00",
            ),
        }
        ]



    return [
        {
            "name": "vik-street",
            "category": "vik",
            "note": f"street-level outage on your street ({street}) — should deliver a push",
            "title": "Авария на уличен водопровод",
            "content": (
                f"Поради отстраняване на авария на уличен водопровод на "
                f"ул. {street} е нарушено водоподаването на абонатите в "
                f"{neighborhood}. Очаквано възстановяване на водоподаването "
                f"– 17:00 ч."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name=neighborhood,
                        sublocations=[street],
                        is_polygon=False,
                    )
                ],
                start_time="09:00",
                end_time="17:00",
            ),
        },
        {
            "name": "vik-planned",
            "category": "vik",
            "note": "planned maintenance in a village, fixed time window",
            "title": "Планирано прекъсване на водоподаването в с. Тополи",
            "content": (
                "Във връзка с извършване на планови ремонтни дейности по "
                "водопроводната мрежа, на 10.07 в периода 08:30 – 14:00 ч. "
                "ще бъде прекъснато водоподаването на абонатите в с. Тополи. "
                "ВиК – Варна се извинява за причиненото неудобство."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="с. Тополи",
                        sublocations=[],
                        is_polygon=False,
                    )
                ],
                start_time="08:30",
                end_time="14:00",
            ),
        },
        {
            "name": "vik-resort",
            "category": "vik",
            "note": "resort complex + locality (к.к. / м-т abbreviations)",
            "title": "Авария на водопровод в к.к. Св. Св. Константин и Елена",
            "content": (
                "Поради отстраняване на авария на водопровод е нарушено "
                "водоподаването в к.к. Св. Св. Константин и Елена и "
                "м-т Ален мак. Очаквано възстановяване – 19:00 ч."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="к.к. Св. Св. Константин и Елена",
                        sublocations=[],
                        is_polygon=False,
                    ),
                    Sublocation(
                        location_name="м-т Ален мак",
                        sublocations=[],
                        is_polygon=False,
                    ),
                ],
                start_time=None,
                end_time="19:00",
            ),
        },
        {
            "name": "vik-multi",
            "category": "vik",
            "note": "several districts, several streets each",
            "title": "Нарушено водоподаване в кв. Виница и с. Каменар",
            "content": (
                "Поради авария на магистрален водопровод без вода са абонатите "
                "в кв. Виница – ул. Цар Борис III и ул. Света Параскева, както "
                "и с. Каменар. Екипите работят на място. Очаквано "
                "възстановяване – 18:30 ч."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="кв. Виница",
                        sublocations=["Цар Борис III", "Света Параскева"],
                        is_polygon=False,
                    ),
                    Sublocation(
                        location_name="с. Каменар",
                        sublocations=[],
                        is_polygon=False,
                    ),
                ],
                start_time="10:15",
                end_time="18:30",
            ),
        },
        {
            "name": "epro-polygon",
            "category": "epro",
            "note": "planned outage over a street-bounded block (polygon)",
            "title": "Планирано прекъсване на електрозахранването",
            "content": (
                "Във връзка с извършване на неотложни ремонтни дейности на "
                "съоръженията за доставка на електроенергия, в периода "
                "09:00 – 16:30 ч. ще бъде прекъснато електрозахранването в "
                "карето между ул. Дебър, ул. Кракра, бул. Сливница и "
                "ул. Драгоман."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="гр. Варна",
                        sublocations=["ул. Дебър", "ул. Кракра",
                                      "бул. Сливница", "ул. Драгоман"],
                        is_polygon=True,
                        polygon_geojson=CANNED_POLYGON,
                    )
                ],
                start_time="09:00",
                end_time="16:30",
            ),
        },
        {
            "name": "vik-polygon-failed",
            "category": "vik",
            "note": "polygon outage where the polygon build failed (geojson null)",
            "title": "Авария в района на ул. Дубровник",
            "content": (
                "Поради авария на водопровод са затворени улиците в карето "
                "между ул. Д-р Басанович, ул. Подполковник Калитин, "
                "ул. Дубровник и ул. Студентска. Водоподаването ще бъде "
                "възстановено до 20:00 ч."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="гр. Варна",
                        sublocations=["ул. Д-р Басанович",
                                      "ул. Подполковник Калитин",
                                      "ул. Дубровник", "ул. Студентска"],
                        is_polygon=True,
                        polygon_geojson=None,
                    )
                ],
                start_time="11:30",
                end_time="20:00",
            ),
        },
        {
            "name": "vik-citywide",
            "category": "vik",
            "note": "city-wide water disruption broadcast (city_wide=true)",
            "title": "Нарушено водоподаване на територията на гр. Варна",
            "content": (
                "Поради авария на магистрален водопровод, захранващ града, е "
                "възможно понижено налягане и смущения във водоподаването на "
                "всички абонати на територията на гр. Варна до отстраняване "
                "на аварията."
            ),
            "ai_output": AiOutput(locations=[], start_time=None,
                                  end_time=None, city_wide=True),
        },
        {
            "name": "epro-multi",
            "category": "epro",
            "note": "unplanned outage across several villages",
            "title": "Прекъснато електрозахранване в района на Аксаково",
            "content": (
                "Поради възникнала повреда по електропровод 20 kV без "
                "захранване са клиенти в с. Кичево, с. Куманово и "
                "с. Осеново. Екипите на дружеството работят по "
                "възстановяването."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(location_name="с. Кичево",
                                sublocations=[], is_polygon=False),
                    Sublocation(location_name="с. Куманово",
                                sublocations=[], is_polygon=False),
                    Sublocation(location_name="с. Осеново",
                                sublocations=[], is_polygon=False),
                ],
                start_time=None,
                end_time=None,
            ),
        },
        {
            "name": "epro-district",
            "category": "epro",
            "note": "whole residential complex, no streets listed",
            "title": "Прекъсване на електрозахранването в ж.к. Възраждане",
            "content": (
                "Поради възникнала повреда по мрежата е прекъснато "
                "електрозахранването на клиенти в ж.к. Възраждане. Екип на "
                "дружеството работи по отстраняване на повредата."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="ж.к. Възраждане",
                        sublocations=[],
                        is_polygon=False,
                    )
                ],
                start_time=None,
                end_time=None,
            ),
        },
        {
            "name": "heating",
            "category": "heating",
            "note": "heating outage with unknown end time",
            "title": "Спиране на топлоподаването в ж.к. Младост",
            "content": (
                "Поради отстраняване на авария на топлопровод се преустановява "
                "топлоподаването към абонатите в ж.к. Младост, бл. 106 до "
                "бл. 148, и ул. Академик Андрей Сахаров. Срокът за "
                "възстановяване ще бъде уточнен допълнително."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="ж.к. Младост",
                        sublocations=["Академик Андрей Сахаров"],
                        is_polygon=False,
                    )
                ],
                start_time="08:00",
                end_time=None,
            ),
        },
        {
            "name": "heating-planned",
            "category": "heating",
            "note": "planned annual maintenance with a date-long window",
            "title": "Планово прекъсване на топлоподаването в ж.к. Трошево",
            "content": (
                "Във връзка с годишния планов ремонт на топлопреносната "
                "мрежа, на 10.07 от 08:00 до 22:00 ч. се преустановява "
                "подаването на топла вода към абонатите в ж.к. Трошево и "
                "ул. Хан Кубрат."
            ),
            "ai_output": AiOutput(
                locations=[
                    Sublocation(
                        location_name="ж.к. Трошево",
                        sublocations=["Хан Кубрат"],
                        is_polygon=False,
                    )
                ],
                start_time="08:00",
                end_time="22:00",
            ),
        },
        {
            "name": "roads",
            "category": "roads",
            "note": "АПИ road-works broadcast (city_wide, LLM summary as content)",
            "title": "Ограничава се движението по АМ „Хемус“ в посока Варна",
            "content": (
                "До 17:00 ч. движението по АМ „Хемус“ в посока Варна при км 424 "
                "се осъществява само в изпреварващата лента поради ремонт на "
                "пътната настилка. Шофирайте внимателно."
            ),
            "ai_output": AiOutput(locations=[], start_time=None,
                                  end_time=None, city_wide=True),
        },
        {
            "name": "roads-bridge",
            "category": "roads",
            "note": "lane closure on the Asparuhov bridge (city_wide)",
            "title": "Ограничение на движението по Аспарухов мост",
            "content": (
                "От 09:00 ч. до 18:00 ч. движението по Аспарухов мост се "
                "осъществява двупосочно в една лента поради инспекция на "
                "съоръжението. Очакват се затруднения в трафика към "
                "кв. Аспарухово."
            ),
            "ai_output": AiOutput(locations=[], start_time=None,
                                  end_time=None, city_wide=True),
        },
        {
            "name": "vt",
            "category": "vt",
            "note": "public transport route change broadcast (city_wide)",
            "title": "Промяна в маршрута на автобусни линии",
            "content": (
                "Във връзка с ремонт на пътното платно по бул. Левски, от "
                "10.07 автобусните линии се движат по обходен маршрут през "
                "ул. Девня и бул. Приморски до втора заповед.\n\n"
                "Засегнати линии: 17, 18, 148"
            ),
            "ai_output": AiOutput(locations=[], start_time=None,
                                  end_time=None, city_wide=True),
        },
    ]


def submit(case: dict) -> dict | None:
    """POST one case the way common.submit_to_api does; return the response body."""
    payload = {
        "id": str(uuid.uuid4()),
        "category": case["category"],
        "original_message": {
            "title": case["title"],
            "content": case["content"],
        },
        "processed_data": case["ai_output"].model_dump(),
    }

    headers = {}
    if cfg.ASP_API_KEY:
        headers["X-Api-Key"] = cfg.ASP_API_KEY

    try:
        response = common._api_session.post(
            cfg.ASP_API_URL,
            json=payload,
            headers=headers,
            verify=cfg.ASP_API_VERIFY_SSL,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        log.error("[%s] submit failed: %s", case["name"], exc)
        return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send realistic scraper payloads to the ASP API.")
    parser.add_argument("--only", action="append", metavar="NAME",
                        help="send only the named case(s); repeatable")
    parser.add_argument("--list", action="store_true",
                        help="list cases without sending")
    parser.add_argument("--neighborhood", default="кв. Бриз",
                        help="district for the vik-street case")
    parser.add_argument("--street", default="Сирма войвода",
                        help="street for the vik-street case")
    parser.add_argument("--live-polygons", action="store_true",
                        help="resolve polygons via PostGIS/OSM instead of the "
                             "canned FeatureCollection")
    parser.add_argument("--delay", type=float, default=3.0, metavar="SECONDS",
                        help="pause between sends (default: 3)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cases = build_cases(args.neighborhood, args.street)
    if args.only:
        unknown = set(args.only) - {c["name"] for c in cases}
        if unknown:
            parser.error(f"unknown case(s): {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["name"] in args.only]

    if args.list:
        for case in cases:
            print(f"{case['name']:14} [{case['category']:7}] {case['note']}")
        return 0

    if args.live_polygons:
        pg_conn = common.open_pg_connection("TEST")
        try:
            for case in cases:
                for loc in case["ai_output"].locations:
                    if loc.is_polygon:
                        loc.polygon_geojson = None  # force a fresh build
                common.build_polygons("TEST", case["ai_output"], pg_conn,
                                      case["name"])
        finally:
            if pg_conn is not None:
                pg_conn.close()

    print(f"Target: {cfg.ASP_API_URL}\n")
    total_notified = 0
    failures = 0
    for i, case in enumerate(cases):
        if i and args.delay > 0:
            time.sleep(args.delay)
        result = submit(case)
        if result is None:
            failures += 1
            continue
        notified = result.get("notified_count", 0)
        total_notified += notified
        print(f"{case['name']:14} [{case['category']:7}] "
              f"notified={notified}  alert={result.get('alert_id')}")

    print(f"\n{len(cases) - failures}/{len(cases)} submitted, "
          f"{total_notified} notification(s) sent — check your phone.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
