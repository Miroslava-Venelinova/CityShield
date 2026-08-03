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

## Sweep a province — one input, the whole seed

The card at the top of the page takes a province name and nothing else. It
produces the three levels the app targets by (SPEC.md §1.7):

| Level | What it extracts | How it is tied |
|---|---|---|
| settlement | `place=city\|town\|village\|hamlet` in the province | — |
| district | `place=suburb\|neighbourhood\|quarter\|borough` | found **inside** the settlement's own `admin_level 8` boundary |
| street | the addressable `highway` classes | filed under that same settlement |

A district's settlement is not inferred after the fact from distance or nearest
centre — the containment *is* the query, so `кв. Виница` comes back as a result
of asking what is inside Варна.

Варна province takes about **35 seconds** against the self-hosted instance: 171
settlements, ~2,900 streets, 80 districts. That is one Overpass request per
settlement, so run it against localhost — a public mirror will rate-limit long
before the end. Progress is polled and shown per settlement; a silent minute
would be indistinguishable from a hang.

Everything lands in `output/` through the same merge the manual flow uses, so
re-running only ever adds — unless you tick *Re-resolve entries already in
`output/`*, which lets a corrected sweep replace links and coordinates it wrote
before. Steps 3–4 below (generate SQL, apply, promote) are unchanged.

**Settlements it cannot reach are listed by name, not just counted.** A
settlement with neither a boundary nor a centre has nothing to search, and that
is a hole in the seed you want to see.

### District names that are not unique

`regions` is keyed by name alone — that is what its `UNIQUE` constraint says —
but a *district* name is only unique inside its settlement. The same mismatch
migration 0015 fixed for streets, and it is why the sweep decides the links only
after every settlement has been seen rather than as it goes. Six names in Варна
province are claimed by more than one settlement, and they are two different
problems wearing one hat. The sweep separates them by **OSM element id**, not by
distance: settlement centres here come as close as 0.37 km, so no radius could
tell the two apart.

#### Two places, one name → two rows

`Цветен квартал` is node `9664925200` in Варна *and* node `10702624492` in
Белослав, 17.5 km apart. Nothing is wrong with the data and neither claim should
lose, so **both are kept — under the one name they are both really called.**
Migration 0017 keys `regions` on (name, settlement), so the name no longer has to
be unique and nothing has to be renamed.

That replaces the suffix migration 0014 wrote by hand. A parenthesised settlement
was a poor key: no source writes `Цветен квартал (Белослав)`, so the row was
reachable only by fuzzy-matching a string nobody produces, while the fact that
actually distinguishes the two places was already sitting in the row as its
parent link. Reaching the right one is now the caller's job — pass the settlement
the message named, and `matchRegion` picks the district inside it.

Before this, keying the geometry by name alone also gave the surviving row the
**average of both nodes** — a point in open country between the two towns.

#### One place, several claimants → one row

Two things cause it, and they need opposite answers:

- **A radius overreaching.** 11 of the province's 12 hamlets have no boundary, so
  the 2,500 m fallback reaches into a neighbour. `ж.к. Север` is Провадия's
  (boundary, 1.5 km) and three `м-т` hamlets grabbed a copy — м. Шашкъните from
  0.24 km, *nearer than the town*. Proximity alone would hand it to the hamlet,
  so **a boundary match beats a radius match**.
- **A boundary that is not a settlement's.** `admin_level 8` in Bulgaria is the
  **община**, so the relation named "Варна" spans the whole municipality —
  Кичево and Осеново sit inside it. That is how the city came to claim four
  villa zones 8–12 km out that are 2.1–2.7 km from a village. Containment by an
  area that large says nothing about which settlement a place is *in*, so among
  boundary matches the **nearest settlement wins**, not the biggest.

Every split and every tie-break is reported after the run, with what else claimed
the name and why it lost. A rule you cannot see applied is one you cannot notice
being wrong.

**Correcting a link a previous sweep wrote** needs *Re-resolve entries already in
`output/`*. Without it the merge only ever fills in what is missing, so a link
written before the rules above were fitted stays wrong however often you re-run.

#### Do villages have districts?

Worth stating, because the answer is not the obvious one. In Варна province:

| Owner | District hits | Matched via |
|---|---|---|
| city (Варна) | 58 | boundary |
| town | 9 | boundary |
| village | 17 | boundary |
| hamlet | 7 | **radius only** |

A village has no `ж.к.` — but its administrative boundary does legitimately
contain `с.о.`/`со` **villa zones** (`селищно образувание`), which are
countryside formations rather than housing estates. Those 17 are all of that
kind. The hamlet rows are the actual noise, and they are the radius artefact
above.

A **town** is not a village: Белослав (~7,000) really does have `ж.к. Младост`,
`кв. Акациите` and `Цветен квартал` — confirmed against Nominatim. Its Младост
node sits inside the Белослав boundary with 164 buildings within 400 m, thirteen
of them 4–5 storey residential blocks, and migration 0014 reached the same
conclusion independently by reverse-geocoding that centroid. It is not a
misplaced node.

The `с.о.` rows are the case that makes "the bigger settlement owns it" the wrong
rule. A villa zone is not part of the city that its *municipality* contains: `со
Лозите` is 2.2 km from Кичево and 8.3 km from Варна, and Кичево is where it
belongs.

What none of this catches is a swept district colliding with an existing region
that means something else *inside the same settlement* — two different places,
one name, one parent. That is the one case the (name, settlement) key cannot tell
apart either. Read the `regions.json` diff before promoting.

### Why streets are not tied to districts

The seed carries `street → settlement`, never `street → district`, and that is a
limit of OSM rather than of the schema. Of Варна province's 80 districts, **68
are mapped as a single node with no extent at all** — and the 12 that do have a
polygon are all `м-т`/`с.о.` villa zones. Every district a person would name in
an alert (Виница, Аспарухово, Галата, Чайка) is a bare point, so there is no
geometry to test a street against.

It also would not help if there were: a boulevard crosses several districts, so
"which district is this street in" has no single answer, and `streets.region_id`
holds exactly one region. Targeting never asks the question either — the
audience comes from the area and the street scope from the settlement (SPEC.md
§1.5).

## What the step-by-step flow does

Still there below the sweep, for refining what it produced or for pulling one
settlement on its own.

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
   or `output/streets.json`, keyed the way the `UNIQUE` constraint is — the name
   for regions, `(name, settlement)` for streets. For streets the *Settlement*
   field is required and is checked against the regions the seeds hold, because
   a street filed under a name that is not a region inserts nothing and says
   nothing. The report tells you what was added, what had coordinates filled in,
   and what was left alone.
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
   tool that writes outside `output/`. It runs the same merge as step 4, one hop
   further along; each street carries the settlement it was filed under, so
   nothing has to be re-stated here. Review the git diff before committing.

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
overpass.bat              # first run downloads and indexes; takes a while
```

`overpass.bat` is a double-clickable wrapper around the compose commands below.
With no arguments it imports on a first run, and on later runs shows what exists
and offers to re-import; either way it then waits and tells you when the
instance actually answers area queries. `start`, `refresh`, `status`, `stop` and
`logs` do those things directly — see the header of the file. The plain compose
commands work exactly as before:

```sh
docker compose up -d      # create/start
docker compose logs -f    # watch progress
docker compose down       # stop, keeping the database
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
- **The database is the volume, not the container.** The named volume
  `overpass_overpass-db` holds it, and the image imports *only when `/db` is
  empty* — so deleting and recreating the container picks up nothing new, and a
  restart is fast for the same reason. Refreshing the data means deleting the
  volume: `docker compose down -v && docker compose up -d`, or `overpass.bat
  refresh`. The re-import downloads `bulgaria-latest.osm.pbf`, which Geofabrik
  rebuilds daily, so it lands at most about a day behind live OSM.
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
// regions — a settlement is in nothing, so it carries no `settlement`
[{ "name": "Аврен", "lat": 43.1138, "lng": 27.6658 }]
// regions — a district names the settlement it is IN (migration 0016)
[{ "name": "кв. Виница", "settlement": "Варна", "lat": 43.2419, "lng": 27.9603 }]
// streets — `settlement` since migration 0015
[{ "name": "ул. Тича", "settlement": "Аврен", "lat": 43.11, "lng": 27.66 }]
// legacy, still accepted (a street with no settlement reads as Варна)
["Дубровник"]
```

`settlement` means the same thing in both files — "which settlement is this in" —
but it lands in a different column: `streets.region_id` for a street,
`regions.settlement_id` for a district. A region whose `settlement` equals its
own name is read as having none, because a place does not contain itself.

A merge fills in a missing link the way it fills in missing coordinates, and
**never overwrites one that is already there**. A link that disagrees with the
file is a data question, not something a re-run should quietly decide.

`lat`/`lng` are nullable. A name with no coordinates behaves exactly as it did
before migration 0005 — alert enrichment falls back to Nominatim for it.

`settlement` is a region **name**, not an id: region ids are autoincrement and
differ between the local and the remote database, so `generate-seed.mjs` resolves
the name at apply time (`INSERT … SELECT id FROM regions WHERE region_name = ?`).
It must match a `regions.json` entry **exactly** — see the warning below.

## Streets are extracted one settlement at a time

The province sweep above does this for you, per settlement, in one pass — this
section is the rule it follows and what the manual flow still has to obey.

A street row points at the settlement it is in, so an extraction has to be
attributable to exactly one:

1. Extract the **regions** first, at whatever scope you like (province, level 4,
   is fine — that is how the 252 settlements were seeded).
2. Then extract **streets** per settlement, resolving an `admin_level 8`
   boundary each time. The tool reads the boundary's own name back from Overpass
   and fills the *Settlement* field in from it; resolving anything coarser says
   so rather than guessing, because a level 4 or 5 boundary spans hundreds of
   settlements and no single answer would be right.

Why it cannot be dodged by extracting a whole province in one pass: street names
repeat heavily across settlements. Of the 94 distinct names Overpass returns
around Тополи, Аврен and Долни чифлик, 49 — 52% — already exist in the Варна
seed. Under the old name-only key half of any village extraction was silently
swallowed as a duplicate of the city.

> **A settlement that is not a region inserts nothing, silently.** The generated
> SQL resolves the settlement with a `SELECT` against `regions`; no row means no
> insert and no error. The tool refuses a merge whose settlement is not in either
> `regions.json` for exactly this reason, and `generate-seed.mjs` prints a warning
> naming any settlement it cannot find. Neither can help you if the region only
> exists in a database you already applied to and not in the seed files, so check
> the counts after applying.

## Adding new data later

Re-running is safe at both layers, which is the whole point of the design:

- **Merging** matches on the same key as the `UNIQUE` constraint — the exact name
  for regions, `(name, settlement)` for streets since migration 0015. Known
  entries are skipped; only genuinely new ones are appended. Entries are written
  sorted (settlement first, so a village reads as one block in the diff), so the
  git diff shows only what changed. This holds for both hops — extraction →
  `output/`, `output/` → `backend/seeds/`.
- **Applying** uses the `ON CONFLICT … DO UPDATE SET lat = COALESCE(excluded.lat, …)`
  that `generate-seed.mjs` emits, on `(street_name, region_id)` for streets.
  Re-applying `seed.sql` inserts new rows and backfills missing coordinates, and
  never blanks coordinates already in the database. Pinned by
  `backend/test/seed-upsert.spec.ts`.

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

**Regions: pick 4** to cover a whole province in one go — the scope the current
regions seed was built at. **Streets: pick 8**, one settlement per run; see
"Streets are extracted one settlement at a time" above.

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
