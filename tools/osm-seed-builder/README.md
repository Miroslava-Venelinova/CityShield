# OSM seed builder

A local UI for building the `regions` and `streets` reference data from
OpenStreetMap via Overpass, so those tables stop being hand-maintained.

The tool works entirely inside its own `output/` directory:

```
output/regions.json   ← extractions are merged here
output/streets.json
output/seed.sql       ← generated from those two
                      ↓ applied to D1
                      ↘ merged into backend/seeds/ only when you press step 4
```

`output/` is gitignored, so extracting and applying is free of consequence for
the repo. `backend/seeds/` — the checked-in data the app is built from — is
written by exactly one button, which is the point of the separation.

```bash
python tools/osm-seed-builder/app.py
```

It prints a tokenized `http://127.0.0.1:<port>/?t=<token>` URL and opens it in your
browser. Standard library only — no `pip install`. Python 3.11+.

## What it does

1. **Resolve an area.** Pick a country (Bulgaria by default) and type a name
   (`Варна`). The tool asks Overpass for matching administrative boundaries and
   shows each with its `admin_level`, so you can pick the province (4), the city
   (8) or a district (9). Area ids are never hardcoded; the presets in
   `presets.json` are just prefilled search terms.
2. **Pick what to extract.** Streets, minor street classes, neighbourhoods/quarters, cities/towns/villages,
   or administrative boundaries. The query is built live and shown greyed out.
   Tick *Edit the query by hand* to take it over — changing the country, area or
   kind afterwards regenerates it and discards your edits, with a warning, since
   a hand-written query would otherwise silently describe a stale selection.
   Switching **endpoint** does not discard anything: it changes where the query
   is sent, not what it says, and switching mirrors is the normal response to a
   rate limit.
3. **Run it.** Results are grouped by name with an averaged centre point and the
   number of OSM elements that contributed (a street is typically many `way`
   segments sharing one `name` tag). Filter and deselect anything you don't want.
   **Cyrillic names only** is on by default — see below.
4. **Merge into `output/`.** Selected rows are merged into `output/regions.json`
   or `output/streets.json`, keyed on the exact name. The report tells you what
   was added, what had coordinates filled in, and what was left alone.
5. **Generate `output/seed.sql`.** Runs `backend/seeds/generate-seed.mjs` with
   `--in output --out output/seed.sql`. The backend's generator rather than a
   copy of it, so the upsert semantics pinned by
   `backend/test/seed-upsert.spec.ts` are the ones that actually get applied;
   `backend/seeds/seed.sql` is not touched.
6. **Apply to D1.** `wrangler d1 migrations apply` then
   `wrangler d1 execute --file=output/seed.sql`, local or remote. Migrations
   first, because the coordinates only have columns to land in from `0005`
   onwards. The remote button asks for confirmation, because it writes to
   production.
7. **Merge into `backend/seeds/`.** A separate button, and the only thing in the
   tool that writes outside `output/`. It runs the same name-keyed merge as
   step 4, one hop further along. Review the git diff before committing.

**Open in Explorer** reveals `output/` in the desktop file manager (Explorer,
Finder or `xdg-open`), for when you want to read the JSON or the generated SQL
directly. The path is a constant on the server side, never taken from the
request.

**Wipe output** deletes the three files above and nothing else — by name, not by
globbing `output/`, so `.gitignore` and anything you parked there survive. It
asks first, showing what the files currently hold. `backend/seeds/` and the
database are untouched: a wipe throws away the tool's working set, not anything
you already applied or promoted.

Steps 6 and 7 are independent: applying to a local database to try the data out
does not commit you to changing the checked-in seeds, and promoting to
`backend/seeds/` does not touch any database.

## Self-hosted Overpass (recommended)

The public Overpass endpoints are a shared free service. They rate-limit (HTTP
429) and shed load (504), and a global name lookup or a full street extract is
right at the edge of what they will answer — during development of this tool
`overpass-api.de` started refusing requests partway through a verification run.
A local instance has no quota.

Geofabrik publishes a **Bulgaria-only extract (~170 MB)**, so there is no need to
import Europe or the planet:

```sh
cd tools/osm-seed-builder/overpass
docker compose up -d      # first run downloads and indexes; takes a while
docker compose logs -f    # watch progress
```

Then choose **Self-hosted (localhost:12345)** in the endpoint dropdown.

Notes:

- **Readiness is not "the port answers".** HTTP comes up well before area
  generation finishes, and every query the tool builds starts with `area(...)`.
  It is ready when this returns an id:
  ```sh
  curl -s --data-urlencode 'data=[out:json];area["ISO3166-1"="BG"][admin_level=2];out ids;' \
    http://127.0.0.1:12345/api/interpreter
  ```
- The named volume `overpass_overpass-db` holds the database, so restarts do not
  re-import. `docker compose down -v` deletes it and forces a fresh import.
- **Five settings in the compose file are load-bearing.** Every one of them was
  found by hitting the failure, and three fail in ways that look like success:
  - `OVERPASS_USE_AREAS: "true"` — areas are generated *only* when this is exactly
    `"true"`, and it has no default. Without it the import succeeds, the API
    answers, and every extraction silently returns nothing, because each query
    starts with `area(...)`.
  - `OVERPASS_STOP_AFTER_INIT: "false"` — otherwise the container imports, prints
    `initialization complete`, and **exits 0**. A clean-looking success with
    nothing listening on 12345.
  - `OVERPASS_PLANET_PREPROCESS` — the image pipes the download into `bunzip2`,
    so it expects bz2-compressed XML and dies on a `.pbf` with
    `bunzip2: (stdin) is not a bzip2 file`. Geofabrik publishes no `.osm.bz2` for
    Bulgaria (404), only PBF, so the hook converts it with the `osmium` already
    in the image.
  - `OVERPASS_ALLOW_DUPLICATE_QUERIES: "yes"` — the default `no` rejects an
    identical query repeated shortly after the first, and returns an HTML error
    page rather than JSON. Re-running the same extraction is the normal workflow
    here.
  - The `fix-db-perms` init container — `/db` is the `overpass` user's home and
    ships as mode `700`. A named volume preserves that, but the CGI serving
    queries runs as `nginx`, which then cannot traverse into `/db` to reach the
    dispatcher socket:
    `runtime error: open64: 13 Permission denied /db/db//osm3s_osm_base`.
    Bind mounts don't hit this; named volumes do.
- `restart: on-failure:3` rather than `unless-stopped`: a failed init re-downloads
  the entire extract, so an unbounded restart policy turns a config mistake into
  a download loop against Geofabrik.
- **No `OVERPASS_DIFF_URL`.** Pointed at `bulgaria-updates/` the updater failed on
  every pass (`Error while downloading diffs`, status 3) even once it was reading
  the state files successfully — the import already sits at the latest published
  sequence. The database is therefore a **snapshot**, and its coverage can differ
  slightly from live OSM (during testing, one `admin_level` 9 relation present on
  the public API was absent locally). For street and district names that is a fine
  trade; to refresh, re-import with `docker compose down -v && docker compose up -d`.
- `OVERPASS_META=no` — metadata lives in Geofabrik's `-internal-` files, which
  need an OSM login, and seeding wants names and geometry, not changeset history.
- The extract carries thin border strips of the neighbouring countries. That is
  why the country field is worth keeping set even against the local instance.

## Seed file format

`output/*.json` and `backend/seeds/*.json` use the same format, which is what
lets one merge function serve both hops. The tool writes objects and reads
either form, so a half-migrated file still works:

```jsonc
// current
[{ "name": "Дубровник", "lat": 43.1953, "lng": 27.9021 }]
// legacy, still accepted
["Дубровник"]
```

`lat`/`lng` are nullable. A name with no coordinates behaves exactly as it did
before migration 0005 — alert enrichment falls back to Nominatim for it.

## Adding new data later

Re-running is safe at both layers, which is the whole point of the design:

- **Merging** matches on the exact name, the same key as the `UNIQUE` constraint
  on `region_name` / `street_name`. Known names are skipped; only genuinely new
  ones are appended. Entries are written sorted, so the git diff shows only what
  changed. This holds for both hops — extraction → `output/`, `output/` →
  `backend/seeds/`.
- **Applying** uses the `ON CONFLICT … DO UPDATE SET lat = COALESCE(excluded.lat, …)`
  that `generate-seed.mjs` emits. Re-applying `seed.sql` inserts new rows and
  backfills missing coordinates, and never blanks coordinates already in the
  database. Pinned by `backend/test/seed-upsert.spec.ts`.

Tick *Overwrite coordinates* only when you deliberately want to re-derive points
for names that already have them — for example after OSM data improves.

## admin_level cheat sheet

The UI carries this table too, under the area field.

| Level | Meaning | Example |
|---|---|---|
| 2 | държава — country | България |
| 4 | област — province (28) | Варна, Стара Загора |
| 5 | община — municipality | община Варна, Чирпан |
| 8 | населено място — city, town, village | гр. Варна, с. Аврен |
| 9 | район — city district | districts of Варна, София |
| 10 | квартал — neighbourhood (rare) | Дебър, Любеново |

**Pick 4** to cover a whole province — the scope the current seed data was built
at. **Pick 8** for a single city.

## Which highway classes count as a street

**Streets** covers `motorway`, `trunk`, `primary`, `secondary`, `tertiary`,
`unclassified`, `residential`, `living_street`, `pedestrian`, `road` — what a
person would give as an address.

**Streets — minor classes only** covers what that leaves out: `service`,
`track`, `path`, `footway`, `steps`, `raceway`. It is a separate kind rather
than a checkbox because it is mostly noise (parking aisles, forest tracks,
`McDrive`) and every extra name is something the fuzzy matcher scores against on
every lookup — but it is *not* only noise. Of 134 names in the pre-OSM seed data
that the default extraction misses, 115 are real Varna streets tagged in a minor
class: `Акад. Игор Курчатов` and `Обръщач Почивка` are `service`, `Артемида` and
`Гергина` are `track`, `алея Изток` is `footway`. Extract this kind, deselect
by eye, and merge the survivors.

Nothing in the pipeline drops a name for lacking coordinates — the merge stores
`lat`/`lng` as `null` and the row still seeds. The one geometric drop is an
element Overpass returns with no `center` at all, which did not happen once
across the Варна province extract.

## The Cyrillic filter

On by default. A name is kept if it contains **at least one** Cyrillic character
anywhere — whole-name matching would throw out every legitimate name carrying a
digit or a Latin block letter (`ул. Драган Цанков 5`, `бл. 12А`).

It exists because the country bounding box deliberately over-admits rather than
risk hiding a real result, so Greek, Turkish and Romanian names from the border
strips do reach the results table. Alerts are written in Bulgarian, so a
Latin-script name is dead weight the fuzzy matcher scores against on every lookup.

**It is not lossless, and the count is always reported.** A Варна street extract
drops three names — `Arch. Stoian Dokov`, `Bezmer`, `Doc. D-r Vladimir Vasilev` —
which are real Varna streets whose OSM `name` tag was filled in transliterated.
Seeding them would not help (an alert says `ул. Арх. Стоян Доков`, which will not
fuzzy-match the Latin spelling) but it does mean those streets stay unseeded and
fall back to Nominatim. Untick the box if you want to see and judge them.

## How the country filter works

The field is free text and takes `България`, `Bulgaria` or `BG`; leave it blank
to disable the filter, at the cost of a much slower lookup.

It is a **bounding-box test on each candidate's centre**, not an Overpass
`(area.country)` filter. That filter is unreliable for relations: scoping
`Варна` with it silently dropped relation 8085317, a genuine `admin_level` 9
district inside the city. A bounding box can never hide a real result, and every
candidate is listed with its `admin_level` so the final choice is yours.

## Why the tokenized URL

The server shells out to `wrangler d1 execute --remote`. Without a guard, any
page open in your browser could POST to `localhost` and reach the production
database. So every request must carry the startup token, and the `Host` header is
pinned to loopback to block DNS rebinding. The token changes on every run.

## Caveats

- **Centroids are crude.** A long or discontinuous street's averaged centre can
  sit hundreds of metres off, or in rare cases off-street entirely. This is the
  map pin for an alert, not geometry — Nominatim's single point was no better.
- **Overpass is a shared free service.** 429 and 504 responses mean "wait, or use
  another mirror", not "the query is wrong". Both are reported as such.
- Extraction only covers what OSM knows. Rows OSM has never heard of stay in the
  seed files untouched; the merge never deletes.
