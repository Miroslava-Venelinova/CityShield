# Polygon tester

A local web UI that runs the block-polygon builder and **draws every stage of it**.

```
python tools/polygon-tester/app.py
```

It prints a tokenized `http://127.0.0.1:<port>/?t=<token>` URL and opens it. Standard library
only on the Python side; the Node side needs nothing installed beyond what `backend/` already
has.

## Why it exists

An alert that lists streets is meant to come out as a ring around the block they enclose. When
it doesn't, the stored row says `is_polygon: false` and one line of reason — and that line
cannot tell you whether the geometry was judged correctly:

> all 1 enclosed area(s) were bounded by a single street

is the right answer for one alert and a bug for the next. The difference is visible on a map and
nowhere else. Every threshold in `polygon.ts` is fitted to five Overpass fixtures, which is a
small sample, so the next bad polygon is going to be argued about by moving one of those numbers.
This is where that argument happens.

## It is not a reimplementation

`entry.ts` re-exports `buildBlockPolygon`, `fetchStreetWays`, `groupWaysByName` and `bestMatch`
straight out of `backend/src`; esbuild bundles it; `run.mjs` calls them. There is no second copy
of the geometry, the fuzzy matcher or the Overpass query, so a polygon you judge here is the
polygon ingestion would have built from the same ways and the same knobs.

The bundle is rebuilt automatically whenever anything under `backend/src` changes, so editing a
constant in `polygon.ts` and pressing **Build** already runs the new code. The UI says
`Rebuilt the Worker bundle` when that happens.

One thing the Worker does that this deliberately does not: resolve names against D1. It uses
`tools/osm-seed-builder/output/streets.json`, the same data the seed writes into the table.

CPU it does report, but only as a shape — see **worst burst** below. A setting that looks fine
in Node can still be too slow on a cold isolate; `wrangler tail`'s `cpuTime` settles that.

## The loop

1. **Street names** — paste them as the alert lists them, one per line. *Resolve against the
   street seed* runs `bestMatch` at `POLYGON_RESOLVE_THRESHOLD`, exactly as
   `buildPolygonForStreets` does, so `ул. Йордан Йовков` finds `Йордан Йовков`. Names that
   resolve to nothing are dropped and called out — Overpass matches `name` exactly, so they
   could only ever have returned nothing.
2. **Ways** — either a checked-in fixture from `backend/test/fixtures/` (what the test suite
   runs on) or something this tool fetched. **Fetch** goes to Overpass once and writes the
   response to `cache/`; every build afterwards reads the file. Overpass rate-limits, so
   re-fetching the same streets to try another threshold is the one thing to avoid.
3. **Build** (<kbd>b</kbd>, or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> from the street box).
4. **Read the map**, move a knob, build again.
5. **To fixture** copies a cached fetch into `backend/test/fixtures/overpass-<name>.json`, where
   `test/polygon.spec.ts` can reach it. That is how a bad polygon becomes a regression test.

## What the map shows

| Layer | |
|---|---|
| **Road bands** | Each centreline widened by the road half-width and unioned. The blocks are this shape's *holes*, which is why a dual carriageway can no longer produce one. |
| **Street centrelines** | What Overpass returned and the clip kept, one colour per street, matching the table. |
| **Clipped-off fragments** | Grey dashed: returned but dropped as too far away. Usually a same-named street in another settlement. |
| **Clip window** | The box everything is clipped to — the shortest street's extent grown to reach every other street, plus the margin. |
| **Enclosed areas** | Every hole in the road network, coloured by verdict: green won, amber lost the sort, red was bounded too heavily by one street, grey was bounded by fewer than two. |

Click a row in either table to zoom to it and dim the rest; click again, or **Fit** (<kbd>f</kbd>),
to go back. Drag to pan, scroll or <kbd>+</kbd>/<kbd>−</kbd> to zoom, drag the map's bottom edge
to make it taller.

**Worst burst**, next to the enclosed-area count, is the longest uninterrupted
stretch of synchronous work in the run. The free plan caps *that* at 10 ms, not the total,
which is why `buildBlockPolygon` yields between its stages (SPEC §1.9). It is measured in
this tool's Node process, so read it as a shape rather than as the platform's accounting —
a cold Worker isolate costs several times more, and `wrangler tail`'s `cpuTime` is the truth.

**Mean width** is `2·area/perimeter`. A gap between two carriageways measures ~10 m; a real block
runs to a few hundred. It is the fastest way to recognise a sliver that slipped through.

**The shares** are of the block's *own* boundary, counted from the ring samples — the number
`maxSingleStreetCoverage` is decided on. They do not add to 100%: a corner sample can be near two
streets, and a stretch bounded by no listed street is near none. Over the current fixtures real
blocks give their busiest street 17–42% and every rejected sliver gives it 90–100%, which is why
0.7 sits where it does.

## The knobs

Each one overrides a constant `polygon.ts` otherwise defaults to. Moved knobs are marked amber,
because a run only means something relative to which constant you are currently disagreeing with;
**Reset** puts them all back to what the Worker ships. **Nothing you change here changes what the
Worker ships** — when a setting turns out to be right, edit `polygon.ts` and rerun the tests.

| Knob | |
|---|---|
| `extensionDist` | How far each centreline is stretched past its ends, to close a corner OSM left open. Too short and a real block never closes: Левски needs 50 m, Русе 150, Варненчик 200. Sweep it — a block whose area barely moves from 50 m to 500 m is real; one that grows with the stub is not. |
| `roadHalfWidth` | Half the band a centreline becomes. This is what fuses a boulevard's two carriageways, and the primary defence against slivers. Too wide starts eating small blocks — 25 m takes set 1 from 2.06 ha to 1.19 ha. |
| `clipMargin` | Slack around the streets' reach. Everything outside is dropped before any geometry runs. |
| `sampleStep` | Spacing of the ring samples the shares are counted from. Halving it doubles the most CPU-heavy loop in the Worker. |
| `maxSingleStreetCoverage` | Above this share of one block's boundary, that block is a strip of road. |
| `minTouchSamples` | Below this many samples, a street is crossing the block rather than bounding it. |

## The street table

`Ways` and `Points` are what Overpass returned per name; `Kept` is how many fragments survived
the clip, with `−n` for the dropped ones.

**`Extent` is the one to watch.** It is flagged amber past 5 km, because the Overpass query scopes
itself with `area["name"="Варна"]["boundary"="administrative"]` and nothing pins the admin
level — so it matches the *province*, not the city, and a common street name arrives with
same-named stretches from settlements up to 25 km away. `Железни врата` comes back spanning
11 × 26 km, `Преслав` 39 × 10 km. The clip window is a band-aid over that, not a feature, and
which fragment happens to be "shortest" decides where the clip centres. Focus a street to see it:
the map fits its dropped fragments too, which is what makes the spread obvious.

## Presets

`presets.json` (tracked) holds the five cases the current thresholds were fitted to. All five
enclose a real block of 2–39 ha, and all but one also produce a carriageway sliver that is
rejected — which is the pair the thresholds have to get right. Selecting one loads its streets, its fixture
and its knobs and builds immediately, so "did my change break a case that used to work" is one
click per case. **Save** adds or overwrites one under the label in the box.

## Files

```
entry.ts        what the tester imports from backend/src — the whole surface, ~10 lines
run.mjs         one job in, one JSON document out; a fresh process per run
app.py          the server: bundles, runs Node, holds the cache and the presets
index.html      the UI and the hand-rolled map
presets.json    tracked: the five fitted cases
cache/          gitignored: fetched Overpass responses
.build/         gitignored: the esbuild bundle
```

A fresh process per run is deliberate: the module-scope Overpass cache and the fuzzy matcher's
gram tables are rebuilt each time, so a run can never be influenced by the previous one's state.
It costs ~200 ms and buys the ability to trust a comparison between two runs.

## Why the loopback guards

Same trust model as `tools/alert-review` and `tools/osm-seed-builder`: the Host header is pinned
to loopback and every call carries the printed token. This process runs Node and can reach
Overpass on request, so no other page in your browser gets to drive it. Street names travel to
Overpass only when you press **Fetch**; the browser fetches map tiles, and nothing else leaves
the machine.
