# CityShield

**Real-time utility outage alerts for Varna, Bulgaria.**

CityShield is a mobile application that keeps residents informed about power, water, heating, and road disruptions across the city. It continuously monitors official sources — utility companies, local authorities, and infrastructure agencies — and delivers timely, location-aware push notifications together with an interactive map of all active incidents.

---

## Features

- **Real-time alerts** — outage reports are collected directly from official channels and pushed to affected users within minutes of publication.
- **Location-aware notifications** — users set their location once; the system geocodes each incident and notifies only those inside the affected area.
- **Interactive map** — every active incident is drawn on an OpenStreetMap-based map as a precise polygon of the affected zone.
- **Category preferences** — users choose which alert categories they care about (power, water, heating, traffic, roads).
- **Bus-line subscriptions** — public-transport users can follow specific bus lines and get notified only about disruptions affecting those lines.
- **Trusted data only** — information comes exclusively from official sources, ensuring accuracy and transparency.

## Data sources

| Category | Source |
|---|---|
| Water supply | ViK Varna (vikvarna.com) |
| Electricity | Energo-Pro / ERP Sever (erpsever.bg) |
| District heating | Veolia Energy Varna (energy-varna.bg) |
| Public transport & traffic | VarnaTraffic (varnatraffic.com) |
| National roads | Road Infrastructure Agency (api.bg) |

## Architecture

The system consists of three components that form a pipeline from raw source data to a notification on the user's phone:

```
┌─────────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│      backend/       │     │        ASP/          │     │     frontend/      │
│  Python ingestion   │────►│   ASP.NET Core API   │────►│  React Native app  │
│                     │     │                      │     │                    │
│ • scrapes sources   │     │ • JWT auth           │     │ • interactive map  │
│ • LLM parsing       │     │ • alert storage      │     │ • alert feed       │
│ • geocoding         │     │ • geospatial match   │     │ • push inbox       │
│ • polygon building  │     │ • FCM push delivery  │     │ • preferences      │
└─────────────────────┘     └──────────────────────┘     └────────────────────┘
```

1. **Ingestion service** (`backend/`) — a set of Python scrapers, one per source, each running on its own polling interval. New announcements are parsed into structured data by a locally hosted LLM (Ollama), geocoded via Nominatim/Overpass, converted into geographic polygons of the affected area, and submitted to the API. Crawl state (which announcements have already been processed) lives in PostgreSQL alongside the reference data.
2. **API** (`ASP/`) — an ASP.NET Core 8 service that stores alerts in PostgreSQL with PostGIS geometry, manages user accounts and JWT authentication, matches incoming alerts against user locations and notification preferences, and delivers push notifications through Firebase Cloud Messaging.
3. **Mobile app** (`frontend/`) — a React Native Android application with an OpenStreetMap-based incident map, an alert feed, a persisted notification inbox, and per-category notification settings.

## Technology stack

| Component | Technologies |
|---|---|
| Ingestion | Python 3, asyncio, BeautifulSoup, Ollama (local LLM), Nominatim & Overpass geocoding, PostgreSQL |
| API | ASP.NET Core 8, Entity Framework Core, PostgreSQL + PostGIS (NetTopologySuite), JWT authentication, BCrypt, Firebase Admin SDK, Swagger |
| Mobile app | React Native 0.85, React 19, React Navigation, Leaflet in a WebView (OpenStreetMap tiles), Firebase Cloud Messaging |
| Tooling | Docker-based Android build environment (Node 22, JDK 17, Android SDK 35) |

## Repository layout

```
CityShield/
├── backend/                  Python ingestion service
│   ├── run.py                Entry point — runs all scrapers concurrently
│   ├── config.py             Central configuration (reads backend/.env)
│   ├── services/             One module per data source
│   ├── scraping/             HTTP scraping utilities
│   ├── processing/           LLM parsing, geocoding, polygon building
│   ├── data/                 PostgreSQL / Overpass access layers
│   ├── scripts/              Manual test & debugging scripts
│   └── tests/                Pytest suite (unit + integration)
├── ASP/
│   └── CityShieldAPI/        ASP.NET Core solution
│       ├── CityShieldAPI/              Web API (controllers: Auth, Alerts, Tokens, NotificationPreferences)
│       ├── CityShieldAPI.Core/         Business logic and service contracts
│       ├── CityShieldAPI.Data/         EF Core DbContext and migrations
│       ├── CityShieldAPI.Data.Models/  Entity classes
│       ├── CityShieldAPI.DTOs/         Request/response models
│       ├── CityShieldAPI.Common/       Shared configuration types
│       └── CityShieldAPI.Tests/        xUnit test suite
├── frontend/                 React Native Android app (see frontend/SETUP.md)
├── docker-compose.prod.yml   Production stack (PostgreSQL, Ollama, API, ingestion)
├── .env.example              Secrets template for the production stack
└── InstallDependencies.bat   One-click dependency install for all components
```

## Getting started

### Prerequisites

| Requirement | Used by |
|---|---|
| [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) | API |
| [PostgreSQL](https://www.postgresql.org/) with [PostGIS](https://postgis.net/) | API |
| [Python 3](https://www.python.org/downloads/) | Ingestion service |
| [Ollama](https://ollama.com/) | Ingestion service (LLM parsing) |
| [Docker Desktop](https://www.docker.com/products/docker-desktop) + [Android Studio](https://developer.android.com/studio) | Mobile app |
| A [Firebase](https://console.firebase.google.com) project | Push notifications |

### 1. Install dependencies

Run from the repository root:

```cmd
InstallDependencies.bat
```

This creates the Python virtual environment (`backend/.venv`), installs the frontend npm packages, and restores the .NET solution. Steps whose tools are missing from PATH are skipped with a notice.

### 2. Run the API

```cmd
dotnet run --project ASP\CityShieldAPI\CityShieldAPI
```

Or open `ASP/CityShieldAPI/CityShieldAPI.sln` in Visual Studio and press **Run**. The API listens on port **5276** and exposes Swagger UI in development.

Before the first run:
- Set the PostgreSQL connection string in `appsettings.json` and apply the EF Core migrations (`dotnet ef database update`).
- Place a Firebase service-account key file at the project root as `fcm.json`.

> **Note (July 2026):** the initial migration was renamed from `20260526181336_Init`
> to `20260628072606_InitialCreate`. A database created before that rename will fail
> `database update` / `Database__AutoMigrate` with *"relation already exists"* —
> drop and recreate that database (dev data only; no production deployments predate
> the rename).

### 3. Run the ingestion service

```cmd
cd backend
.venv\Scripts\python run.py
```

Configuration is read from `backend/.env` — PostgreSQL connection, API endpoint, log level, and per-source polling intervals. See `backend/config.py` for every available option and its default. PostgreSQL and Ollama must be running locally.

### 4. Run the mobile app

Follow **[frontend/SETUP.md](frontend/SETUP.md)** — a complete step-by-step guide covering the Android emulator, the Docker-based build workflow, Firebase configuration, and exactly what to run after each kind of code change.

## Running the tests

- **Ingestion service** — from `backend/`: `.venv\Scripts\python -m pytest`. Tests marked `integration` need a live PostgreSQL; skip them with `-m "not integration"`. Test dependencies: `.venv\Scripts\pip install -r requirements-dev.txt`.
- **API** — `dotnet test ASP\CityShieldAPI\CityShieldAPI.sln`. The integration tests start a disposable PostGIS container via Testcontainers, so Docker must be running.
- **Mobile app** — from `frontend/`: `npm run lint` and `npm run typecheck`.

The same checks run in GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) on every push and pull request.

## API overview

| Controller | Responsibility |
|---|---|
| `AuthController` | Registration, login, JWT issuance, user location |
| `AlertsController` | Alert ingestion (`POST /api/alerts/submit-data`, API-key protected) and retrieval for the app's map/feed (`GET /api/alerts/recent`, with geocoded coordinates and polygons) |
| `TokensController` | FCM device token registration |
| `NotificationPreferencesController` | Per-category notification settings and bus-line subscriptions |

Interactive documentation is available via Swagger UI when the API runs in the development environment.

## Production deployment

[docker-compose.prod.yml](docker-compose.prod.yml) runs the entire server-side stack — PostgreSQL/PostGIS, Ollama, the API, and the ingestion service:

```cmd
copy .env.example .env        &rem then fill in the secrets
docker compose -f docker-compose.prod.yml up -d --build
```

Place the Firebase service-account key at `./fcm.json` before starting, and follow the first-run steps (pulling the Ollama model, seeding the street database) in the compose file's header comments. TLS is not handled by the stack — run a reverse proxy (Caddy, nginx, Traefik) in front of the API.

## Further documentation

| Document | Contents |
|---|---|
| [frontend/SETUP.md](frontend/SETUP.md) | Mobile app development environment |
