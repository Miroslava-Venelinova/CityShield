// Shared source-reachability checks: run inside the spike Worker (edge) and
// from check-local.mjs (local baseline). Marker strings mirror the selectors
// the production parsers in backend/scraping/scrape.py depend on.

export const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "bg-BG,bg;q=0.9,en;q=0.8",
};

const NOMINATIM_HEADERS = {
  "User-Agent": "CityShieldAPI/1.0 (migration spike; stunnybg@gmail.com)",
};

export const CHECKS = [
  {
    name: "vik",
    url: "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown",
    headers: DEFAULT_HEADERS,
    markers: { main_content: 'id="main_content"', list_item: "list-item", numeric_id: /(\d+)\.html/ },
  },
  {
    name: "vt",
    url: "https://www.varnatraffic.com/Info",
    headers: DEFAULT_HEADERS,
    markers: { info_accordion: "infoAccordion", accordion_group: "accordion-group" },
  },
  {
    name: "epro",
    url: "https://www.erpsever.bg/bg/profil/xhr/?method=get_interruptions",
    headers: { ...DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest" },
    json: (data) => {
      const areas = Array.isArray(data) ? data : [];
      const varna = areas.find((a) => a && a.area_name === "Варна");
      return {
        is_array: Array.isArray(data),
        varna_area: Boolean(varna),
        next48_bucket: Boolean(varna && "area_locations_for_next_48_hours" in varna),
        active_bucket: Boolean(varna && "area_locations_all_active" in varna),
      };
    },
  },
  {
    name: "heating",
    url: "https://energy-varna.bg/bg/съобщения-за-аварии-0",
    headers: DEFAULT_HEADERS,
    markers: { views_row: "views-row", node_link: "/node/" },
  },
  {
    name: "roads",
    url: "https://www.api.bg/bg/novini",
    headers: DEFAULT_HEADERS,
    markers: { news_panel: "news-panel", news_date: "news-date" },
  },
  {
    name: "overpass-kumi",
    url: "https://overpass.kumi.systems/api/interpreter",
    method: "POST",
    body: 'data=[out:json][timeout:10];area["name"="Варна"]["boundary"="administrative"];out ids 1;',
    headers: { "User-Agent": "CityShieldAPI/1.0 (migration spike; stunnybg@gmail.com)", "Content-Type": "application/x-www-form-urlencoded" },
    json: (data) => ({
      has_elements: Array.isArray(data && data.elements) && data.elements.length > 0,
    }),
  },
  {
    name: "overpass-main",
    url: "https://overpass-api.de/api/interpreter",
    method: "POST",
    body: 'data=[out:json][timeout:10];area["name"="Варна"]["boundary"="administrative"];out ids 1;',
    headers: { "User-Agent": "CityShieldAPI/1.0 (migration spike; stunnybg@gmail.com)", "Content-Type": "application/x-www-form-urlencoded" },
    json: (data) => ({
      has_elements: Array.isArray(data && data.elements) && data.elements.length > 0,
    }),
  },
  {
    name: "nominatim",
    url: "https://nominatim.openstreetmap.org/search?q=" + encodeURIComponent("Варна, България") + "&format=json&limit=1",
    headers: NOMINATIM_HEADERS,
    json: (data) => ({
      has_result: Array.isArray(data) && data.length > 0,
      plausible_lat: Array.isArray(data) && data[0] && Math.abs(parseFloat(data[0].lat) - 43.2) < 0.5,
    }),
  },
];

async function runCheck(check) {
  const started = Date.now();
  const result = { name: check.name, url: check.url, ok: false, status: null, ms: null, bytes: null, markers: {} };
  try {
    const res = await fetch(check.url, {
      method: check.method || "GET",
      headers: check.headers,
      body: check.body,
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    const text = await res.text();
    result.status = res.status;
    result.bytes = text.length;
    result.ms = Date.now() - started;

    if (check.json) {
      let data = null;
      try { data = JSON.parse(text); } catch { result.markers.valid_json = false; }
      if (data !== null) result.markers = { valid_json: true, ...check.json(data) };
    } else {
      for (const [key, marker] of Object.entries(check.markers)) {
        result.markers[key] = marker instanceof RegExp ? marker.test(text) : text.includes(marker);
      }
    }
    result.ok = res.ok && Object.values(result.markers).every(Boolean);
    if (!res.ok) result.body_sample = text.slice(0, 400);
  } catch (err) {
    result.ms = Date.now() - started;
    result.error = String(err);
  }
  return result;
}

// Sequential on purpose: mirrors production behavior and keeps Nominatim at 1 rps.
export async function runAllChecks() {
  const results = [];
  for (const check of CHECKS) {
    results.push(await runCheck(check));
  }
  return results;
}

