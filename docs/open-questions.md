# Open questions

What is undecided, unmeasured or blocked, as of the last working session
(31.08.2026). Release tasks (Play Store, signing, email) are in
[todo.md](todo.md). This page covers what needs a measurement or a decision
first. When one is answered, move the answer to
[design-decisions.md](design-decisions.md) or [findings.md](findings.md) and
delete it here.

## Needs a measurement

| Question | Why it matters | How to answer it |
|---|---|---|
| **Is accuracy still at 13% inaccurate?** | Nothing has been reviewed since the 10.08 accuracy pass shipped | Run `tools/alert-review` over alerts after 10.08 17:20 UTC and re-measure the structural-reach table ([accuracy.md](accuracy.md)) |
| **Are Workers AI timeouts temporary or the new normal?** (F20) | Each timeout costs up to 30 s, and they push ticks past the deadline, which drops sources | A week of tick logs, from `wrangler tail` or a log sink. The answer decides between a smaller model, fewer attempts, or one message per tick |
| **Do the four newest prompt rules hold?** (F16) | A12, A13, A14 and the invention rule are unvalidated against the corpus. This is the largest unmeasured area | `spikes/ai-eval` with Workers AI credentials. Add `5b048900` and `40b78a66` to the corpus first |
| **Does the model drop places from long lists?** | The one failure class with no deterministic fix (`с. Припек` out of five villages) | If fresh alerts show it, add a count check: ask how many places the model found, and re-prompt on a mismatch |
| **Worker startup time** | It was 27 ms of 400 ms, before the seed grew by about 90 regions | Read it off the next `wrangler deploy` |
| **Has any source changed?** | Both source-side outages looked healthy in the logs | Compare the app with each source website |

## Needs a product decision

| Question | Context |
|---|---|
| **Listed streets only, or the whole village?** ([accuracy.md §5.2](accuracy.md#52-do-we-notify-only-the-listed-streets-or-the-whole-settlement)) | Today, a village alert naming 6 of the 42 seeded streets notifies those streets plus residents with no street. A resident whose street was matched to the wrong row hears nothing |
| **Should a street-only "в района на" alert widen to a district?** | There is no street → district link. Nearest district centroid would be a crude Voronoi split, so this needs real users to measure against first ([todo.md](todo.md) §6) |
| **Enforce email verification at login?** | Only once mail is actually delivered ([todo.md](todo.md) §3) |
| **Who pings `/api/health`?** | The heartbeat exists, but no external uptime check calls it. Every incident so far was found by a person looking |

## Blocked on data

- **Nine `м-т` localities** exist in neither OSM nor Nominatim
  ([findings.md](findings.md#places-that-do-not-exist-in-osm-or-nominatim)).
  They need the cadastre, or local knowledge added to OSM.
- **`Гръцката махала` under Бяла**: OSM maps no districts for Бяла, so there
  is no row for an alias to point at. When the model drops the settlement,
  this name still resolves to Varna's district of the same name.

## Blocked on access

- **Historical logs**: the wrangler token lacks the observability scope.
  Grant it before the next incident, not during it ([todo.md](todo.md) §6).
- **CI deploys**: whether the `CLOUDFLARE_API_TOKEN` secret exists has never
  been checked, and nothing deploys from CI until `main` is merged forward.

## Deferred on purpose

Each has a trigger, listed in [todo.md](todo.md) §6: the in-memory trigram
index, Workers Paid, AI Gateway, paid map tiles, and changes to polling
intervals. None is worth doing before its trigger fires.
