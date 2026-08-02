# Deployments

What was live when, so a run of `tools/alert-review` can be read against the code
and reference data that actually produced it. An accuracy judgement is only worth
anything if you know which build made the call.

Times are UTC. `alerts` is cleared on a reference-data reset, so the oldest row in
that table is also the start of the current evaluation window.

---

## 2026-08-02 13:00 UTC — three-level locations, districts by settlement

**Commit** `2f478c8` on `cloudflare-migration` · **Worker version**
`0752e410-777d-4377-8994-f84dfc3991ea`

**The evaluation window opens here.** `alerts` was emptied, so every row now in
it was ingested by this build. `crawl_state` was deliberately *not* reset, so
nothing was re-ingested or re-notified — the window starts with the next crawl
rather than by replaying history.

### What changed

- **Locations became three levels** — `settlement` / `area` / `streets` — where
  the model previously had two and had to put a city district and a village on
  the same one. The wire keeps `location_name` and `sublocations` as derived
  fields, so no app release was needed.
- **Migrations 0015–0017** applied remotely (none had been). Streets now belong
  to a settlement, a district names the settlement it sits in, and a district
  name may repeat across settlements.
- **Reference data replaced wholesale** by a province sweep: 260 regions (89 of
  them districts) and 2,974 streets across 63 settlements, up from 254 regions
  and 1,333 Varna-only streets. Villages have streets for the first time.

### What to watch in the review tool

The claims this deploy makes, in the order they are worth checking:

1. **Village streets resolve locally.** Before, every village street fell through
   to Nominatim and could match a like-named Varna street 25 km away. A
   Долни чифлик or Аврен outage should now pin and target inside its own village.
2. **A district no longer swallows its city.** "гр. Варна – кв. Виница, ул. X"
   should produce one location with all three slots filled, not two.
3. **Streets after a district stay with it.** This was A7's guess from list order;
   the model now states it.
4. **A settlement is never invented.** "кв. Чайка" with no city named must leave
   `settlement` null rather than assuming Варна.
5. **Two districts, one name.** Варна and Белослав both have a `Цветен квартал`,
   17.5 km apart. A Белослав message must reach the Белослав audience.

### Known-unfixed at this point

- The polygon builder still scopes to `area["name"="Варна"]`, which matches the
  *province* and can pull in same-named streets ~25 km out. Deliberately out of
  scope; it needs `admin_level` pinning plus an `around:` fallback.
- The AI eval (`backend/spikes/ai-eval`) has never been run — no Workers AI
  credentials in the dev environment. The prompt and schema changes here are
  therefore unvalidated against the corpus.

### Test accounts at deploy time

All four were re-pointed by name after the reseed (ids are autoincrement and all
changed), and each was checked against its own coordinates first — every one was
already sitting on its nearest seeded street (0.03–0.35 km) and nearest district.

| account | district | street |
|---|---|---|
| test@emulator.com | 4-ти микрорайон | бул. Мария Луиза |
| test@example.com | Център | Братя Миладинови |
| negrebyt@gmail.com | кв. Левски | Проф. Цани Калянджиев |
| miroslavavenelinova4@gmail.com | 4-ти микрорайон | Георги Бенковски |
