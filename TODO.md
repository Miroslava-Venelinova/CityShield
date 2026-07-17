# TODO — Phase 1 code changes from PLAN.md (§3)

Everything here is locally testable; cloud infra (§5) comes later.
Task IDs (A1…, B1…, F1…) refer to sections in [PLAN.md](PLAN.md).

## Backend — Python ingestion (`backend/`)

- [x] **B3** `config.py`: add `AI_PROVIDER` (`ollama`|`gemini`), `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash-lite`)
- [x] **B8** `config.py`: add `POSTGRES_SSLMODE` (default `prefer`); pass it through the three connect sites (`state_repository.py`, `services/common.py`, `seeding/seeder.py`)
- [x] **B1/B2** `ai_parser.py`: Gemini path via `google-genai` (`response_mime_type=application/json` + `response_schema`), provider dispatch on `AI_PROVIDER`, exponential backoff honoring 429/`Retry-After`, same `ai_parse()` signature and None-on-failure contract, persistent cache untouched
- [x] **B4** `run.py`: `--once` argparse flag — one pass of every service, then exit 0 (keep infinite loops as default)
- [x] **B5** `run.py`: gate `FileHandler("backend.log")` on `LOG_TO_FILE` config (off in cloud)
- [x] **B6** `requirements.txt`: add `google-genai` (keep `ollama` for the local provider)
- [x] `backend/.env.example`: add `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `POSTGRES_SSLMODE`, `LOG_TO_FILE`
- [x] Tests: ai_parser provider dispatch + retry behavior, `--once` mode, new config fields
- [x] Run `pytest` — green (111 passed)

## API — ASP.NET (`ASP/CityShieldAPI`)

- [x] **A1** `Program.cs`: bind `$PORT` (fallback 5276)
- [x] **A2** `Program.cs`: `UseForwardedHeaders` (proto + for); skip `UseHttpsRedirection()` behind proxy (gate on env)
- [x] **A3** `Program.cs`: Firebase falls back to Application Default Credentials when no `fcm.json` / `Firebase__CredentialsFile`
- [x] **A4** maintenance endpoint `POST /api/maintenance/cleanup-tokens` (ingest-key guarded); make `StaleTokenCleanupService` registration opt-in via config (kept for compose)
- [x] **A5** `DELETE /api/auth/me` (JWT-authed): delete user + cascade tokens/preferences/bus-line subscriptions
- [x] **A6** `GET /healthz`: 200 after `SELECT 1`, unauthenticated
- [x] Tests: account deletion, cleanup endpoint auth, healthz
- [x] Run `dotnet test` — green (77 unit + 21 integration tests pass, incl. 4 new: delete-me ×2, healthz, cleanup-tokens)

## Frontend — React Native (`frontend/`)

- [x] **F3a** `api.ts`: `deleteAccount` call (`DELETE /api/auth/me`)
- [x] **F3b** ProfileScreen: "Delete account" action with confirmation → call API → clear local state → login screen
- [x] **F3c** ProfileScreen: privacy policy link (URL configurable/constant)
- [x] TypeScript check (`tsc --noEmit`) — green
- [x] **F1** (code part): fixed undefined `${usesCleartextTraffic}` manifest placeholder (now `true` in debug, `false` in release — previously any Android build failed at manifest merge); moved the 10.0.2.2 cleartext allowance to a debug-only `network_security_config.xml`, release config permits no cleartext at all. *Still pending (Phase 4): build release with `CITYSHIELD_API_URL=https://<cloud-run-url>`.*
- [ ] **F2** (release config, no code): production `google-services.json` in `frontend/android/app/` — needs the prod Firebase project, deferred to Phase 2

## Repo / tooling

- [x] `docker-compose.prod.yml`: `ollama` behind a compose profile (`COMPOSE_PROFILES=ollama`, default in `.env.example`); `AI_PROVIDER`/`GEMINI_API_KEY`/`GEMINI_MODEL` passed to ingestion; `Proxy__Enabled` passed to the API (documented reverse-proxy setup); validated with `docker compose config` in both profile modes
- [x] Root `.env.example`: Gemini vars added; Secret Manager values annotated `[Secret Manager] <secret-name>`
- [x] README: production section retitled to self-hosting, points to PLAN.md

## Deferred (needs cloud resources — Phase 2+)

- Seeder run against Neon (B7), gcloud setup (§5), Scheduler triggers, monitoring (§5.9), legal artifacts (§7), Play release (Phase 4)
