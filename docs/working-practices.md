# Working practices

How work is done on CityShield, and the mistake behind each habit. The code
conventions (SQL placement, comment style, commit format) are in
[AGENTS.md](../AGENTS.md#conventions). This page covers the method.

## Measure before acting

- **Measure before any fix that depends on a number.** The plan after the
  first review said so in as many words: re-run the review, and do not act on
  anything until the numbers exist.
- **Re-measure the suspects every time.** The 10 ms cap caught the matcher on
  30.07 and cheerio on 28.08. Both are now provably innocent, and the next
  culprit will be something else.
- **Use an instrument that works.** `performance.now()` inside workerd returns
  plausible zeros. Measure in Node, one fresh process per data point, and
  confirm with `wrangler tail` ([runbook.md](runbook.md#measure-a-cpu-burst)).
- **Guard regressions with bytes or work, not milliseconds.** Timings vary by
  runtime. A byte budget on what reaches a parser does not.

## Sweep a range, never one value

On 30.07.2026 the polygon extension was cut from 200 m to 25 m on the strength
of a measurement taken **before** the clip-window fix. With a street missing,
a long extension really did sweep a stub into empty space. With the clip
fixed it only closed corners, and 25 m destroyed three real blocks (Левски
18.7 ha, Русе 30.4 ha, Владислав Варненчик 17.4 ha) while fixing nothing. The
mistake was caught by trying 200 m in `tools/polygon-tester`.

- When tuning a threshold or radius, sweep it across a range and record the
  **range** that works ([design-decisions.md](design-decisions.md#thresholds-are-recorded-as-ranges)).
  A real block's area moves under 2% across 50–500 m of extension. A
  fabricated one grows with the stub.
- **A measurement taken before a related fix is not evidence after it.** In a
  pipeline whose stages interact, re-run the whole sweep after changing any
  shared stage.

## Retract claims everywhere

A conclusion that turns out wrong is usually repeated somewhere else by then:
a docblock, a README, a tool preset, a doc. When a claim is retracted,
**grep for it** and fix every copy. Examples that needed this: the 25 m
extension, "Левски's streets enclose nothing", the meaning of `admin_level 8`,
and the geocode-cache purge step.

## Prefer the fix the evidence names

- A wrong row is worse than a missing one. Delete a row you cannot trust,
  rather than keep it because it is "probably mostly right".
- When a seeded name looks wrong, first ask whether OSM spells it that way.
  If it does, leave the name and fix whatever compares it.
- When a real name fails to match, add an alias row. Do not loosen the
  threshold.
- Do not invent data. If no authoritative source has a place, make the miss
  visible and leave it at that.
- When a model output is wrong, add a deterministic guard tied to the message
  it came from, and cite that message's hash in the guard's test. The prompt
  is only a second line of defence.

## Make failures visible

Every reach failure used to end in the same silence. The pattern now:

- **Record why** a value is what it is (`polygon_failed`, `coords_source`,
  `region_wide`). A fallback that leaves no trace looks the same as success.
- **Alarms belong somewhere the failure cannot destroy.** A CPU kill discards
  logs, so the heartbeat is a D1 row.
- **Log the dangerous outcome loudly**, for example `notified NOBODY` and
  `GIVING UP on id=…`. A deliberate skip must never be silent.
- **Monitors must not break the thing they monitor.** The stall check swallows
  its own errors.

## Tests

- One spec file per module in `backend/test/`. Fixtures are real captured
  pages and real Overpass responses.
- **Cover the bug, not just the fix.** Name the alert the rule came from
  (`40b78a66`, `d29913c5`, …).
- When a rewrite must keep behaviour, keep the old implementation in the
  tests as an oracle. That is how two silent HTMLRewriter differences were
  caught.

## Environments

- The remote D1 is a test bed until release. Destructive resets there are
  routine and need no extra ceremony, but preserve the test users'
  placements and leave `crawl_state` alone ([runbook.md](runbook.md)).
- "Local" describes where the code runs, not where the side effects go:
  local runs spend real AI neurons and send real pushes.
- `main` is the only long-lived branch, and pushing it deploys. Each piece of
  work gets its own branch off `main`, and merging back waits for the owner's
  go-ahead. This rule dates from 21.10.2026: `main` had gone stale for months
  while all real work lived on `cloudflare-migration`, which was then
  fast-forwarded into `main` and deleted.

## Documentation

- **A behaviour change updates [specification.md](specification.md) in the
  same commit.** Code comments cite it by section, so keep its numbering
  stable.
- New incidents, decisions and findings go in this folder. See the index in
  [README.md](README.md#keeping-these-current).
