# ⚠️ DEPRECATED — do not use

Everything in this folder is the **old CityShield backend**. It has been
**replaced by the Cloudflare Worker** now living in [`../backend/`](../backend/).

None of this code is deployed, built, tested in CI, or maintained. It is kept
only for historical reference during the Cloudflare migration and can be deleted
once the migration is fully closed out (see `PLAN.MD` §4 parity checklist).

## Contents

| Path | What it was |
| --- | --- |
| `backend/` | Python ingestion + API service (FastAPI/psycopg3, Ollama structured outputs, Postgres/PostGIS). The most recent pre-Cloudflare backend ("Fable edition"). |
| `ASP/` | Earlier ASP.NET Core API (`CityShieldAPI` solution). Superseded even before the Python backend. |
| `docker-compose.prod.yml` | Production stack (Postgres + Ollama + ingestion + api) for the self-hosted backends above. Not used by the Cloudflare deployment. |
| `.env.example` | Secrets template for `docker-compose.prod.yml`. Replaced by `../backend/.dev.vars.example` + `wrangler secret put`. |
| `InstallDependencies.bat` | Windows dev-setup script for the Python/.NET backends. |
| `README.md` | The pre-Cloudflare project README. A new README will replace it at the repo root. |

## What replaced it

The current backend is a single TypeScript Cloudflare Worker (D1, Workers AI,
Cron Triggers) in [`../backend/`](../backend/). See `PLAN.MD` and `TODO.md` at the
repo root for the migration record.
