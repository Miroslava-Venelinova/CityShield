# CityShield

**Real-time utility outage alerts for Varna, Bulgaria.**

CityShield is a mobile application that keeps residents informed about power, water, heating, and road disruptions across the city. It continuously monitors official sources — utility companies, local authorities, and infrastructure agencies — and delivers timely, location-aware push notifications together with an interactive map of all active incidents.

---

## Features

- **Real-time alerts** — outage reports are collected directly from official channels and pushed to affected users within minutes of publication.
- **Location-aware notifications** — users set their location once; the system geocodes each incident and notifies only those inside the affected area.
- **Interactive map** — every active incident is drawn on an OpenStreetMap-based map as a precise polygon of the affected zone.
- **Category preferences** — users choose which alert categories they care about (power, water, heating, traffic, roads).
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

1. **Ingestion service** (`backend/`) — a set of Python scrapers, one per source, each running on its own polling interval. New announcements are parsed into structured data by a locally hosted LLM (Ollama), geocoded via Nominatim/Overpass, converted into geographic polygons of the affected area, and submitted to the API. MongoDB tracks which announcements have already been processed.
2. **API** (`ASP/`) — an ASP.NET Core 8 service that stores alerts in PostgreSQL with PostGIS geometry, manages user accounts and JWT authentication, matches incoming alerts against user locations and notification preferences, and delivers push notifications through Firebase Cloud Messaging.
3. **Mobile app** (`frontend/`) — a React Native Android application with an OpenStreetMap-based incident map, an alert feed, a persisted notification inbox, and per-category notification settings.

## Technology stack

| Component | Technologies |
|---|---|
| Ingestion | Python 3, asyncio, BeautifulSoup, Ollama (local LLM), Nominatim & Overpass geocoding, MongoDB |
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
│   └── data/                 MongoDB / PostgreSQL / Overpass access layers
├── ASP/
│   └── CityShieldAPI/        ASP.NET Core solution
│       ├── CityShieldAPI/        Web API (controllers: Auth, Alerts, Tokens, NotificationPreferences)
│       ├── CityShieldAPI.Core/   Business logic and service contracts
│       ├── CityShieldAPI.Data/   EF Core DbContext and migrations
│       └── CityShieldAPI.DTOs/   Request/response models
├── frontend/                 React Native Android app (see frontend/SETUP.md)
└── InstallDependencies.bat   One-click dependency install for all components
```

## Getting started

### Prerequisites

| Requirement | Used by |
|---|---|
| [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) | API |
| [PostgreSQL](https://www.postgresql.org/) with [PostGIS](https://postgis.net/) | API |
| [Python 3](https://www.python.org/downloads/) | Ingestion service |
| [MongoDB](https://www.mongodb.com/try/download/community) | Ingestion service |
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

Configuration is read from `backend/.env` — MongoDB connection, API endpoint, and per-source polling intervals. See `backend/config.py` for every available option and its default. MongoDB and Ollama must be running locally.

### 4. Run the mobile app

Follow **[frontend/SETUP.md](frontend/SETUP.md)** — a complete step-by-step guide covering the Android emulator, the Docker-based build workflow, Firebase configuration, and exactly what to run after each kind of code change.

## API overview

| Controller | Responsibility |
|---|---|
| `AuthController` | Registration, login, JWT issuance, user location |
| `AlertsController` | Alert ingestion (`POST /api/alerts/submit-data`, API-key protected) and retrieval for the app's map/feed (`GET /api/alerts/recent`, with geocoded coordinates and polygons) |
| `TokensController` | FCM device token registration |
| `NotificationPreferencesController` | Per-category notification settings |

Interactive documentation is available via Swagger UI when the API runs in the development environment.

## Further documentation

| Document | Contents |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production deployment: Docker Compose stack, secrets, TLS, first-run seeding, mobile release build |
| [SCRAPING.md](SCRAPING.md) | How each of the five sources is scraped, parsed, deduplicated, and geo-located |
| [DEPENDENCIES.md](DEPENDENCIES.md) | Every library and external API the project depends on, with a full license audit |
| [frontend/SETUP.md](frontend/SETUP.md) | Mobile app development environment |
