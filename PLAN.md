# CityShield — Google Cloud Run Deployment Plan

Target: run the server-side stack (ASP.NET API + Python ingestion + PostgreSQL/PostGIS)
on Google Cloud, replace the locally hosted Ollama LLM with an external AI API, and
ship the Android app pointed at the hosted API — while staying GDPR-compliant (we
operate from Bulgaria, i.e. inside the EU).

> Status: **plan only** — nothing in this document has been implemented yet.
> Prices, quotas, and Google terms referenced here were checked in July 2026;
> re-verify them before committing to them.

**How this document is organized.** §1 shows the target architecture and how it
differs from today's `docker-compose.prod.yml`. §2 records the three up-front
decisions (AI provider, ingestion execution model, region) plus the already-made
database decision, with the reasoning so they can be revisited if assumptions
change. §3 is the complete list of code changes, per component, each traceable
to a concrete file. §4 lists every account that has to exist before deployment.
§5 is the step-by-step cloud setup with actual `gcloud` commands. §6 and §7
cover security and GDPR/legal obligations respectively. §8 estimates the
monthly bill, and §9 turns everything into an ordered rollout checklist.

---

## 1. Target architecture

```
                        Google Cloud (single project, single EU region)
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                                                                              │
 │  Cloud Scheduler ──every 10 min──► Cloud Run JOB          Neon (external)   │
 │                                    "cityshield-ingest"    PostgreSQL 16      │
 │                                    (backend/, one pass    + PostGIS, EU      │
 │                                    of all scrapers) ────► (crawl state,      │
 │                                          │                 streets, alerts,  │
 │                                          │ Gemini API      users)            │
 │                                          ▼                    ▲              │
 │                                    POST /api/alerts/          │              │
 │                                    submit-data (X-Api-Key)    │              │
 │                                          │                    │              │
 │                                          ▼                    │              │
 │  HTTPS (*.run.app, TLS by Google) ► Cloud Run SERVICE ────────┘              │
 │        ▲                            "cityshield-api"                         │
 │        │                            (ASP/, JWT auth, geo matching) ──► FCM   │
 │  Secret Manager (JWT key, DB password, ingest key, Gemini key)        │      │
 └───────────────────────────────────────────────────────────────────────┼──────┘
                                                                          ▼
          React Native app (Google Play) ◄──────────────── push notifications
```

### 1.1 Life of an alert (end to end)

To make the diagram concrete, here is what happens for a single utility
announcement once everything is deployed:

1. **Cloud Scheduler fires** (every 10 minutes) and calls the Cloud Run Jobs
   API to start one execution of the `cityshield-ingest` job.
2. **The job runs one pass of every scraper** (`run.py --once`): ViK Varna,
   ERP Sever, Veolia heating, VarnaTraffic, and АПИ roads. Each scraper checks
   its source and compares against the **crawl state stored in Neon**, so
   announcements already processed in a previous run are skipped — this is what
   makes repeated scheduled runs idempotent.
3. **New announcements go to the Gemini API** (`ai_parse()` in
   `processing/ai_parser.py`) with a JSON schema constraint, returning
   structured fields (streets, date ranges, category) extracted from the
   Bulgarian free text.
4. **The polygon builder** (`processing/polygon.py`) resolves the extracted
   street names against the seeded street geometry in Neon (fuzzy matching +
   PostGIS) and produces an affected-area polygon.
5. **The job POSTs the finished alert** to the API's
   `POST /api/alerts/submit-data` endpoint, authenticating with the shared
   `X-Api-Key` header, then exits. The container stops billing the moment it
   exits.
6. **The API stores the alert and matches it against users**: a PostGIS query
   finds users whose saved home location falls inside (or near) the alert
   polygon, filtered by their notification preferences.
7. **Matched users get a push notification** via Firebase Cloud Messaging,
   which the React Native app (installed from Google Play) displays. The app
   also pulls recent alerts from the API for the map view.

Steps 1–5 involve no user data at all; personal data (email, home location,
device tokens) only lives in steps 6–7 and in Neon. This separation is what
keeps the AI provider out of the GDPR processing chain entirely (§7.1).

### 1.2 What changes relative to `docker-compose.prod.yml`

Today's production story is a single host running five containers (api,
ingestion, postgres, ollama, plus networking) via compose. The cloud version
dissolves that into managed pieces:

| Today (compose) | On Google Cloud |
|---|---|
| Postgres container + volume | **Neon** managed serverless Postgres, free tier, EU region (PostGIS supported via `CREATE EXTENSION postgis`) |
| Ollama container (qwen3.5) | **Gemini API** (external, no GPU/VM to run) |
| `ingestion` container in an infinite polling loop | **Cloud Run Job** running one scrape pass, triggered by **Cloud Scheduler** |
| `api` container behind your own reverse proxy | **Cloud Run service** — Google terminates TLS, gives a `https://….run.app` URL |
| Secrets in `.env` file | **Secret Manager**, injected as env vars |
| `fcm.json` mounted from disk | **Application Default Credentials** (the service's own identity) — no key file at all |

The guiding principle behind every row: **nothing should cost money while
idle**. The API scales to zero between requests, the ingest job only exists
while a pass is running, Neon's compute auto-suspends, and Gemini is billed
per call. The only always-on things are free (Scheduler triggers, secrets at
rest, the Neon storage).

Compose does not go away — it remains the local integration environment and
the documented self-hosted alternative (§3.4).

---

## 2. Decisions to make up front

Three decisions shape everything downstream: which AI provider replaces
Ollama, how the ingestion loop maps onto Cloud Run's execution model, and
which region hosts it all. The database decision (§2.4) is already made and
recorded here for completeness.

### 2.1 AI provider — recommendation: Gemini API, budget for the paid tier

The ingestion pipeline needs an LLM for exactly one task: extracting
structured fields (street names, date ranges, category) from short
Bulgarian-language utility announcements. Today that's a local Ollama
instance running qwen3.5 with structured-output constraints. In the cloud,
running Ollama would require an always-on VM with enough RAM/GPU for the
model — the single most expensive component by far — so the plan is to
replace it with a hosted API.

The free Gemini tier you remembered does exist (Google AI Studio key,
[ai.google.dev](https://ai.google.dev/gemini-api/docs/rate-limits)):
roughly **Gemini 2.5 Flash ≈ 10 requests/min, 250/day** and
**Flash-Lite ≈ 15 requests/min, 1 000/day** (limits change often — check the
rate-limits page). Those daily quotas comfortably cover our volume — a
handful of new announcements per day, occasionally a burst after a storm.
Two caveats matter for us, though:

1. **EEA terms** — Google's Gemini API additional terms steer apps that serve
   end users in the EEA/UK/Switzerland toward the **paid tier**. Our use is
   server-side only (users never talk to the model, never see raw model
   output, and can't influence prompts), but since we operate from Bulgaria
   the safe reading is: fine for development, use the paid tier in
   production. The terms are ambiguous enough that arguing about them isn't
   worth the sub-€1/month the paid tier costs.
2. **Training on your data** — on the unpaid tier Google may use
   prompts/outputs to improve its products. We only send **scraped public
   utility announcements** (never user data — keep it that way), so this is
   not a GDPR problem, but the paid tier removes the concern entirely and is
   processed under the Google Cloud terms.

The paid tier is effectively negligible for this workload: a handful of short
Bulgarian-language announcements per day on Flash-Lite / Flash costs **well
under €1/month** — the announcements are a few hundred tokens each and the
structured output is smaller still.

Options, in order of preference:

| Option | Pros | Cons |
|---|---|---|
| **Gemini API (AI Studio key), paid tier** ✅ | Simplest SDK (`google-genai`), structured output (JSON schema) like Ollama's `format=`, same Google account as the rest of the stack | Key is a bearer secret (store in Secret Manager) |
| Gemini via **Vertex AI** (same GCP project) | No API key at all (service-account auth), guaranteed **EU regional endpoint** (`europe-west3`), Cloud DPA applies automatically | Slightly more setup (SDK config differs), no free tier |
| Keep **Ollama** on a GCE VM | No third party sees the data | Needs an always-on VM (≥ €30/mo for something that runs qwen3.5 acceptably) — defeats the purpose |

Start with the AI Studio key (free tier while developing, flip to paid before
launch). If we later want the cleanest GDPR/data-residency story, switching to
Vertex AI is a ~20-line change once `ai_parser.py` is provider-agnostic
(§3.2) — the `google-genai` SDK supports both backends with a client-level
switch, so the parsing code itself wouldn't change.

### 2.2 How the ingestion service runs — recommendation: Cloud Run Job + Scheduler

Today `run.py` is a long-lived process: it registers all five scrapers in a
`SERVICES` list, spawns an `asyncio` task per scraper, and each task loops
forever — run the scraper, sleep its configured interval (default 10 minutes,
per-source override via `VIK_INTERVAL` etc.), repeat. That shape assumes a
host where an idle process is free. Cloud Run's pricing model breaks that
assumption.

Cloud Run **services** are request-driven: with the default (request-based)
billing the CPU is throttled to near zero between requests, so
`run.py`'s infinite `asyncio` polling loop would starve — `asyncio.sleep()`
would drift unpredictably and the scrapers might simply never wake. Options:

- ✅ **Cloud Run Job**: add a `--once` mode to `run.py` (one pass of every
  scraper, then exit). Cloud Scheduler executes the job every N minutes. Zero
  idle cost, no HTTP server needed, retries/timeouts handled by the platform.
  This is the execution model Cloud Run Jobs were designed for: do a batch of
  work, exit, get billed for the seconds you actually ran. Because all crawl
  state already lives in Postgres (not process memory or local files), a
  fresh process every 10 minutes picks up exactly where the last one left
  off — the code was accidentally already architected for this.
- ❌ Cloud Run service with `min-instances=1` + instance-based billing: works
  without code changes but bills 24/7 (~€15–25/mo) for a process that is idle
  95 % of the time — paying VM prices without getting a VM.

Consequence: the per-source intervals (`VIK_INTERVAL`, …) stop mattering in
production — the Scheduler cadence (e.g. `*/10 * * * *`) replaces them, and
every source is checked on every run. That's fine: checking a source that has
nothing new is nearly free (one HTTP GET + a crawl-state lookup). If a
source ever needs its own cadence, create a second Scheduler trigger passing
`--only <source>` args; not needed for v1.

### 2.3 Region — recommendation: `europe-west3` (Frankfurt)

There is no Bulgarian region. Any EU region satisfies GDPR data-residency
preferences; Frankfurt is close, has every service we need (Cloud Run, Cloud
Run Jobs, Scheduler, Secret Manager), and keeps latency to Varna
low (~30–40 ms). Neon's Frankfurt region (`aws-eu-central-1`) sits in the same
city, so the Cloud Run ↔ Neon hop stays in the low single-digit ms — that
matters because the API does several DB round-trips per request and the
ingest job does many small crawl-state queries.

Alternatives considered: `europe-west1` (Belgium) is marginally cheaper and
`europe-central2` (Warsaw) is geographically closer to Bulgaria, but neither
difference is meaningful at our scale, and Frankfurt's co-location with
Neon's EU region is the deciding factor. Whatever is chosen, **everything**
goes in that one region — Cloud Run, Artifact Registry, Scheduler — both for
data-residency simplicity (§7.4) and to avoid cross-region egress charges.

### 2.4 Database — Neon free tier ✅ (decided)

**Decision: [Neon](https://neon.tech) managed serverless Postgres, free tier,
EU region (Frankfurt).** This replaces Cloud SQL, which at ~€10–15/month for
the smallest instance (`db-f1-micro`) would have dominated the monthly bill —
Neon brings the database cost to **€0** at this data volume. The database is
the one component both stacks share (EF Core migrations own the schema; the
Python side reads/writes crawl state and street geometry), so it's also the
one component that must exist before either workload can start.

What Neon gives us and what we're accepting:

- Postgres 16/17 with **PostGIS** available via `CREATE EXTENSION postgis` —
  the geo matching (user location × alert polygon) and the street fuzzy
  matching both depend on it, so this was a hard requirement for any
  candidate.
- Free tier: ~0.5 GB storage, compute auto-suspends when idle and wakes in
  ~500 ms on the first query — fine for a scheduled ingestion job and a
  low-traffic API. The wake latency shows up as a one-time slow first request
  after a quiet period, which is acceptable for this product. Verify storage
  headroom after seeding the street geometry — the OSM-derived street data is
  the biggest table by far.
- Connectivity: a plain TLS connection string (host/port/`sslmode=require`) —
  works unchanged with both Npgsql (.NET) and psycopg (Python). No Cloud SQL
  connector, no unix sockets, no `--add-cloudsql-instances` flags. This
  actually *simplifies* the deploy relative to Cloud SQL.
- Trade-offs accepted: leaves the all-Google story (Neon becomes a second
  data processor — see §7.2), cross-provider hop (negligible for our batch
  pattern), free-tier ceilings (upgrade path: Neon Launch plan ~$19/mo, or
  migrate to Cloud SQL later — it's just Postgres either way, so moving is a
  `pg_dump`/restore, not a rewrite).
- Point-in-time restore is included on the free tier (limited history window);
  no daily backup job to configure, but note the retention implications in §7.7.

Fallback if Neon disappoints: Supabase free tier (also EU + PostGIS), or back
to Cloud SQL `db-f1-micro` at the original ~€10–15/mo.

---

## 3. Codebase changes

Everything in this section is testable locally before any cloud resource
exists — that's Phase 1 of the rollout (§9). The changes are grouped by
component: the ASP.NET API (§3.1), the Python ingestion (§3.2), the React
Native app (§3.3), and repo-level tooling (§3.4).

### 3.1 API — `ASP/CityShieldAPI`

The API is closest to cloud-ready already: the connection string, JWT
settings, and ingest key are all env-driven, production guards fail fast on
placeholder secrets, and logging goes to stdout. The changes below are about
Cloud Run's specific runtime contract (A1–A2), removing the key file (A3),
the platform's scale-to-zero behavior (A4, A7, A8), and one missing feature
that GDPR and Google Play both require (A5).

**A1 — Bind to the Cloud-Run-provided `$PORT`.**
`Program.cs` line ~122 currently hardcodes the listener:
`app.Urls.Add("http://0.0.0.0:5276")`. Cloud Run's container contract is that
the process listens on the port given in the `PORT` env var (default 8080) on
`0.0.0.0`; containers that fail to bind it within the startup timeout are
killed and the deploy fails. Change to
`app.Urls.Add($"http://0.0.0.0:{Environment.GetEnvironmentVariable("PORT") ?? "5276"}")`
so local development keeps its familiar 5276 while Cloud Run gets whatever it
asks for.

**A2 — Forwarded headers, and drop the in-app HTTPS redirect.**
Google's front end terminates TLS, so the container only ever sees plain
HTTP, with the original scheme and client IP delivered in `X-Forwarded-Proto`
and `X-Forwarded-For` headers. Two consequences: (a) register
`UseForwardedHeaders` (for `X-Forwarded-For` / `X-Forwarded-Proto`) early in
the pipeline so the request's scheme and remote IP are rewritten from the
headers — otherwise generated absolute URLs say `http://` and logged client
IPs are Google's proxy addresses; (b) the existing `UseHttpsRedirection()`
(line ~105) should be skipped when running behind the proxy — before the
header rewrite it's actively wrong, after it it's a no-op, and Cloud Run
already refuses plain-HTTP at the edge. Gate both on an env flag or on
`ASPNETCORE_ENVIRONMENT`.

**A3 — Firebase via Application Default Credentials.**
`Program.cs` lines 21–28 unconditionally load a service-account key file
(`Firebase:CredentialsFile`, defaulting to `fcm.json`) — on Cloud Run there
is no such file, and the process would crash at startup. Change the startup
logic: if `Firebase:CredentialsFile` is unset and no `fcm.json` exists, fall
back to `GoogleCredential.GetApplicationDefault()`. On Cloud Run, ADC
resolves to the service account attached to the Cloud Run service (via the
metadata server) — the identity *is* the credential, so there is no key file
to create, rotate, or leak; the SA just needs the FCM send role (§5.5).
Local development keeps using `fcm.json` unchanged.

**A4 — Replace `StaleTokenCleanupService`'s in-process scheduling.**
`StaleTokenCleanupService` (registered in `Program.cs` line 42) is a
`BackgroundService` that wakes every 24 h to purge device tokens unseen for
60+ days. On Cloud Run this timer never fires reliably: instances scale to
zero when idle, and between requests the CPU is throttled to near zero, so a
24-hour in-process timer may simply never elapse. Keep the cleanup *logic*
but move the *triggering* out of the process: expose it as a protected
maintenance endpoint (e.g. `POST /api/maintenance/cleanup-tokens`, guarded by
the ingest API key or Cloud Scheduler OIDC auth), and have Cloud Scheduler
call it once a day (§5.7 step 4). The hosted service registration can then be
removed, or kept only for the compose deployment.

**A5 — Account deletion endpoint (`DELETE /api/auth/me`, JWT-authed).**
Currently missing — only an FCM-token delete exists. The endpoint must delete
the authenticated user's row and cascade everything keyed to it: device
tokens, notification preferences, bus-line subscriptions. This is **required
twice over**: GDPR Art. 17 (right to erasure, §7.5) and Google Play's
account-deletion policy, which mandates an in-app deletion path for any app
that supports account creation. Implement in `AuthController` + `AuthService`;
the matching in-app button is F3.

**A6 — `GET /healthz` liveness endpoint (optional but recommended).**
A trivial endpoint returning 200 after a cheap DB ping (`SELECT 1`). Used
three ways: as a Cloud Run startup probe (so a deploy that can't reach Neon
fails visibly instead of serving 500s), as the target of the uptime check in
§5.9, and as the smoke test after every deploy. Keep it unauthenticated and
free of any data.

**A7 — Migrations vs. horizontal scaling.**
`Program.cs` lines 73–78 run `db.Database.Migrate()` at startup when
`Database__AutoMigrate=true`. That's convenient, but if Cloud Run ever starts
two instances simultaneously (a deploy + a traffic spike), both would race
the migration — EF's migrations table locks help but aren't a guarantee
across all migration operations. Mitigation for v1: keep AutoMigrate and
deploy with `--max-instances 1`, which our traffic doesn't come close to
needing anyway. Revisit with a dedicated migration job (run migrations as a
one-off step before rollout) before ever scaling out.

**A8 — Nominatim throttle is per-instance (config note, no code change).**
`NominatimGeocodingService` is registered as a singleton precisely so its
1 req/s throttle and geocode cache are shared — but "singleton" means
per-process, so every additional Cloud Run instance multiplies our request
rate against `nominatim.openstreetmap.org`. Nominatim's usage policy is
per-service, not per-instance. Another reason to cap `--max-instances` at
1–2 until geocoding moves behind a shared queue or persistent cache.

No change needed for: connection string (already env-driven via
`ConnectionStrings__DefaultConnection`), JWT/ingest-key production guards
(already fail-fast — `Program.cs` refuses to start in Production with a
placeholder JWT key or an empty ingest key), console logging (Cloud Logging
captures stdout automatically).

### 3.2 Ingestion — `backend/`

Two structural changes (the AI provider swap, B1–B3, and the run-once mode,
B4–B5) plus dependency/config bookkeeping (B6–B8). The design goal of B1 is
that **no scraper or service module changes at all** — the entire provider
swap stays inside `ai_parser.py` and `config.py`.

**B1 — Rewrite `ai_parse()` for Gemini.**
Today `processing/ai_parser.py` calls `ollama.chat()` with the messages plus
`format=<json-schema>` — Ollama's structured-output mode, which forces the
model to emit exactly the given shape. Gemini has a direct equivalent: call
`google-genai` with `response_mime_type="application/json"` and
`response_schema=<schema>` in the generation config. The public signature
`ai_parse(system_prompt, user_prompt, format_schema) -> str | None` stays
identical — it returns the raw JSON string or `None` on failure, exactly as
now — so the five service modules that call it need no changes. Preserve the
existing behaviors around the call: the 3-attempt retry loop (today it backs
off linearly with `time.sleep(2 * attempt)`; extend it to exponential backoff
and specifically honor HTTP 429 / `Retry-After`, since the free tier's
requests-per-minute cap is the failure mode we'll actually hit during
development), the return-`None`-on-any-failure contract, and the persistent
debug cache — the cache is keyed on a hash of prompts + schema and stores raw
strings, so it's already provider-agnostic and keeps working for offline
debugging.

**B2 — Optional: keep a provider switch `AI_PROVIDER=gemini|ollama`.**
A small dispatch in `ai_parser.py` + one config field lets local development
stay offline and free (Ollama) while production uses Gemini. Cheap to keep
because the two code paths share everything except the actual API call;
delete the Ollama path instead if you'd rather not maintain two backends —
but keeping it also preserves the compose stack as a fully self-hosted
option (§3.4).

**B3 — Config: new Gemini fields.**
Add to the pydantic-settings model in `config.py`: `GEMINI_API_KEY` (secret —
env/Secret Manager only, never `.env.example` with a real value) and
`GEMINI_MODEL` (default `gemini-2.5-flash-lite` — the cheapest option and
sufficient for field extraction from short Bulgarian announcements; bump to
`gemini-2.5-flash` if parsing quality disappoints — measure against the
qwen3.5 baseline before launch, see Phase 1 in §9). Mirror both in
`.env.example`.

**B4 — `--once` mode in `run.py`.**
Today `main()` creates an endless `service_loop` task per scraper. Add a CLI
flag (argparse) so `--once` instead runs each service exactly once — reusing
the existing `run_service` wrapper, which already isolates failures by
catching and logging any exception — and then exits 0. The Cloud Run Job
contract is exactly that: do the work, exit; a non-zero exit would trigger
the platform's retry. Since `run_service` swallows per-scraper exceptions, a
single broken source won't fail the whole run — deliberate, because
re-running four healthy scrapers to retry one dead website is wasteful; the
log-based error alert in §5.9 is the failure signal instead. Keep the
infinite loop as the default behavior for compose/local. Crawl state already
lives in Postgres, so single-pass runs are naturally idempotent.

**B5 — Drop `FileHandler("backend.log")` in the cloud.**
`run.py` line ~34 attaches a file log handler alongside stdout. On Cloud Run
the filesystem is an in-memory tmpfs: the log file consumes the container's
RAM allocation and evaporates when the job exits, while stdout is already
captured by Cloud Logging. Gate the handler on an env flag (or just remove
it — the stdout stream is the same content).

**B6 — Dependencies.**
`requirements.txt`: replace `ollama` with `google-genai` (or add it alongside
if B2 keeps both providers).

**B7 — Seeder path for Neon (documentation, no code change).**
The streets/regions reference data must exist in the database before the
first scrape — the polygon builder resolves street names against it, so an
unseeded database means every announcement fails geo-matching. Plan the
one-time run of `python -m data.postgres.seeding.seeder` against Neon:
either as a Cloud Run Job execution with a command override (§5.7 step 1), or
simply from a local machine — Neon is directly reachable over TLS, no proxy
or tunnel needed, which makes the local option genuinely easy.

**B8 — TLS to Neon (`sslmode=require`).**
Neon requires TLS. The backend opens psycopg connections in three places —
`data/postgres/state_repository.py` (`_connect()`), `services/common.py`,
and `data/postgres/seeding/seeder.py` — all passing keyword args from
`cfg.POSTGRES_*`, and `config.py` currently has **no SSL field**. Two ways to
fix it: (a) add a `POSTGRES_SSLMODE` field (default `prefer` so local
docker-compose is unaffected, set `require` in the cloud env) and pass it
through at all three call sites; or (b) zero code change — psycopg honors the
standard libpq `PGSSLMODE` env var, so setting `PGSSLMODE=require` on the
job works today. Option (a) is preferred for discoverability (everything
else is in `config.py`), but (b) is a fine stopgap. Npgsql on the API side
takes `SSL Mode=Require` inside the connection string — covered in §5.6.

### 3.3 Frontend — `frontend/`

The app needs no architectural changes — it already talks to the API over a
configurable base URL. The work is release configuration (F1–F2) and the two
user-facing legal requirements (F3), plus one flagged risk (F4).

**F1 — Point release builds at production.**
Build release bundles with `CITYSHIELD_API_URL=https://<cloud-run-url>` — the
mechanism already exists in `src/config.ts`, so this is a build-time env var,
not a code change. Because the run.app URL is HTTPS, no Android
cleartext-traffic exemptions are needed in the release manifest (the dev
builds' HTTP allowances must not leak into release).

**F2 — Production `google-services.json`.**
Place the Firebase config for the *production* Firebase project into
`frontend/android/app/`. Dev may already have one — double-check the release
build uses the production project's file, otherwise push notifications from
prod will silently go nowhere (tokens registered against the wrong project).

**F3 — Privacy policy link + in-app account deletion.**
Two additions to the settings/profile screen: a link opening the hosted
privacy policy (§7.6), and a "Delete account" action (with confirmation)
calling the new `DELETE /api/auth/me` (A5), then clearing local state and
returning to the login screen. Both are Google Play review requirements, not
just GDPR niceties — the reviewer will look for them.

**F4 — OSM tile usage (note for later, no action for v1).**
The map loads tiles straight from `tile.openstreetmap.org`. OSMF's tile usage
policy tolerates light usage with attribution (we have it) but explicitly
discourages distribution-scale mobile apps. At launch volume this is fine; if
installs grow, budget a tile provider (e.g. MapTiler or Thunderforest free
tiers, both of which allow mobile app usage with attribution) — the change is
one tile-URL template string.

### 3.4 Repo / tooling

- `docker-compose.prod.yml`: remove the `ollama` service (or keep it and gate
  on `AI_PROVIDER` if B2 is kept); add `GEMINI_API_KEY`/`GEMINI_MODEL`
  passthrough to the ingestion service. Compose remains the "self-hosted"
  alternative and the local integration environment — it should keep working
  after every change in this section, which is also how Phase 1 gets tested.
- `.env.example` (root + backend): add the Gemini vars; annotate which values
  move to Secret Manager in cloud deploys so the file doubles as the secrets
  inventory.
- README: replace the "Production deployment" section with a pointer to this
  plan / a future `DEPLOYMENT.md` — the compose instructions stay, retitled
  as self-hosting.
- Optional CI/CD (recommended once deploys are routine, not before): GitHub
  Actions workflow that builds both images and deploys on push to `main`,
  authenticating via **Workload Identity Federation** — GitHub's OIDC tokens
  are exchanged for GCP credentials directly, so no service-account JSON key
  ever sits in GitHub secrets. Manual `gcloud` deploys are fine for the first
  weeks; automate when the manual steps get boring, because that's when
  mistakes start.

---

## 4. Accounts & registrations (what to sign up for, and where)

Several of these have lead times measured in days (Play Console identity
verification in particular), so they front-load into Phase 0 of the rollout
(§9) even though most of the work happens later.

| # | Account | Where | Cost | Notes |
|---|---|---|---|---|
| R1 | **Google Cloud** | [console.cloud.google.com](https://console.cloud.google.com) | Free to create; needs a card for billing | New accounts get a **$300 / 90-day free trial**. Billing account country = Bulgaria; if you have a company, enter the VAT/EIK so invoices are usable |
| R2 | **Firebase** | [console.firebase.google.com](https://console.firebase.google.com) | Free (Spark plan covers FCM entirely) | **Add Firebase to the same GCP project** — one project, one console, one service-account story. You likely already have a dev Firebase project; decide whether to promote it or create a clean `cityshield-prod` |
| R3 | **Google AI Studio** (Gemini API key) | [aistudio.google.com](https://aistudio.google.com) | Free tier; paid tier billed through the GCP billing account | Create the key **inside the same GCP project** so enabling paid tier is one click and usage shows up on the same bill |
| R4 | **Google Play Console** | [play.google.com/console](https://play.google.com/console) | **$25 one-time** | Needed to distribute the app. Identity verification takes days — start early. Personal vs. organization account choice is permanent-ish |
| R5 | **Neon** (database) | [neon.tech](https://neon.tech) | **Free tier** | Create the project in the **Frankfurt** region (`aws-eu-central-1`). Sign the DPA / note their processor terms for §7.2 |
| R6 | Custom domain (optional) | any registrar | ~€10/yr | Not required — `*.run.app` comes with TLS. Nice-to-have: `api.cityshield.bg` via Cloud Run domain mapping |

Notes on the non-obvious ones:

- **R2/R3 — "same project" matters.** Firebase projects *are* GCP projects
  under the hood. Adding Firebase to `cityshield-prod` (rather than keeping a
  separate Firebase project) means the API's service account, the FCM
  permission, and the ADC story (A3) all live in one place. Likewise creating
  the AI Studio key inside the project ties Gemini billing and quotas to the
  same billing account.
- **R4 — the account-type choice is sticky.** A personal Play developer
  account can't be cleanly converted to an organization one later; if there's
  any chance a company will own this app, decide before registering.
- **R6 — genuinely optional.** The `*.run.app` URL is stable, HTTPS, and fine
  for an app backend nobody types by hand. A custom domain is a branding
  nicety, not a launch dependency.

A privacy policy needs a **public URL** (Play requires it) — GitHub Pages of
this repo is the zero-cost option (§7.6).

---

## 5. Google Cloud project setup — step by step

All commands via the [gcloud CLI](https://cloud.google.com/sdk/docs/install)
(or Cloud Shell in the console). Placeholders: `PROJECT` = project id,
`REGION` = `europe-west3`. The steps are ordered by dependency: project →
images → database → secrets → identities → workloads → monitoring.

### 5.1 Project & APIs

Create a dedicated project (clean IAM/billing boundary, easy to delete if the
experiment fails), link billing, and enable the five service APIs the plan
uses — API enablement is per-project and deploys fail confusingly when one is
missing:

```
gcloud projects create cityshield-prod --name="CityShield"
gcloud config set project cityshield-prod
gcloud billing projects link cityshield-prod --billing-account=BILLING_ACCOUNT_ID
gcloud services enable run.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com cloudbuild.googleapis.com
```

### 5.2 Artifact Registry + images

Cloud Run only pulls from Artifact Registry (or the legacy GCR), so both
images need to live there. `gcloud builds submit` uploads the build context
and runs the existing Dockerfiles on Cloud Build — no local Docker needed,
and it works identically from Windows:

```
gcloud artifacts repositories create cityshield --repository-format=docker --location=REGION
# Build & push both images with Cloud Build (uses the existing Dockerfiles):
gcloud builds submit ASP/CityShieldAPI -t REGION-docker.pkg.dev/PROJECT/cityshield/api:v1
gcloud builds submit backend          -t REGION-docker.pkg.dev/PROJECT/cityshield/ingest:v1
```

Tag images explicitly (`v1`, `v2`, …) rather than relying on `latest` —
Cloud Run revisions pin the digest anyway, but explicit tags make rollbacks
(`gcloud run services update-traffic`) legible.

### 5.3 Database — Neon (outside GCP)

The database precedes both workloads: the API runs migrations against it on
first boot, and the ingest job needs the seeded reference data.

1. Sign up at [neon.tech](https://neon.tech) (use the same Google account for
   sanity), create a project **in the Frankfurt region** (`aws-eu-central-1`),
   Postgres 16+. The region is chosen at project creation and cannot be
   changed afterwards.
2. Create the database `CityShieldDB` and a dedicated app role (Neon's default
   role is fine to keep as the "admin"; add a separate less-privileged role for
   the services — it needs DML on all tables plus DDL for EF migrations and
   the crawl-state table the ingestion creates on first use, but not
   role/database management).
3. Connect with `psql` (Neon shows the connection string) and run
   `CREATE EXTENSION IF NOT EXISTS postgis;` in `CityShieldDB`. Do this
   before the first API deploy — the EF migrations assume the extension
   exists.
4. Note the connection details: host (`…eu-central-1.aws.neon.tech`), user,
   password, `sslmode=require`. The password goes into Secret Manager (§5.4);
   nothing else about the GCP setup changes.

### 5.4 Secrets

Four secrets, all consumed as env vars by the workloads. Generate the first
two fresh (32+ random characters — e.g. `openssl rand -base64 32`); the DB
password comes from Neon, the Gemini key from AI Studio:

```
printf '%s' '<value>' | gcloud secrets create jwt-key        --data-file=-   # 32+ random chars
printf '%s' '<value>' | gcloud secrets create ingest-api-key --data-file=-
printf '%s' '<value>' | gcloud secrets create db-password    --data-file=-
printf '%s' '<value>' | gcloud secrets create gemini-api-key --data-file=-
```

(`printf '%s'` rather than `echo` so no trailing newline lands in the secret —
a classic source of "the key is right but auth fails".) Versions are
immutable; rotation = add a new version and redeploy.

### 5.5 Service accounts (least privilege)

One identity per workload, so a compromise of one component grants nothing
beyond what that component legitimately touches. Never attach the default
compute SA — it comes with project-wide Editor in older projects.

| SA | Roles |
|---|---|
| `cityshield-api@…` | `roles/secretmanager.secretAccessor` (on its secrets), **Firebase Cloud Messaging API Admin** (`roles/firebasecloudmessaging.admin`) for ADC push delivery |
| `cityshield-ingest@…` | `roles/secretmanager.secretAccessor` (db + gemini secrets) |
| `cityshield-scheduler@…` | `roles/run.invoker` on the ingest job and on the API maintenance endpoint |

Grant `secretAccessor` **per secret** (on the secret resource), not
project-wide — e.g. the ingest SA can read `db-password` and
`gemini-api-key` but has no access to `jwt-key`.

### 5.6 Deploy the API (Cloud Run service)

```
gcloud run deploy cityshield-api \
  --image REGION-docker.pkg.dev/PROJECT/cityshield/api:v1 \
  --region REGION --allow-unauthenticated \
  --service-account cityshield-api@PROJECT.iam.gserviceaccount.com \
  --set-env-vars "ASPNETCORE_ENVIRONMENT=Production,Database__AutoMigrate=true,Jwt__Issuer=CityShield,Jwt__Audience=CityShield Users,Jwt__ExpireMinutes=60" \
  --set-secrets "Jwt__Key=jwt-key:latest,Ingest__ApiKey=ingest-api-key:latest,DB_PASSWORD=db-password:latest" \
  --memory 512Mi --max-instances 1
```

Flag rationale: `--allow-unauthenticated` because this is a public API (its
endpoints carry their own auth — JWT for users, X-Api-Key for ingest);
`--max-instances 1` per A7 (migration race) and A8 (Nominatim policy);
`--memory 512Mi` is a starting point — check actual usage in the metrics tab
after a few days and trim if it sits far below.

(The connection string —
`Host=<neon-host>;Database=CityShieldDB;Username=…;Password=…;SSL Mode=Require`
— contains the DB password; either template it from the secret in a small
entrypoint script, or store the **whole connection string** as one secret and
map it to `ConnectionStrings__DefaultConnection`. The single-secret option is
simpler — do that. Note the Npgsql keyword is `SSL Mode=Require`, the
psycopg equivalent being `sslmode=require` — same requirement, two spellings.)

First deploy runs the EF migrations (AutoMigrate). Verify with a
`/healthz` request and by registering a test user — the register/login round
trip exercises the DB connection, JWT signing, and BCrypt in one go.

### 5.7 Deploy the ingestion (Cloud Run Job + Scheduler)

```
gcloud run jobs create cityshield-ingest \
  --image REGION-docker.pkg.dev/PROJECT/cityshield/ingest:v1 \
  --region REGION \
  --service-account cityshield-ingest@PROJECT.iam.gserviceaccount.com \
  --set-env-vars "POSTGRES_HOST=<neon-host>,POSTGRES_DB=CityShieldDB,POSTGRES_USER=…,ASP_API_URL=https://<api-url>/api/alerts/submit-data,GEMINI_MODEL=gemini-2.5-flash-lite,LOG_LEVEL=INFO" \
  --set-secrets "POSTGRES_PASSWORD=db-password:latest,ASP_API_KEY=ingest-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest" \
  --command python --args run.py,--once \
  --task-timeout 15m --max-retries 1 --memory 512Mi
```

`--task-timeout 15m` is generous headroom over a normal pass (seconds when
nothing is new, a few minutes when the LLM and Overpass get involved) while
still guaranteeing a hung scraper can't run up the bill; `--max-retries 1`
because the next scheduled run is at most 10 minutes away anyway. Add the
`PGSSLMODE=require` env var (or `POSTGRES_SSLMODE` once B8 lands) for the
Neon TLS requirement.

One-time setup, in order:

1. **Seed reference data**:
   `gcloud run jobs execute cityshield-ingest --args "-m,data.postgres.seeding.seeder"`
   (command override), or run the seeder locally — Neon is directly reachable
   over TLS. Without this step, every scraped announcement fails street
   matching (B7).
2. **Test one pass**: `gcloud run jobs execute cityshield-ingest` and read the
   logs end to end — you want to see each scraper start, the Gemini calls
   succeed, and (if a source has something new) a POST to the API return 200.
3. **Schedule it** (console: job → Triggers → Scheduler trigger, or):

```
gcloud scheduler jobs create http cityshield-ingest-cron \
  --location REGION --schedule "*/10 * * * *" \
  --uri "https://run.googleapis.com/v2/projects/PROJECT/locations/REGION/jobs/cityshield-ingest:run" \
  --http-method POST \
  --oauth-service-account-email cityshield-scheduler@PROJECT.iam.gserviceaccount.com
```

4. A second Scheduler job hits the daily token-cleanup endpoint (A4) — same
   pattern, `--schedule "0 3 * * *"` or similar, targeting
   `POST https://<api-url>/api/maintenance/cleanup-tokens` with either an
   OIDC token or the ingest key header.

### 5.8 Firebase / FCM

1. In the Firebase console, add Firebase to `cityshield-prod` (this is an
   "add to existing GCP project" flow, not a new project).
2. Register the Android app (exact `applicationId` from
   `frontend/android/app/build.gradle` — a mismatch here is the classic
   "pushes never arrive" bug), download `google-services.json` →
   `frontend/android/app/`.
3. No `fcm.json` on the server: change A3 + the FCM role on `cityshield-api@`
   covers push delivery via ADC.

### 5.9 Monitoring & guardrails (do not skip)

None of this is optional-nice-to-have; each item guards against a specific,
likely failure:

- **Budget alert** on the billing account (e.g. €25/mo with email at
  50/90/100 %) — the single best protection against surprise bills, and the
  only one that catches *any* misconfiguration regardless of cause (runaway
  retries, an accidental `min-instances`, a quota change).
- **Uptime check** on `/healthz` + alerting policy — catches the API being
  down or unable to reach Neon, which users would otherwise report before we
  notice.
- **Log-based alert** on ingestion job failures (`severity>=ERROR` in the
  job's logs) — because B4 deliberately exits 0 even when a scraper fails,
  the error log is the *only* failure signal. A silently failing scraper
  means silently missing alerts, the worst failure mode for this product:
  everything looks healthy while users miss outage warnings.
- Neon: verify the point-in-time-restore history window on the free tier;
  consider an occasional `pg_dump` (e.g. weekly, from a Scheduler-triggered
  job or locally) as a belt-and-braces backup outside Neon — it also covers
  the "Neon free tier changes terms" scenario.

---

## 6. Security checklist

Work through this before real users sign up; each line notes why it matters
here specifically.

- [ ] **All secrets in Secret Manager** — nothing secret in images, env-var
  *defaults*, or the repo. The committed `appsettings.json` placeholder JWT
  key is already refused in Production by the startup guard — keep that
  guard; it turns a config mistake into a failed deploy instead of a signed-
  with-a-public-key token disaster.
- [ ] **Distinct least-privilege service accounts per workload** (§5.5);
  never the default compute SA, whose legacy Editor grant would hand any
  compromised container the whole project.
- [ ] **Neon hardening**: TLS enforced (`sslmode=require` in both DSNs — B8
  for Python, `SSL Mode=Require` for Npgsql); a dedicated less-privileged app
  role for the services, not the project's admin role; strong password living
  only in Secret Manager. Neon is reachable from the public internet by
  design — the credential *is* the perimeter — so treat the DB password as
  the crown jewels; consider Neon's IP-allowlist feature if/when on a paid
  plan.
- [ ] **Ingest endpoint**: strong random `Ingest__ApiKey` (the API already
  refuses to start in Production with it empty). It guards alert *injection* —
  a leaked key would let someone push fake outage alerts to real users.
  Consider requiring OIDC (Cloud Run service-to-service auth) later instead
  of a shared key.
- [ ] **JWT key**: 32+ random bytes, rotate on suspicion (rotation logs
  everyone out — acceptable); token expiry already 60 min.
- [ ] **Login throttling**: passwords are BCrypt-hashed, but login is
  currently unthrottled, so online brute force is only slowed by BCrypt's
  cost factor. Add basic rate limiting (e.g. `AspNetCoreRateLimit`, or Cloud
  Armor if ever fronted by a load balancer).
- [ ] **Dependency hygiene**: Dependabot /
  `dotnet list package --vulnerable` / `pip-audit` in CI — three ecosystems
  (NuGet, pip, npm) means three sets of CVEs to watch.
- [ ] **Cloud Run**: `--max-instances` set (cost ceiling + Nominatim policy,
  A7/A8); HTTPS-only is automatic on run.app.
- [ ] **Gemini key** restricted to the Generative Language API (API-key
  restrictions in the console), so a leaked key can't be used against other
  Google APIs on our bill; rotate if it ever lands in a log.

---

## 7. GDPR & legal (EU / Bulgaria)

This section is long because it's the part that can't be refactored later —
but the substance is manageable: know what personal data exists (7.1), have
agreements with everyone who touches it (7.2), know why processing is lawful
(7.3), keep it in the EU or covered by transfer mechanisms (7.4), make user
rights actually work (7.5), say all of it in a public policy (7.6), and write
down retention (7.7).

### 7.1 What personal data the system processes

| Data | Where | Sensitivity / notes |
|---|---|---|
| Email address | `Users` table | Identifier |
| Password (BCrypt hash) | `Users` table | Never plaintext — OK |
| **Home location (lat/lon, region, street)** | `Users` table (PostGIS point) | The most sensitive item — effectively a home address. Core to the service (alert matching) |
| FCM device tokens | `DeviceTokens` | Device identifier; auto-purged after 60 days unseen (already implemented) |
| Notification preferences, bus-line subscriptions | preference tables | Low sensitivity, still personal data |
| IP addresses, request metadata | Cloud Run request logs | Transient; Cloud Logging default retention 30 days |

**Not** personal data: scraped utility announcements (public, official,
about infrastructure — this is what goes to Gemini). **Keep it that way:
never send anything user-derived to the LLM.** That single architectural
rule keeps the AI provider out of the personal-data processing chain
entirely — no DPA needed with the model provider, no transfer analysis for
prompts, and it must survive future refactors (e.g. never "personalize"
prompts with user locations).

### 7.2 Roles and processor agreements

- **You** (or your company, once one exists) are the **data controller** —
  the party that decides why and how personal data is processed, and the one
  legally answerable for everything below. Decide and write down who that is —
  it goes in the privacy policy.
- **Google** is a **processor** for Cloud Run/Logging (covered by the
  [Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum),
  incorporated in the GCP terms automatically) and for Firebase/FCM (covered by the
  [Firebase Data Processing and Security Terms](https://firebase.google.com/terms/data-processing-terms)).
  No signature needed, but record both in your processing records.
- **Neon** is a **processor** too — the database holds all user data (emails,
  password hashes, home locations), making Neon the most significant
  processor in the stack. Neon Inc. is a US company; the data itself
  stays in the Frankfurt region (AWS `eu-central-1`), and Neon provides a
  [DPA](https://neon.tech/dpa) with SCCs covering the US-entity angle. Record
  it in the processing records and name it in the privacy policy alongside
  Google.
- No other processors in v1 (Nominatim/Overpass/OSM receive alert-related
  queries, not user data — verify the API's geocoding never sends user
  locations outward; today it geocodes *alert* addresses only, and that
  property should be checked in review whenever geocoding code changes).

### 7.3 Legal bases (Art. 6)

Every processing purpose needs a legal basis; ours map cleanly:

| Processing | Basis |
|---|---|
| Account, credentials, preferences, alert matching against the user's location, push delivery | **Art. 6(1)(b)** — performance of the service the user signs up for. Location is entered voluntarily and is required for the core feature; say so plainly in the policy |
| Security logging, abuse prevention | **Art. 6(1)(f)** — legitimate interest |
| Anything marketing-flavored added later | Consent — not in scope now |

No special-category (Art. 9) data. No profiling/automated decisions with legal
effect (alert matching is a geometric filter the user configures, not an
evaluation of a person). Not directed at children. No DPO needed at this
scale (Art. 37 doesn't trigger); no Art. 27 representative needed (controller
is established in the EU).

### 7.4 Data residency & transfers

- Pin **everything to the EU region** (§2.3): Cloud Run, Artifact
  Registry, Secret Manager (use regional replication or `automatic` — for
  strictness choose user-managed replication to EU regions), Scheduler —
  and the **Neon project in Frankfurt** (region is chosen at project creation
  and the data at rest stays there; the controller–processor relationship with
  Neon's US entity is covered by their DPA/SCCs, see §7.2).
- **FCM caveat**: push message routing may transit Google infrastructure
  outside the EU. This is a standard, documented transfer covered by Google's
  participation in the **EU-US Data Privacy Framework** + SCCs in the Firebase
  terms — it doesn't need fixing, only disclosing. Say in the privacy policy:
  "push notifications are delivered via Google Firebase; Google may process
  routing data outside the EEA under the EU-US DPF." Minimize what's *in* the
  push payload (alert category + text — no user data — already the case, and
  another invariant to preserve).
- Gemini: only non-personal scraped text goes there, so no transfer analysis
  is needed; if you switch to Vertex AI you can additionally pin the model
  endpoint to `europe-west3` for a belt-and-braces residency story.

### 7.5 User rights — what must actually work

The GDPR rights only count if there's a working mechanism behind each one.
For v1 the split is: erasure is automated (it's also a Play requirement),
everything else is handled manually via a support mailbox — legitimate at
this scale, as long as requests actually get answered.

| Right | Implementation |
|---|---|
| **Erasure (Art. 17)** | The new `DELETE /api/auth/me` (change A5) + in-app button (F3) + **a web-reachable deletion path** (Play requires a URL — a static page explaining "delete in app, or email us" is acceptable) |
| Access / portability (Art. 15/20) | v1: handle manually — support email in the policy; the data is one `SELECT` per table. Automate later if volume demands |
| Rectification (Art. 16) | Location/preferences already editable in-app; email changes can be manual v1 |
| Objection / restriction | Manual via support email |

Commit to answering within **one month** (Art. 12(3)) — set up a dedicated
mailbox (e.g. `privacy@…` or a labeled Gmail) that you actually read.

### 7.6 Privacy policy (required before launch — also by Google Play)

Host at a public URL (GitHub Pages is fine). Must state, in plain language
(consider Bulgarian + English — the users are Bulgarian, the reviewers may
not be): who the controller is + contact; what data (table in 7.1) and why;
legal bases; that location is stored to match alerts and is required for the
core feature; processors (Google Cloud, Firebase, Neon) and the FCM transfer
note; retention periods (7.7); user rights and how to exercise them incl.
deletion; the right to complain to the Bulgarian DPA —
**КЗЛД / CPDP, [cpdp.bg](https://www.cpdp.bg)**; and that the app is not
directed at children.

### 7.7 Retention (decide and write down)

Retention is a set of decisions, not a technical feature — the point of this
table is that each row gets *decided*, written into the policy, and then
actually enforced (or consciously deferred):

| Data | Proposal |
|---|---|
| Account | Until deletion by user; optionally auto-delete after e.g. 24 months of inactivity (notify first) |
| FCM tokens | 60 days unseen (already implemented) |
| Alerts | Not personal data — keep freely (useful history), or cap at e.g. 12 months for hygiene |
| Cloud Logging | Default 30 days is fine; don't log request bodies containing credentials/locations |
| DB backups | Neon point-in-time-restore history (~1 day on the free tier — deleted-user data ages out quickly; if you add your own `pg_dump` backups (§5.9), set a retention, e.g. 7 days, and mention it in the policy) |

### 7.8 Other obligations

- **Art. 30 records of processing**: one page listing 7.1–7.7 — small
  controllers should still keep it; this section is 90 % of it, so writing
  the one-pager is mostly copy-editing.
- **Art. 32 security measures**: §6 is the checklist (TLS everywhere, BCrypt,
  Secret Manager, least-privilege IAM, encrypted-at-rest managed DB, backups).
- **Breach duty**: notify CPDP within **72 h** of becoming aware of a
  qualifying breach (cpdp.bg has the form); notify users if high risk. Know
  this before you need it — 72 hours is short when you're also firefighting.
- **Google Play**: privacy policy URL in the listing, **Data safety form**
  (declare: email, precise location, device IDs — collected, not shared, not
  sold), account-deletion URL, and content rating questionnaire. The Data
  safety form must match the privacy policy and the app's actual behavior —
  reviewers cross-check.
- **ePrivacy/cookies**: none — no web frontend, no analytics/ads SDKs. If you
  ever add analytics (Firebase Analytics included — it's one gradle line away
  and easy to add by accident), revisit consent.

### 7.9 Source & map ToS (not GDPR, still legal)

- Scraped sources are official public-interest announcements (ViK, ERP Sever,
  Veolia, VarnaTraffic, АПИ) — republishing factual outage info with the
  source named is low-risk; keep polling intervals polite (current 10 min is
  fine) and identify the bot with a descriptive User-Agent so a source
  operator who objects can find us before blocking us.
- **Nominatim**: usage policy already honored (dedicated `HttpClient` with a
  descriptive UA, 1 req/s throttle) — keep the per-instance cap (A8).
- **Overpass** (kumi.systems mirror): fair-use; current volume (a few street
  geometry queries per new alert) is fine.
- **OSM tiles** in the app: attribution present; revisit provider at scale (F4).

---

## 8. Cost estimate (monthly, EU region, current pricing — verify)

Assumptions behind the numbers: ~4 300 job runs/month (every 10 minutes),
most completing in seconds; API traffic from a small early user base (well
inside Cloud Run's free tier of ~180 k vCPU-seconds and 2 M requests/month);
a few dozen Gemini Flash-Lite calls per day at a few hundred tokens each.

| Item | Estimate |
|---|---|
| **Neon free tier** (was Cloud SQL `db-f1-micro` at €10–15) | **€0** |
| Cloud Run API service (scale-to-zero, low traffic) | €0–3 (mostly inside free tier) |
| Cloud Run ingest job (~4.3 k runs/mo, most finish in seconds when nothing is new) | €0–5 |
| Cloud Scheduler, Secret Manager, Artifact Registry, egress | < €1 |
| Gemini paid tier (Flash-Lite, dozens of short parses/day) | < €1 |
| **Total** | **~€2–10/month** (plus the $300 trial covering the GCP part for the first ~90 days) |

The database was the only meaningful fixed cost; with Neon (§2.4) everything
left is usage-billed and effectively free at this traffic. The estimate's
main sensitivity is the ingest job's runtime per pass — if scrapers get slow
(source site problems, LLM retries), the job-seconds add up, which is another
reason for the 15-minute task timeout and the budget alert (§5.9).

If the app outgrows Neon's free tier (storage or compute hours), the levers
are Neon's Launch plan (~$19/mo) or migrating back to Cloud SQL — plain
Postgres either way, so it's a `pg_dump`/restore, not a rewrite.

---

## 9. Rollout checklist (ordered)

The phases are dependency-ordered: accounts have external lead times so they
start first; all code changes are locally testable so they come before any
cloud resource; infrastructure comes next because the legal artifacts (policy
URL, deletion page) need the production URLs; and the app release is last
because it needs everything else. Within a phase, order is flexible.

**Phase 0 — accounts (can start today, some take days)**
- [ ] R1 Google Cloud + billing, R4 Play Console (identity verification lead time — this is the long pole, start it first)
- [ ] R2 Firebase project decision (promote dev vs. fresh prod), R3 Gemini key
- [ ] R5 Neon account + Frankfurt project (instant — no lead time)

**Phase 1 — code (§3), all testable locally**
- [ ] B1–B6 Gemini parser + `--once` mode (test against real announcements; compare output quality with the qwen3.5 baseline before deleting anything — the free tier makes this comparison cost nothing)
- [ ] A1–A4 Cloud Run compatibility (PORT, forwarded headers, ADC, cleanup endpoint)
- [ ] A5 + F3 account deletion (API + app)
- [ ] Update compose/.env.example/tests; CI green — compose must still bring up a working stack, since it remains the integration test bed

**Phase 2 — infrastructure (§5)**
- [ ] Project, APIs, Artifact Registry, images (§5.1–5.2)
- [ ] Neon project + PostGIS + app role; secrets; service accounts (§5.3–5.5)
- [ ] Deploy API → migrations run → smoke test (register, login, set location) (§5.6)
- [ ] Seed reference data → execute ingest job once → verify an alert flows end-to-end (scrape → Gemini → polygon → API → visible in `GET /api/alerts/recent`) — this single check exercises every integration point in §1.1
- [ ] Scheduler triggers (ingest every 10 min, token cleanup daily) (§5.7)
- [ ] Budget alert, uptime check, error alerting (§5.9)

**Phase 3 — legal (§7) — before anyone real signs up**
- [ ] Privacy policy written + hosted; deletion web page; privacy mailbox
- [ ] Retention decisions written down (Art. 30 one-pager)
- [ ] Gemini flipped to paid tier

**Phase 4 — app release**
- [ ] Release build with `CITYSHIELD_API_URL` + prod `google-services.json`
- [ ] Push notification tested on a physical device against prod — emulators lie about FCM; this must be real hardware
- [ ] Play listing: privacy policy URL, Data safety form, deletion URL, content rating
- [ ] Internal testing track → closed testing → production

**Out of scope for v1** (revisit later, in rough priority order): custom
domain, iOS, CI/CD auto-deploy, Vertex AI migration, multi-instance API
(needs a dedicated migration job + a shared Nominatim throttle first — see
A7/A8), tile provider swap, analytics (which would reopen the consent
question, §7.8).
