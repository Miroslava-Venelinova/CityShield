# Design decisions

The choices that shape CityShield, why each was made, and what each one rules
out. Most of them exist because the obvious version broke something. Read the
relevant entry before "simplifying" code that looks over-built.

Each entry is short. The full reasoning, with numbers, is in the
[specification](specification.md) section named on its **Ref** line. A decision listed
here is settled. Reopening one needs new evidence, not a new opinion.

---

## Platform

### One Worker on Cloudflare's free plan
The Python ingester and the ASP.NET API merged into one TypeScript Worker.
That removed an HTTP hop, halved the code to maintain, and gave both halves
one database, one geocoding cache and one push client. **Rejected:** Google
Cloud Run with Neon Postgres, and keeping two services. **Ref:** §4.

### Design against the longest burst, not the total
The 10 ms CPU cap bounds **one uninterrupted synchronous stretch**. Ticks
spend 53–94 ms of CPU and complete with `ok`. Expensive work is therefore
split across awaits, or moved to module scope, where it is charged to the
separate 400 ms startup budget. **Rejected:** Workers Paid ($5/mo) as the fix
for a burst. More total CPU does not raise a burst ceiling, and both outages
so far were avoidable work. Pay only when one irreducible operation exceeds
10 ms. **Ref:** §1.1, §1.9.

### Matcher data is built at module scope, from the bundled seed
Parsed kinds and trigrams for every seeded name are computed at startup.
**Rejected:** memoising per isolate (a cron tick gets a cold isolate, so
"once per isolate" meant every tick, and that caused the 30.07 outage); an
in-memory trigram index (it would still be built per isolate); trigrams
stored in D1 (about 10× the payload, a parse per row, and a query per lookup
against the 50-queries-per-invocation limit). D1 still owns the rows. A name
missing from the bundle is computed on demand, so drift costs speed, never
accuracy. **Ref:** §1.3.

### No cheerio in the Worker
Listing pages are read with string scans. The three parsers that need
structure use `HTMLRewriter`, which streams and so never forms one long
burst. cheerio remains a devDependency, where the tests use it as a
reference oracle. **Rejected:** slicing the input before `cheerio.load` (60%
fewer bytes bought only about 20%, because the cost is a fixed cold floor),
and warming cheerio at module scope (measured, unreliable). **Ref:** §1.7.

### Few dependencies
At runtime the Worker uses `hono`, `zod`, `jsts` and nothing else. Crypto
uses WebCrypto. There is no ORM, and every SQL statement lives in
`db/queries.ts`. A new dependency needs a reason, and CI enforces the 3 MB
gzipped bundle limit. **Ref:** §1.1.

### The scheduled handler awaits its job
It does not hand the job to `ctx.waitUntil`, so the reported duration and
`cpuTime` describe the real work. That makes `wrangler tail` trustworthy.
**Ref:** §1.1, §3.8.

### The ingest heartbeat lives in D1, not in the logs
An `exceededCpu` kill discards the invocation's logs, so an alarm written
with `console.error` dies with the failure it reports. The tick writes
`started_at` before parsing and `completed_at` at the end. **Ref:** §3.8.

### PBKDF2 at 100,000 iterations
That is workerd's cap. BCrypt cannot run inside a 10 ms burst. The hash
format names its iteration count, so a later raise can rehash lazily.
**Ref:** §1.4.

---

## Ingestion

### Cursor semantics are load-bearing
Process oldest-first and advance only past successes, so a failed message
blocks the newer ones and a retry cannot re-notify. **Persist after each
success, not once per batch.** A trailing write never runs when the tick is
killed, and the already-pushed message is then re-pushed on every tick (the
23.07 incident). **Ref:** §1.7.

### Give up on a message after 5 pre-store failures
`MAX_PRE_STORE_ATTEMPTS = 5` is about 75 minutes of retries. After that, the
cursor moves past the message, which is then **deliberately not
delivered**. The alternative is one bad message blocking every newer message
from its source until a person intervenes (20 h on 30.07, 21 h on 28.08).
The attempt is claimed **before** the work, because a CPU kill never reaches
a counter written after it. Every skip is loud: a log line, a row in
`ingest_attempts`, and an entry on `/api/health`. **Ref:** §1.7, §3.8.

### A fresh deploy does not replay history
With an empty `crawl_state`, each source starts from what is currently
published, without processing it. Otherwise a new deploy would push-notify
every message visible on every source. **Ref:** §1.7.

### ViK is crawled by probing ids, not by following the listing
vikvarna's listing exists only filtered by region, and the URL used to be
the city alone, so Devnya, Provadia, Dolni Chiflik and Dalgopol were never
seen. Message pages are unfiltered. Probing also picks up planned repairs.
That widening was intended: a planned shut-off leaves a street just as dry.
**Ref:** §1.7.

### Deterministic guards decide, the prompt only helps
The model is nondeterministic, so every rule that matters (A1–A15) is
enforced in `normalize.ts` from the source text and the seeded rows. The
prompt carries the same rules only as a second line of defence. Prompts are
copied character for character. Do not "improve" them during maintenance.
A prompt change is validated with `spikes/ai-eval`: 3 runs × 3 models,
compared case by case. **Ref:** §1.7, §1.8.

### Times are a schedule, not a start/end pair
`От 30.07 до 31.07 В периода 8:30 до 17:00` means 08:30–17:00 each day.
Stored as a flat pair it read as 55 hours. The model returns a schedule.
`start_time`/`end_time` is the envelope, and `windows_json` holds the detail
when the envelope loses some. The model is never asked for both, because it
would contradict itself. **Ref:** §1.7.

### Workers AI model and limits
`@cf/qwen/qwen3-30b-a3b-fp8` was the only candidate that supports JSON-schema
mode with nullable unions, and it is also the cheapest. It is a reasoning
model, so it needs `max_tokens: 10000`. Each run has a 30 s timeout.
**Do not simply raise the timeout:** that starves the other sources within
the tick deadline. **Ref:** §1.8,
[RESULTS.md](../backend/spikes/RESULTS.md).

### A 5-minute tick budget, threaded through every source
Only CPU is capped, not wall clock. The budget exists so a tick finishes
well inside the 15-minute cadence, and two ticks never write one cursor at
once. **Ref:** §1.7.

### A polygon is an enhancement
Building is skipped when less than 1 s of budget remain, and any exception
during building yields a pin instead. A polygon failure never fails a
message. **Ref:** §1.7, §1.9.

### Street geometry is seeded, never fetched at ingest time
The polygon builder reads `street_ways` from D1 (migration 0020) and makes no
external call. Asking the public Overpass API mid-tick made a shared free
service the availability of the feature: 1 of 32 polygons built in 09.2026 and
0 of 15 in 10.2026, every other alert falling back to a pin. The mirrors
measured 21–33 s against a 15 s budget, and self-hosting needs a machine on
around the clock. Street geometry changes on the scale of years, so the
province sweep stores it with the street names. Do not reintroduce a live
fetch as a "fallback": a stored street without ways is a sweep gap, and the
fix is a re-sweep ([runbook](runbook.md#refresh-street-geometry)).
**Ref:** §1.9, [findings.md](findings.md#stored-geometry-reproduces-the-live-query).

---

## Places and matching

### Names are the key, not OSM ids
One street is many `way` elements, re-drawing it in OSM mints new ids, and
alert text gives names. The seed is keyed by name, and so are aliases and
street settlements, because autoincrement ids differ between the local and
remote databases. **Ref:** §1.2.

### Seed names are stored exactly as OSM has them
The stored name is what the sweep files the street's geometry under (it used
to go into the Overpass regex). Rewriting
`ул.Никола Вапцаров` to `ул. Никола Вапцаров` would match zero ways.
`parseName` already reads glued prefixes. **Rejected:** "normalising" the
seed (accuracy F4's proposed edit, which was not made). The one legitimate
removal is a name whose parsed core is empty, such as `Площад`. **Ref:**
[accuracy.md §1.3](accuracy.md#13-street-names-carry-inconsistent-kind-prefixes--and-that-was-never-the-bug).

### A street belongs to a settlement, and a district name is unique only inside its settlement
`streets.region_id` is a `NOT NULL` foreign key: 52% of village street names
also exist in Varna. Region uniqueness is
`(region_name, COALESCE(settlement_id, 0))`. The COALESCE matters because
SQLite treats NULLs as distinct in a UNIQUE index, so without it "Варна"
could be seeded twice. **Rejected:** renaming colliding districts with a
parenthesised settlement, a form no source writes. **Ref:** §1.2.

### Match on the name's core, with the kind as a filter
Comparing whole names let the prefix decide: bare `Аспарухово` scored 1.000
on a village 55 km away. `кв.`, `ж.к.`, `м-т` and `с.о.` share one class,
because the sources mix them up. `к.к.` stays separate, because they don't.
The threshold is 0.40: every wanted match scores ≥ 0.417 and every false
positive ≤ 0.357. **Ref:** §1.3.

### A name that should match but does not gets an alias, not a lower threshold
An alias resolves to the **same** `region_id`, which keeps the district's
users together. A lower threshold lets in false positives everywhere.
**Ref:** §1.3, [todo.md](todo.md) §2.

### OSM spelling variants are curated, not learned
`Януш Хуняди` and `Янош Хунияди` (one boulevard) score 0.389, below
`Младост 1` vs `Младост 2` at 0.667. No threshold separates a
transliteration from two different numbered places. **Ref:** §1.9,
[findings.md](findings.md#one-street-two-osm-spellings).

### An unresolvable settlement scopes to nothing, never to everything
This holds at every call site. Falling back to an unscoped match is exactly
how a village street's outage notified the like-named Varna street.
**Ref:** §1.5.

### A settlement scope is a preference, not a filter
`matchRegion` retries without the scope when the scoped match finds nothing,
because most regions still have no parent link. A scope can move a match to
a better row but can never remove one — except in targeting outside the city,
where a retry that escapes into another settlement is discarded for the stated
village or town (29.10.2026). **Ref:** §1.3.

### No invented coordinates
Names that neither OSM nor Nominatim holds are not seeded with guessed
points. Instead, `coords_source` marks the settlement-centre fallback, so a
miss is visible. **Ref:** §1.5,
[findings.md](findings.md#places-that-do-not-exist-in-osm-or-nominatim).

### A failed Nominatim lookup never clears a user's targeting
`ReverseAddress.ok` separates "the lookup failed" from "this point matches
nothing". Only a completed lookup may clear `region_id`/`street_id`. Stale
beats blank. **Ref:** §1.5.

### Keep Nominatim, and disclose it
Nominatim receives a user's precise coordinates and offers no DPA. The
choice is documented: explicit consent, no user identifier on the request,
which comes from Cloudflare's IP. **Rejected (for now):** self-hosting, or a
commercial EU geocoder. **Ref:** §2.2.

### The geocode cache has no correctness role
`plausible()` checks the value `geocode()` returns, cached or fresh. A
"poisoned" cache row therefore needs no purge after a rule change. This stops
being true only if a guard moves inside `geocode()`'s network branch.

---

## Targeting

### A failed extraction notifies nobody
This was a product ruling on 10.08.2026. A location that resolves to the bare
**Варна** row, with no area and no matched street, reaches nobody and is
logged. A real whole-city outage is published in words and handled by
`city_wide`, so a bare "Варна" is a district that got lost. **Towns and
villages are still audiences by name alone**: "абонатите на гр. Бяла" means
the whole town. Do not "fix" a bare-Варна alert by widening it. Fix the
extraction, or add the district or alias. **Ref:** §1.5,
[accuracy.md §5.1](accuracy.md#51-when-does-an-unmatched-area-mean-notify-the-whole-settlement).

### No locations and `city_wide === false` means store only, never broadcast
The parser said "not city-wide" and produced no places. That is almost
certainly a misparse of a street-level outage. **Ref:** §1.5.

### City-wide means within 15 km of Varna, and unplaced users stay in
Every settlement of община Варна lies within 12.2 km. The next municipality
starts at 16.5 km. A user is dropped only when their position is known
**and** lies past the radius. **Ref:** §1.5.

### Settlement-wide uses containment, not a radius
A settlement with seeded districts reaches every user under the settlement
or any of its districts, plus users with a position but no region within
9 km. A village keeps the plain `region_id = ?` query. **Ref:** §1.5.

### A hedge widens to the village, an exact street does not

Decided by the owner on 29.10.2026. "… на ул. X" / "улиците: X, Y" notifies only
the people on those streets (plus street-less residents of the place, who cannot
be ruled out). "в района на улиците X, Y" (guard A6) notifies the whole named
district, or with no district the whole village or town. The bare city is the
exception: a hedged street list under Варна stays street-only, because the only
thing to widen to would be every district in the city (spec §1.5, §1.7).

### Alerts carry the source text word for word

Decided by the owner on 29.10.2026: the push and the in-app alert publish the
source's title and text verbatim, with the operator named and a link back,
rather than a summary built from the extracted fields. The legal position this
takes is in [legal.md](legal.md) §3.2; it rests on asking each operator for
permission ([todo.md](todo.md) §8.3), and the fallback if one says no is still
open ([open-questions.md](open-questions.md)).

### Only a hedged alert is ever suppressed as a duplicate
It is suppressed only against an alert **already delivered**. A confirmed
outage can never be silenced by a "възможни са смущения" restatement,
whichever order the two arrive in. **Ref:** §1.6.

### Store before notifying
A failed store is safe to retry, because no push has gone out yet. A failed
push holds the cursor for up to 3 attempts. `source_ref` makes the re-store a
no-op. **Ref:** §1.5, §1.7.

### Targeting stays in our code; OneSignal gets only user ids
Polygon ray-casting and trigram matching cannot be expressed as OneSignal
segments, and the provider never sees a location. OneSignal replaced direct
FCM because FCM has no multicast endpoint: one subrequest per device ran
into the 50-subrequest ceiling. **Ref:** §1.6.

### A polygon gets a 30 m tolerance and a fallback
A ring edge sits half a road's width from the OSM centreline, while the
point tested is a phone's GPS fix. A built ring that matches nobody falls
back to the street or region audience. **Ref:** §1.5.

---

## Polygon geometry

### Thresholds are recorded as ranges
Any minimum area in 5,000–15,000 m² separates real blocks from degenerate
ones, and the code uses 10,000. Any minimum vertex count in 5–22 works, and
the code uses 8. The extension is **200 m**: a real block's area moves under
2% between 50 and 500 m. **Rejected:** 25 m, which destroyed three real
blocks (see [working-practices.md](working-practices.md)). **Ref:** §1.9.

### The clip window is correctness, not CPU
It keeps a same-named street 25 km away out of the geometry. It stays even
on a paid plan. **Ref:** §1.9.

---

## Accounts and release

### Email goes through OneSignal, once a domain exists
OneSignal is already a processor, so the privacy policy, the DPA and Play
Data Safety only need amending. Sending as `@gmail.com` through any third
party fails SPF/DKIM alignment, so a domain is the precondition.
**Fallback:** Resend, if OneSignal's email channel fails any of the three
checks in [todo.md](todo.md) §3. **Ref:** §1.13.

### Email verification is soft
Login works unverified, because nothing can be delivered yet. Revisit once
mail is real, or if signup spam appears. **Ref:** §1.13.

### Two account-existence disclosures are kept on purpose
`/register` answers 409 on a duplicate. `/login` rejects an unknown address
without running PBKDF2. Hiding the second would mean hashing a dummy
password, which hands attackers 100,000 rounds of our CPU budget per junk
login. **Ref:** §1.4.

### The remote D1 is a test bed until release
The app is unreleased, so wiping and reseeding the remote database is
routine. This ends at release. See [runbook.md](runbook.md).
