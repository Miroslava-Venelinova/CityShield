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
   locations_json, created_on_utc`. `--csv` loads one at startup; the same picker reloads from
   either database without restarting. D1 reads are capped at 2000 rows, newest first, and the
   UI says so when the cap bites.
2. **List and filters** — free text over title and content, plus category, severity, review
   status, issue, important-only, created-date range, and inaccuracy reason.
3. **Detail** — content as scrollable text, the window in both `24.07.2026 09:00` and its raw
   stored form, and `locations_json` as a readable list of `name → lat, lng` (each pin links out
   to OpenStreetMap, which is how you actually check a coordinate) with the pretty-printed JSON
   folded underneath.
4. **Verdict** — one of four, below. Written to `judgments.json` on every judgment, not at the
   end, so closing the tab never costs you the tail of a session.
5. **Report** — `reports/review-<timestamp>.md` or `.json`, opened in the file manager as soon
   as it is written: issues with their alerts, the important ones first, reason counts, and
   category/severity breakdowns.

## The four verdicts

| | | |
|---|---|---|
| **Accurate** | <kbd>y</kbd> | The parse matches the source message. Saves and moves on. |
| **Inaccurate** | <kbd>n</kbd> | Something is wrong. Needs at least one reason from the taxonomy. |
| **Not implemented yet** | <kbd>m</kbd> | The parse isn't *wrong*, the thing simply isn't built — the source says something nothing in the pipeline looks for. Reasons are optional here, because the taxonomy is about wrongness. |
| **Old — excluded** | <kbd>o</kbd> | From a superseded pipeline and not worth arguing about. Counted once in the report and then left out of every breakdown, so a backlog of ancient rows can't skew the percentages. |

`Accurate` and `Old` carry no reasons and no issues — they'd be dangling claims about an alert
nobody is going to fix — so setting either drops both.

<kbd>i</kbd> marks an alert **important**, meaning fix this one first. It shows as `★` in the
list, has its own filter, and gets its own section at the top of the report. It persists
immediately if the alert is already judgeable, so a star never depends on remembering to press
<kbd>Enter</kbd> afterwards.

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
  already judged keep their verdict and gain the issue; anything you marked **accurate** or
  **old** is left alone, and the count of those comes back in the message.

**New issue from this alert** starts one prefilled with what you've already selected — the
natural move the second time you write the same note. A saved issue becomes the selected one,
ready for <kbd>s</kbd>.

Deleting an issue unstamps it everywhere; the judgments keep their verdict, reasons and note.

## The review loop

The point is getting through a few hundred alerts, so nothing needs the mouse:

| Key | |
|---|---|
| <kbd>j</kbd> / <kbd>k</kbd>, <kbd>↓</kbd> / <kbd>↑</kbd> | next / previous alert |
| <kbd>y</kbd> <kbd>n</kbd> <kbd>m</kbd> <kbd>o</kbd> | the four verdicts (<kbd>y</kbd> and <kbd>o</kbd> save and advance) |
| <kbd>1</kbd>–<kbd>8</kbd> | toggle a reason (also flips the verdict to inaccurate) |
| <kbd>s</kbd> | stamp the selected issue and advance |
| <kbd>i</kbd> | important |
| <kbd>Enter</kbd> | save and advance (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> from the note field) |
| <kbd>u</kbd> | unreview — drops the judgment |
| <kbd>/</kbd> | jump to search, <kbd>Esc</kbd> back out |

Set the status filter to **unreviewed** and each save drops the alert out of the list, sliding
the next one into its place. That is the intended way to work through a backlog.

## The two files

`judgments.json` — a flat `{alert_id: judgment}` map, sorted keys, rewritten atomically on every
verdict. `issues.json` is the same shape for the issue library. Both gitignored: they are one
reviewer's opinions, not repo data, and the reports are the shareable artefact.

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
of the dataset. Judgments for alerts outside the loaded dataset are kept, not pruned, and the
report says how many there are.

## What the tool can and cannot tell you

**Severity is not the LLM's.** It comes from a fixed category map in `core/alert-service.ts`
(`vik`/`epro`/`heating` → `warning`, `vt` → `info`). Flagging *wrong severity* is really saying
the category is wrong, or that the map is; no prompt change will move it.

**Title and content are not the LLM's either.** They are the scraped page text, passed straight
through. *Truncated or garbled content* is a scraper finding — look at the source in
`ingestion/sources/`, not at the prompt. What the model actually produced is
`locations_json`, `start_time`, `end_time` (and `city_wide`, see below).

**`city_wide` is not stored.** It decides targeting at ingest time and is then gone, so an alert
with no locations is ambiguous here: either the model correctly said city-wide, or it produced
nothing and the alert was stored without notifying anyone (SPEC §1.5, decision 2). The tool
shows the row, not the parse — if you need to tell them apart, check `wrangler tail` output
around that alert's `created_on_utc`.

**A `locations_json` that won't parse is shown as an error rather than as no locations**, since
that is a distinct failure: `getRecentAlerts` degrades such an alert to `[]` for the feed, so the
app shows it with no map pins at all.

**Times are two different kinds of value.** `start_time` / `end_time` are local wall-clock ISO
strings with no offset and are reformatted textually — parsing them as instants would shift
every window by your machine's offset. `created_on_utc` really is an instant and is converted to
local time. Both are shown next to their raw value so you can see what is stored.

## Why the loopback guards

Same trust model as `tools/push-tester` and `tools/osm-seed-builder`: the Host header is pinned
to loopback and every call carries the printed token. The queries are read-only, but "read-only"
still means this process can pull the production alerts table on request, so no other page in
your browser gets to reach it.
