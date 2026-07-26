-- CityShield D1 schema — SPEC.md §1.2 (port of the EF model + Python-side tables).
-- Reference tables first so the users FKs resolve under PRAGMA foreign_keys.

CREATE TABLE regions ( id INTEGER PRIMARY KEY AUTOINCREMENT, region_name TEXT NOT NULL UNIQUE );
CREATE TABLE streets ( id INTEGER PRIMARY KEY AUTOINCREMENT, street_name TEXT NOT NULL UNIQUE );

CREATE TABLE users (
    user_id              TEXT PRIMARY KEY,             -- uuid v4
    email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,                -- pbkdf2 format, §1.4
    latitude             REAL,
    longitude            REAL,
    region_id            INTEGER REFERENCES regions(id),
    street_id            INTEGER REFERENCES streets(id),
    receives_all_alerts  INTEGER NOT NULL DEFAULT 0,   -- bool
    subscribed_bus_lines TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
    created_on_utc       TEXT NOT NULL,                -- ISO-8601 UTC ("...Z")
    updated_on_utc       TEXT NOT NULL
);
CREATE INDEX ix_users_region_street ON users(region_id, street_id);
CREATE INDEX ix_users_lat_lng ON users(latitude, longitude);

CREATE TABLE device_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token        TEXT NOT NULL UNIQUE,
    platform     TEXT,            -- "ios" | "android" | "web"
    device_name  TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
CREATE INDEX ix_device_tokens_user ON device_tokens(user_id);

CREATE TABLE user_notification_preferences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, category)
);

CREATE TABLE alerts (
    id             TEXT PRIMARY KEY,      -- uuid v4
    category       TEXT NOT NULL,         -- vik | epro | heating | vt
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    severity       TEXT NOT NULL DEFAULT 'info',
    start_time     TEXT,                  -- free-form "HH:MM" as scraped
    end_time       TEXT,
    locations_json TEXT NOT NULL DEFAULT '[]',   -- enriched locations, §1.5
    created_on_utc TEXT NOT NULL
);
CREATE INDEX ix_alerts_created ON alerts(created_on_utc);
CREATE INDEX ix_alerts_category ON alerts(category);

CREATE TABLE crawl_state (
    source     TEXT PRIMARY KEY,
    last_id    INTEGER NOT NULL DEFAULT 0,
    seen_ids   TEXT NOT NULL DEFAULT '[]',       -- JSON array, capped at 500 (port of MAX_SEEN_IDS)
    updated_at TEXT NOT NULL
);

CREATE TABLE geocode_cache (                     -- replaces the in-memory Nominatim cache, §1.5
    query       TEXT PRIMARY KEY,
    lat         REAL,                            -- NULL = cached miss
    lng         REAL,
    resolved_at TEXT NOT NULL
);
