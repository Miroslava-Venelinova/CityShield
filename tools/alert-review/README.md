# Alert review

A local web UI for judging stored alerts one at a time. Ingestion runs each scraped message
through an LLM to get locations, a time window and a city-wide flag; that parse is
nondeterministic and it is wrong often enough to matter — a district pinned on one of its
streets, a window on yesterday's date, a location the message never mentioned. This tool puts
real rows in front of a person, records a verdict per alert, and exports a report you can paste
into a prompt-engineering discussion or commit as review notes.

```
python tools/alert-review/app.py [--csv alerts_export.csv]
```

It prints a tokenized `http://127.0.0.1:<port>/?t=<token>` URL and opens it. Standard library
only — no pip install. Nothing here writes to D1: the only statement is a constant `SELECT`.

## What it does

1. **Source** — `wrangler d1 execute` against the local or the remote database, or a CSV export
   with the columns `id, category, title, content, severity, start_time, end_time,
   windows_json, locations_json, created_on_utc`. `--csv` loads one at startup; the same picker reloads from
   either database without restarting. D1 reads are capped at 2000 rows, newest first, and the
   UI says so when the cap bites. A **cutoff date** next to the picker says how far back the
   review reaches; see below.
2. **List and filters** — free text over title and content, plus category, severity, review
   status, issue, important-only, created-date range, and inaccuracy reason.
3. **Detail** — content as scrollable text, the window in both `24.07.2026 09:00` and its raw
   stored form, a map of everything the alert targets, `locations_json` as a readable list of
   `name → lat, lng` (each pin also links out to OpenStreetMap), and **who the alert would
   notify** (below). Two folded panes underneath hold the pretty-printed `locations_json` and
   the **raw alert row** — every column as stored, with `null` shown where the column is NULL
   rather than as the empty string the display normalizes it to, and a `copy` link.
4. **Verdict** — one of three, below. Written to `judgments.json` on every judgment, not at the
   end, so closing the tab never costs you the tail of a session.
5. **Report** — `reports/review-<timestamp>.md` or `.json`, opened in the file manager as soon
   as it is written: issues with their alerts, the important ones first, reason counts, and
   category/severity breakdowns.

## The three verdicts

| | | |
|---|---|---|
| **Accurate** | <kbd>y</kbd> | The parse matches the source message. Saves and moves on. |
| **Inaccurate** | <kbd>n</kbd> | Something is wrong. Needs at least one reason from the taxonomy. |
| **Not implemented yet** | <kbd>m</kbd> | The parse isn't *wrong*, the thing simply isn't built — the source says something nothing in the pipeline looks for. Reasons are optional here, because the taxonomy is about wrongness. |

`Accurate` carries no reasons and no issues — they'd be dangling claims about an alert nobody is
going to fix — so setting it drops both.

## The cutoff — how far back the review reaches

A table that goes back far enough holds alerts from a pipeline that no longer exists. Arguing
about those one at a time is wasted effort, and leaving them in drags every percentage in the
report toward a version of the code nobody is going to change.

So say it once: **ignore alerts created before** a date, in the field next to the source picker.
Everything earlier goes out of scope — out of the list, out of the counts, out of the report —
and the report states the date it covers rather than leaving you to wonder why a number looks
low. Clear the field and they all come straight back; nothing is deleted, the rows stay loaded
on the server and judgments made before you set it keep their entry in the file.

The date is compared against `created_on_utc` converted to your local day, the same conversion
the created-from/to filter uses, so the two can't disagree. An alert whose timestamp won't parse
is always in scope: hiding a row because its date is unreadable is the kind of silent loss this
tool exists to catch.

The cutoff lives in `settings.json` and survives a restart. It replaced an *Old — excluded*
verdict, which asked a reviewer to press <kbd>o</kbd> a few hundred times to state one fact
about a date; leftover judgments carrying it are dropped at startup, with a line on the console
saying how many.

<kbd>i</kbd> marks an alert **important**, meaning fix this one first. It shows as `★` in the
list, has its own filter, and gets its own section at the top of the report. It persists
immediately if the alert is already judgeable, so a star never depends on remembering to press
<kbd>Enter</kbd> afterwards.

## The map

*Wrong coordinates* is the one verdict you cannot reach by reading. A district pinned on one of
its streets looks perfectly reasonable as `43.2085, 27.9142`, and a block polygon means nothing
at all until you see which streets it actually encloses — so the detail pane draws the alert:
OpenStreetMap tiles with every location on top, numbered to match the list below it.

- **A blue circle** is a plain pin: the coordinate the Worker matches users against by proximity.
- **A red ring with a red circle** is a polygon and its centroid. Everyone inside the ring is
  notified; the centroid is only what the app shows as the pin.
- **Clicking a location** in the list zooms to it and dims the rest; clicking it again, or
  **fit**, goes back to all of them. Drag to pan, `+` / `−` to zoom, and drag the bottom edge of
  the map if it wants to be taller.
- <kbd>g</kbd> hides the map, and it stays hidden across sessions. Tiles are fetched ~200 ms
  after an alert settles, so holding <kbd>j</kbd> through the list doesn't pull a screenful per
  alert on the way past.

The badge next to a location's name says which of the two kinds of targeting actually happened,
because the flag and the geometry are stored separately and can disagree:

| Badge | |
|---|---|
| `polygon · 34 pts` | A ring was built and stored. Everyone inside it was notified. |
| `polygon flagged, no geometry` | The parse asked for a polygon and the build produced none — the alert fell back to matching that location by name and radius. It reads as street-level targeting and isn't. |
| `geometry, not flagged` | A ring is stored but `is_polygon` is false, so it was never used. Ingestion normalizes this away today; an old row can still carry it. |

The report says the same thing on each location line, so a finding survives outside the tool.

No mapping library: this tool runs from a checkout with nothing installed, and the browser half
holds to that rule — the tiles are positioned by hand and the geometry is drawn as SVG over them.
It is the one thing here that talks to the network from your browser, and what it sends is the
tile coordinates of the area you are looking at, the same as the `map ↗` links.

## Who gets notified

A pin in the right place and an audience of nobody look identical in a stored row, and the
second is the more expensive mistake — the whole product is the push. So the detail pane
answers it outright: **N of M users would receive a push**, the users themselves, and one block
per location saying how it resolved.

`targeting.py` is a port of the Worker's targeting — `sendUsersNotification` and its
`getUserIdsInRange` / `getUserIdsInPolygonRange` / `getUserIdsCityWide`, plus the matcher stack
under them (`core/place-names.ts`, `core/fuzzy.ts`, `core/geo.ts`) — run against the same four
tables: `regions` (with its aliases), `streets`, `users` and the opt-out rows in
`user_notification_preferences`. Those are read once per **Load**, from whichever database you
picked; a CSV export holds alerts and nothing else, so with one loaded the pane says so instead
of answering "nobody".

It was checked against the real thing rather than eyeballed: 649 place names — every seeded
region, a slice of the streets, and every name the stored alerts have actually produced — put
through `matchRegion` and `matchStreet` in both implementations, scoped and unscoped, 3,245
comparisons, zero differences. **When the Worker's matcher changes, this has to change with
it**; the constants and function names are deliberately the same so a diff is findable.

Each location block names the two resolutions the audience hangs on, because that is where it
usually breaks:

| | |
|---|---|
| **settlement scope** | What the street lookup is scoped to. `unresolved` means no street can match at all — an unscoped lookup would notify a like-named street 30 km away, so it deliberately matches nothing. |
| **region** | The audience when no street matched. `unresolved`, with a `nothing matched` badge, means this location notifies nobody. |
| **the street list** | Each named street with what it resolved to, or `no such street` — a street the table doesn't hold is a seeding gap, not a parse error. |

Two things the row cannot tell you, and the pane says which:

- **`city_wide` is not stored.** An alert with no locations is genuinely ambiguous, so both
  branches are stated: the city-wide audience is shown, flagged *if it was city-wide*, next to
  the note that the other branch notified nobody at all.
- **`bus_lines` is not stored either.** A `vt` route alert is narrowed further to subscribers of
  the affected lines, so for that category the answer is an upper bound.

Users who matched but have the category turned off get their own list — matched and muted is a
different fact from never matched, and only the first one says the targeting worked.

The lists page rather than truncate. A city-wide alert's audience is the entire user base, so a
list shows 50 at a time behind **show 50 more** / **show all**, with a filter over email, region,
street and how the user got in for finding one person among thousands. The heading always states
the whole count, never the part on screen. Above 2,000 users the server stops sending rows —
40,000 of them is a megabyte per alert you arrow past — and the line under the list says how many
were left out; the counts stay exact either way.

When every location resolves to an empty audience the pane says so in as many words, because
the count above it can still be non-zero: `receives_all_alerts` accounts get every alert
regardless of location, and a "2 of 4" that is entirely debug accounts reads like success.

## Issues — the same defect in forty alerts

Most findings are not about one alert. Name the defect once as an **issue** — a title, a kind
(`inaccurate` or `not implemented`), the reasons it implies, and a detail paragraph — and then
stamp it on every alert it appears in. The report groups by issue, so one section names the
problem and lists its alerts, instead of the same complaint being retyped in forty notes.

Three ways to stamp:

- **<kbd>s</kbd>** applies the issue selected on the left (the radio button) to the current
  alert and moves on. This is the fast path: select the issue once, then walk the list.
- **Clicking a chip** in the verdict panel attaches or detaches it for the current alert.
- **"stamp all"** applies it to *every alert matching the current filter* in one call. Search
  for `Аспарухово`, stamp, done. Unjudged alerts take the issue's kind and reasons; alerts you
  already judged keep their verdict and gain the issue; anything you marked **accurate** is left
  alone, and the count of those comes back in the message.

**New issue from this alert** starts one prefilled with what you've already selected — the
natural move the second time you write the same note. A saved issue becomes the selected one,
ready for <kbd>s</kbd>.

Deleting an issue unstamps it everywhere; the judgments keep their verdict, reasons and note.

## The review loop

The point is getting through a few hundred alerts, so nothing needs the mouse:

| Key | |
|---|---|
| <kbd>j</kbd> / <kbd>k</kbd>, <kbd>↓</kbd> / <kbd>↑</kbd> | next / previous alert |
| <kbd>y</kbd> <kbd>n</kbd> <kbd>m</kbd> | the three verdicts (<kbd>y</kbd> saves and advances) |
| <kbd>1</kbd>–<kbd>8</kbd> | toggle a reason (also flips the verdict to inaccurate) |
| <kbd>s</kbd> | stamp the selected issue and advance |
| <kbd>i</kbd> | important |
| <kbd>g</kbd> | show or hide the map |
| <kbd>Enter</kbd> | save and advance (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> from the note field) |
| <kbd>u</kbd> | unreview — drops the judgment |
| <kbd>/</kbd> | jump to search, <kbd>Esc</kbd> back out |

Set the status filter to **unreviewed** and each save drops the alert out of the list, sliding
the next one into its place. That is the intended way to work through a backlog.

## The three files

`judgments.json` — a flat `{alert_id: judgment}` map, sorted keys, rewritten atomically on every
verdict. `issues.json` is the same shape for the issue library, and `settings.json` holds the
cutoff date and nothing else. All gitignored: they are one reviewer's opinions and scope, not
repo data, and the reports are the shareable artefact.

```json
{
  "b1e6…": {
    "category": "vik",
    "important": true,
    "issues": ["rayon-zakachen-na-edna-ulitsa"],
    "judged_at": "2026-07-27T17:49:04Z",
    "note": "only this alert's specifics belong here",
    "reasons": ["wrong_coordinates"],
    "title": "Прекъсване на водоподаването",
    "verdict": "inaccurate"
  }
}
```

`issues` and `important` are written only when set, so an entry from an earlier session keeps
its exact shape and the common case stays short. `title` and `category` are a snapshot so the
file reads as something on its own and a report can still name an alert that has since aged out
of the dataset. Judgments for alerts outside the loaded dataset — or behind the cutoff — are
kept, not pruned, and the report says how many there are.

## What the tool can and cannot tell you

**Severity is not the LLM's.** It comes from a fixed category map in `core/alert-service.ts`
(`vik`/`epro`/`heating` → `warning`, `vt` → `info`). Flagging *wrong severity* is really saying
the category is wrong, or that the map is; no prompt change will move it.

**Title and content are not the LLM's either.** They are the scraped page text, passed straight
through. *Truncated or garbled content* is a scraper finding — look at the source in
`ingestion/sources/`, not at the prompt. What the model actually produced is
`locations_json`, `start_time`, `end_time`, `windows_json` (and `city_wide`, see below).

**`city_wide` is not stored.** It decides targeting at ingest time and is then gone, so an alert
with no locations is ambiguous here: either the model correctly said city-wide, or it produced
nothing and the alert was stored without notifying anyone (SPEC §1.5, decision 2). The tool
shows the row, not the parse — the audience pane states both branches rather than picking one,
and if you need to tell them apart, check `wrangler tail` output around that alert's
`created_on_utc`.

**A `locations_json` that won't parse is shown as an error rather than as no locations**, since
that is a distinct failure: `getRecentAlerts` degrades such an alert to `[]` for the feed, so the
app shows it with no map pins at all.

**Times are two different kinds of value.** `start_time` / `end_time` are local wall-clock ISO
strings with no offset and are reformatted textually — parsing them as instants would shift
every window by your machine's offset. `created_on_utc` really is an instant and is converted to
local time. Both are shown next to their raw value so you can see what is stored.

**`start_time` / `end_time` are only the envelope.** When `windows_json` is set (migration 0012)
it is what the alert actually means, and the envelope is just its outer bound: a `Windows` row
appears in the detail pane rendering `30.07–31.07, 08:30 – 17:00 daily`. Judge the alert on
that row when it is there — an envelope of 30.07 08:30 → 31.07 17:00 looks like a 55-hour outage
and is not one. `windows_json` is NULL for every alert whose envelope does say everything: one
window on one day.

## Why the loopback guards

Same trust model as `tools/push-tester` and `tools/osm-seed-builder`: the Host header is pinned
to loopback and every call carries the printed token. The queries are read-only, but "read-only"
still means this process can pull the alerts table — and, since the audience pane, the users
table with its email addresses — out of the deployed database on request. No other page in your
browser gets to reach it, and the emails are shown in the pane but never written to
`judgments.json` or to a report.

The server itself makes no outbound request but `wrangler d1 execute`. The page fetches map
tiles; nothing else leaves the machine, and no alert text ever does.
