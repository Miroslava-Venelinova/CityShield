# Runbook

Step-by-step procedures. Provisioning a fresh environment from nothing is in
[specification §3.3](specification.md#33-provisioning-a-fresh-environment), and the
accounts and credentials are in [todo.md](todo.md) §7. When a step fails, see
[troubleshooting.md](troubleshooting.md).

All commands run from `backend/` unless stated otherwise.

## Before you start: what is real

- **The remote D1 is a test bed, not production.** The app is unreleased, so
  wiping and reseeding it is routine. This stops being true at release.
- **Two things still need care on the remote database:** the few real test
  `users` (their placements are preserved by name across a reseed), and
  `crawl_state`. Clearing `crawl_state` makes every source re-ingest and
  re-notify its whole visible history.
- **Local dev has real side effects.** `wrangler dev` makes real Workers AI
  calls, which spend neurons, and a test push reaches a real phone.
- **`tools/*` can reach production.** Each run prints a tokenized loopback
  URL, and every request must carry that token.

## Deploy

1. `npx wrangler whoami`: this refreshes the OAuth token, which otherwise
   expires and makes `deploy` fail with a misleading message.
2. Run the checks CI runs:
   ```sh
   npm test
   npx tsc -p tsconfig.json && npx tsc -p test/tsconfig.json
   npx wrangler deploy --dry-run      # 3 MB gzipped limit
   ```
3. **Migrations first**, if the change adds any. A Worker deployed ahead of
   its schema fails every alert it handles.
   ```sh
   npx wrangler d1 migrations apply cityshield-db --remote
   npx wrangler d1 migrations list --remote
   ```
4. `npx wrangler deploy`. Note the **Worker Startup Time** it prints: it was
   27 ms of 400 ms, and the seed has grown since.
5. Verify on a live tick: `npx wrangler tail cityshield --format=json`. Look
   for `event.cron` matching, a non-zero `cpuTime`, and `outcome: ok`. Then
   check `GET /api/health`.
6. If the schedule looks wrong, run `npx wrangler triggers deploy` and tail
   again.

CI deploys only from `main`, and `main` still holds the old stack, so for now
deploys are manual ([todo.md](todo.md) §1).

## Reseed a database

Use this after changing `seeds/*.json`.

| Command | Deletes rows the seed no longer has? |
|---|---|
| `npm run db:local` / `db:remote` | **No.** Upserts only (street geometry is replaced wholesale either way) |
| `npm run db:reseed:local` / `db:reseed:remote` | **Yes.** Snapshot, wipe, reseed, restore |

The reseed snapshots every user's placement by **(name, parent settlement
name)**, clears regions, streets, aliases, street ways and their id sequences,
applies `seed.sql` and its `seed.ways.<n>.sql` chunks, and re-resolves the
placements against the new ids. All of it runs through `seeds/apply.mjs`, which
stops at the first failing step. The parent
half of the key is what keeps the two Припек apart. `alerts` and
`crawl_state` are not touched.

Afterwards:

```sh
node seeds/verify.mjs                                  # distance invariants
npx wrangler d1 execute cityshield-db --remote --command \
  "select (select count(*) from regions), (select count(*) from streets),
          (select count(*) from street_ways)"
```

The counts must match the JSON and what `generate-seed.mjs` printed (ways:
the "street ways for N streets" figure). A street whose settlement has no
`regions` row inserts nothing and reports nothing, and neither do its ways.
D1's free plan allows 100,000 row writes a day; a full apply rewrites every
way (~5,700 deletes plus as many inserts), so a handful of applies a day is
fine and a loop is not. **Then redeploy.** The matcher's
startup data comes from the bundled seed, so a reseed without a redeploy
moves every lookup onto the slow path.

## Rebuild the seed from OSM

From the repo root: `python tools/osm-seed-builder/app.py`. Use the
self-hosted Overpass, because the public mirrors rate-limit during a sweep.
The province sweep is the single-input path. It works in the tool's own
`output/` directory, and `backend/seeds/` changes only when you press the
merge button. Details are in
[tools/osm-seed-builder/README.md](../tools/osm-seed-builder/README.md).

After a sweep: zero hits on the 15 km distance backstop is the sign of a
healthy run. A hit means something upstream is wrong.

## Refresh street geometry

The polygon builder draws blocks from `street_ways` in D1, never from a live
query ([specification §1.9](specification.md)). It is as fresh as the last
province sweep. Refresh it when OSM has fixed or added a street an alert needs —
the symptom is a polygon failure reading `no stored geometry for: <street>`.

1. Start the self-hosted Overpass (`tools/osm-seed-builder/overpass/overpass.bat
   start`; `refresh` first to re-import the latest Geofabrik extract).
2. Sweep the province in `tools/osm-seed-builder`. The progress shows a street
   ways count beside the streets.
3. Press the merge button. It replaces `backend/seeds/street_ways.json` for every
   settlement the sweep covered.
4. `node seeds/verify.mjs`, then `npm run db:remote` (no reseed needed — the
   ways are replaced wholesale). Nothing to redeploy: the Worker reads the
   table, the geometry is not bundled.
5. Commit `street_ways.json` with the streets it belongs to.

## Check ingest health

```sh
curl -H "X-Api-Key: $INGEST_API_KEY" \
  https://cityshield.cityshield-varna.workers.dev/api/health
```

`status: degraded` means a tick started and never completed (a CPU kill), or
a cursor has not moved in 6 hours. The response also lists every message the
pre-store cap gave up on.

The same checks against D1 directly:

```sql
SELECT * FROM ingest_health;
SELECT source, last_id, updated_at FROM crawl_state;
SELECT * FROM ingest_attempts WHERE skipped_at IS NOT NULL;
SELECT id, push_attempts FROM alerts WHERE notified_at IS NULL;   -- abandoned pushes
```

## Uptime check

`.github/workflows/uptime.yml` calls `/api/health` from GitHub's machines at :07
and :37 past every hour, so nothing local has to be running. A failed run is
the alarm: GitHub emails the user who last changed the workflow's schedule
(check *Settings → Notifications → Actions* on that account: "failed workflows
only", email on). It **fails** when:

- the Worker does not answer, or answers anything but 200 (a 401 *with* the
  key means the repo secret no longer matches the Worker's `INGEST_API_KEY`);
- the `*/15` ingest tick has not **completed** in over 1 hour — at least three
  ticks in a row. The error says which kind: `started_at` still moving is the
  `exceededCpu` signature, both frozen means the cron stopped firing
  ([troubleshooting.md](troubleshooting.md), specification §3.8).

It only **warns** (in the run's summary page) on stalled cursors and on
messages given up on in the last 24 hours. The route's own `status: degraded`
is not a failure: any cursor quiet for 6 hours sets it, and vt and heating are
that quiet most days.

Setup, once: add the Worker's `INGEST_API_KEY` as a repo secret of the same
name. Until then the run checks liveness only (a 401 from the key gate) and
says so in a warning. After rotating the key, update the repo secret too, or
the next run fails with 401. Run it by hand from *Actions → Uptime → Run
workflow*. GitHub disables scheduled workflows in a public repo after 60 days
without a commit; re-enable it from the same page if that happens.

## Restore from an off-site backup

**Within 7 days, use Time Travel instead** — it restores to any minute, in place:
`npx wrangler d1 time-travel restore cityshield-db --timestamp=<ISO time>`.

`.github/workflows/backup.yml` exports the remote D1 every Monday at 02:07 UTC
(`wrangler d1 export --remote`), encrypts it with the `BACKUP_PASSPHRASE` repo
secret (`gpg --symmetric`, AES-256) and keeps it as a workflow artifact for
**30 days**. The repo is public, so the artifact would be downloadable by anyone
signed in to GitHub — the encryption is what keeps it private. Keep the
passphrase somewhere other than GitHub (a password manager): GitHub cannot show
a secret again, and without the passphrase every backup is noise. Note that an
export blocks other queries on the database while it runs (seconds at this
size).

To restore:

1. *Actions → Backup* → pick the run → download `cityshield-db-<stamp>` (a zip
   holding `cityshield-db-<stamp>.sql.gpg`). Unzip it.
2. Decrypt (asks for the passphrase):
   ```sh
   gpg --output cityshield-db.sql --decrypt cityshield-db-<stamp>.sql.gpg
   ```
   The `.sql` holds every user's email, password hash and home coordinate —
   keep it off shared folders and delete it when done.
3. Restore into a **fresh** database rather than over the live one — the dump
   is `CREATE TABLE` + `INSERT`, and it fails on tables that already exist:
   ```sh
   cd backend
   npx wrangler d1 create cityshield-restore --location=weur
   npx wrangler d1 execute cityshield-restore --remote --file=../cityshield-db.sql
   ```
   If it stops on a foreign key, prepend `PRAGMA defer_foreign_keys = true;`
   to the file and run it again.
4. Check it (`select count(*) from users`, `select * from d1_migrations`), then
   point `database_id` in `wrangler.jsonc` at the new database and deploy — or
   copy the rows you need across with `wrangler d1 execute`. Migrations newer
   than the backup still need applying (`wrangler d1 migrations apply`).
5. Delete the decrypted `.sql`.

Run a backup by hand from *Actions → Backup → Run workflow* — worth doing once
right after the secrets exist, and restoring it into a scratch database once,
so the first real restore is not also the first test.

## Simulate a cron locally

```sh
npm run dev
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

## Measure a CPU burst

Do not use `performance.now()` inside workerd: it steps in 1 ms increments
and then stops advancing. Instead:

1. Bundle the code under test with the repo's esbuild, from `backend/` so
   bare imports resolve:
   `node_modules/.bin/esbuild src/... --bundle --format=esm --platform=node`.
2. Time it with `process.hrtime.bigint()` in **one fresh Node process per
   data point**. The cost being hunted is cold-isolate JIT, and a second call
   in the same process is 5–10× cheaper.
3. Read the result as a **floor**, since workerd is slower than Node.
4. Confirm against real `cpuTime` from `wrangler tail`.
5. Write a regression guard on **bytes or work**, not milliseconds (see the
   byte budgets in `test/scrape.spec.ts`).

## Run an alert review

From the repo root: `python tools/alert-review/app.py`. Load from remote D1,
judge each alert, and write a report into `tools/alert-review/reports/`.

Before judging, place each alert's `created_on_utc` against the evaluation
boundaries in [timeline.md](timeline.md): 02.08.2026 13:00 UTC and
10.08.2026 17:20 UTC. Rows from either side of a boundary were produced by
different seeds and different matchers.

Re-measure the structural-reach table at the top of
[accuracy.md](accuracy.md). Recipient **counts** mean nothing with fewer than
five test users.

## Tune a polygon threshold

1. Change the constant in `tools/polygon-tester` (its controls override the
   real constants), not in the code first.
2. **Sweep a range** over every preset, and record the range that works, not
   one value.
3. After changing anything the stages share (clip window, buffering,
   extension, sampling), **re-run the full sweep** before trusting any earlier
   number.
4. Promote any case worth keeping into `backend/test/fixtures/`.

## Test push delivery

From the repo root: `python tools/push-tester/app.py`. A useful setup: load
users from **remote** D1 and target the **local** Worker. That is a real
end-to-end test that needs no deployed ingest key. Nothing is stored.

## Validate a prompt or schema change

`backend/spikes/ai-eval/run-eval.mjs` imports the production prompt and
schema: 3 runs × 3 candidate models, compared **per case id**, gated on "no
case that passes in the baseline may regress". Use at least three runs,
because qwen3 deviates in about one run in five. It needs Workers AI
credentials.

## Rotate a secret

```sh
openssl rand -base64 48 | npx wrangler secret put JWT_KEY        # invalidates every access token in flight
openssl rand -hex 32    | npx wrangler secret put INGEST_API_KEY # update the tools' config and the repo secret too
npx wrangler secret put ONESIGNAL_API_KEY                        # after regenerating in the dashboard
npx wrangler deploy
```

specification §2.4 defines rotation as re-`put` plus a redeploy. Sessions survive a
`JWT_KEY` rotation, because refresh tokens are D1 rows and the app gets a
fresh access token. Mirror the values in `backend/.dev.vars`, which is
gitignored.

## Re-sync the invention disclosure

`cityshield_invention_disclosure.docx` is a Bulgarian-language disclosure for
a lawyer. It is **kept outside git**. Its §3 ("Техническа същност") mirrors
specification §1.3, §1.6, §1.8 and §1.9, and must be re-synced when those change
materially.

- It reads as a standalone first and final version. It refers to the
  project's first architecture ("в първоначалната версия на системата"),
  never to an earlier draft. Keep it that way.
- The then → now mapping stays, because the public disclosure (Идейник,
  17.01.2026) was made under the old architecture.
- Fuzzy matching and point-in-polygon are **our own TypeScript code** now. An
  earlier version told the lawyer they were `pg_trgm` and PostGIS.
- To edit it: unzip, patch `word/document.xml` using the existing style ids
  (`1` = H1, `2` = H2, `a4` = bullet, the bordered paragraph = the yellow
  "Важно" box), and rezip. Restore the original `<w:document>` opening tag,
  or ElementTree drops namespace prefixes that `mc:Ignorable` still names.
- Still open in the document: the exact contribution split for the migration
  period, and §5's "точната година предстои да се уточни".
