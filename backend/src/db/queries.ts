// All D1 SQL in one place (SPEC.md §1.1 — no ORM). Timestamps are
// new Date().toISOString() strings, which sort correctly lexicographically.

import type { Env } from "../env";

export interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  latitude: number | null;
  longitude: number | null;
  region_id: number | null;
  street_id: number | null;
  receives_all_alerts: number;
  subscribed_bus_lines: string;
  /** NULL until the address is confirmed via a mailed link (migration 0006). */
  email_verified_at: string | null;
  created_on_utc: string;
  updated_on_utc: string;
}

export interface UserWithNamesRow extends UserRow {
  region_name: string | null;
  street_name: string | null;
}

export interface NamedRow {
  id: number;
  name: string;
  /** Seeded centroid (migration 0005); NULL for names seeded without one. */
  lat: number | null;
  lng: number | null;
}

const nowIso = () => new Date().toISOString();

// ── users ─────────────────────────────────────────────────────────────────────

export function getUserByEmail(env: Env, email: string) {
  // email column is COLLATE NOCASE, so = is case-insensitive.
  return env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email).first<UserRow>();
}

export function getUserById(env: Env, userId: string) {
  return env.DB.prepare(
    `SELECT u.*, r.region_name AS region_name, s.street_name AS street_name
     FROM users u
     LEFT JOIN regions r ON r.id = u.region_id
     LEFT JOIN streets s ON s.id = u.street_id
     WHERE u.user_id = ?`,
  ).bind(userId).first<UserWithNamesRow>();
}

export async function insertUser(env: Env, userId: string, email: string, passwordHash: string) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, password_hash, created_on_utc, updated_on_utc)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(userId, email, passwordHash, now, now).run();
}

export async function updateUserLocation(
  env: Env, userId: string,
  latitude: number, longitude: number,
  regionId: number | null, streetId: number | null,
) {
  await env.DB.prepare(
    `UPDATE users SET latitude = ?, longitude = ?, region_id = ?, street_id = ?, updated_on_utc = ?
     WHERE user_id = ?`,
  ).bind(latitude, longitude, regionId, streetId, nowIso(), userId).run();
}

export async function updateUserBusLines(env: Env, userId: string, busLines: string[]) {
  await env.DB.prepare(
    "UPDATE users SET subscribed_bus_lines = ?, updated_on_utc = ? WHERE user_id = ?",
  ).bind(JSON.stringify(busLines), nowIso(), userId).run();
}

/** GDPR erasure (§1.10): FK cascades remove tokens + preferences. */
export async function deleteUser(env: Env, userId: string) {
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
}

/** Consent withdrawal for location (§2.3): clear lat/lng + region/street. */
export async function clearUserLocation(env: Env, userId: string) {
  await env.DB.prepare(
    `UPDATE users SET latitude = NULL, longitude = NULL, region_id = NULL, street_id = NULL,
     updated_on_utc = ? WHERE user_id = ?`,
  ).bind(nowIso(), userId).run();
}

/** Confirmed control of the address (migration 0006). Idempotent. */
export async function markEmailVerified(env: Env, userId: string) {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_on_utc = ?
     WHERE user_id = ?`,
  ).bind(now, now, userId).run();
}

/**
 * Set a new password hash.
 *
 * Existing JWTs stay valid — they carry no version we could bump, and checking
 * one would cost a DB read on every authenticated request. The exposure is
 * bounded by JWT_EXPIRE_MINUTES (60), which is the tradeoff SPEC.md §1.4 already
 * accepted for logout.
 */
export async function updateUserPassword(env: Env, userId: string, passwordHash: string) {
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, updated_on_utc = ? WHERE user_id = ?",
  ).bind(passwordHash, nowIso(), userId).run();
}

// ── reference tables (module-scope cache, §1.3) ───────────────────────────────

interface RefCache { rows: NamedRow[]; loadedAt: number; }
const REF_TTL_MS = 6 * 60 * 60 * 1000;

interface RefSlot {
  cache: RefCache | null;
  /** In-flight load, so concurrent callers on a cold isolate share one read. */
  pending: Promise<NamedRow[]> | null;
}

const regionsRef: RefSlot = { cache: null, pending: null };
const streetsRef: RefSlot = { cache: null, pending: null };

/**
 * Reference rows are stable, small, and read on nearly every alert path, so
 * they live in module scope for 6 hours (§1.3). The single-flight guard matters
 * on a cold isolate: the streets table is ~3,000 rows, and without it a burst
 * of concurrent requests each paid for its own full-table read.
 */
function loadRef(env: Env, slot: RefSlot, sql: string): Promise<NamedRow[]> {
  if (slot.cache && Date.now() - slot.cache.loadedAt < REF_TTL_MS)
    return Promise.resolve(slot.cache.rows);
  if (slot.pending) return slot.pending;

  slot.pending = env.DB.prepare(sql).all<NamedRow>()
    .then(({ results }) => {
      slot.cache = { rows: results, loadedAt: Date.now() };
      return results;
    })
    .finally(() => { slot.pending = null; });
  return slot.pending;
}

/**
 * Region rows plus their aliases (migration 0013), as one list.
 *
 * An alias is returned as an ordinary row carrying its target's id and
 * coordinates, so every caller — targeting, the map pin, the reverse-geocode
 * assignment in auth.ts — resolves an alternative spelling to the same
 * region_id as the canonical name, with no call-site changes and no second
 * cached array.
 */
export function getRegions(env: Env): Promise<NamedRow[]> {
  return loadRef(env, regionsRef,
    `SELECT id, region_name AS name, lat, lng FROM regions
     UNION ALL
     SELECT r.id, a.alias AS name, r.lat, r.lng
       FROM region_aliases a JOIN regions r ON r.id = a.region_id`);
}

export function getStreets(env: Env): Promise<NamedRow[]> {
  return loadRef(env, streetsRef, "SELECT id, street_name AS name, lat, lng FROM streets");
}

/** Test hook: drop the module-scope reference caches. */
export function clearRefCaches(): void {
  regionsRef.cache = null;
  regionsRef.pending = null;
  streetsRef.cache = null;
  streetsRef.pending = null;
}

// ── notification preferences ──────────────────────────────────────────────────

export interface PreferenceRow {
  category: string;
  is_enabled: number;
}

export async function getPreferenceRows(env: Env, userId: string): Promise<PreferenceRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT category, is_enabled FROM user_notification_preferences WHERE user_id = ?",
  ).bind(userId).all<PreferenceRow>();
  return results;
}

/**
 * Categories are opt-out (§1.9): "enabled" is the default, so the only state
 * worth storing is a disabled row. Re-enabling deletes instead of writing
 * is_enabled = 1 — an enabled row is indistinguishable from no row to every
 * reader, and the table stays small enough that getDisabledUserIds examines
 * only genuine opt-outs.
 */
export async function upsertPreference(env: Env, userId: string, category: string, isEnabled: boolean) {
  if (isEnabled) {
    await env.DB.prepare(
      "DELETE FROM user_notification_preferences WHERE user_id = ? AND category = ?",
    ).bind(userId, category).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO user_notification_preferences (user_id, category, is_enabled, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(user_id, category) DO UPDATE SET
       is_enabled = 0,
       updated_at = excluded.updated_at`,
  ).bind(userId, category, nowIso()).run();
}

// ── alert targeting (user-id queries; only ids are materialized) ─────────────

// D1 rejects a statement with more than 100 bound parameters, and the free plan
// allows only 50 queries per invocation — so a `WHERE x IN (?, ?, …)` over a
// targeted audience is bounded on both sides. Anything that can exceed 100 keys
// is therefore either chunked (below) or rewritten to filter in memory against
// a table small enough to read whole; see getDisabledUserIds / getTokensForUsers.
const MAX_BOUND_PARAMS = 100;

const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Split keys into groups that fit under D1's bound-parameter ceiling. */
function chunkKeys<T>(keys: readonly T[], reservedParams = 0): T[][] {
  const size = MAX_BOUND_PARAMS - reservedParams;
  const chunks: T[][] = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  return chunks;
}

async function idColumn(stmt: D1PreparedStatement): Promise<string[]> {
  const { results } = await stmt.all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export function getUserIdsByRegion(env: Env, regionId: number) {
  return idColumn(env.DB.prepare("SELECT user_id FROM users WHERE region_id = ?").bind(regionId));
}

export function getAllUserIds(env: Env) {
  return idColumn(env.DB.prepare("SELECT user_id FROM users"));
}

export function getReceivesAllUserIds(env: Env) {
  return idColumn(env.DB.prepare("SELECT user_id FROM users WHERE receives_all_alerts = 1"));
}

/**
 * Every user with the best position we hold for them, for the city-wide fan-out.
 *
 * A user's own coordinates are the precise answer; their region's seeded
 * centroid is the fallback for someone who has a region but no point (every
 * region carries coordinates since migration 0005). Both can be NULL — a user
 * who never set a location at all — and the caller decides what that means.
 *
 * The LEFT JOIN is what makes this one query instead of two: the alternative is
 * reading the users table and then the regions table and pairing them in
 * memory, and D1 bills rows examined on what is already the widest path there is.
 */
export async function getUsersForBroadcast(env: Env): Promise<BroadcastRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.latitude, u.longitude, r.lat AS region_lat, r.lng AS region_lng
     FROM users u LEFT JOIN regions r ON r.id = u.region_id`,
  ).all<BroadcastRow>();
  return results;
}

export interface BroadcastRow {
  user_id: string;
  latitude: number | null;
  longitude: number | null;
  region_lat: number | null;
  region_lng: number | null;
}

/** SQL bbox prefilter for point-in-polygon targeting (§1.3). */
export async function getUsersInBBox(
  env: Env, minLat: number, maxLat: number, minLng: number, maxLng: number,
): Promise<Array<{ user_id: string; latitude: number; longitude: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, latitude, longitude FROM users
     WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
  ).bind(minLat, maxLat, minLng, maxLng)
    .all<{ user_id: string; latitude: number; longitude: number }>();
  return results;
}

/**
 * Bus-line subscriptions for the given users.
 *
 * Only users with a non-empty subscription list can be filtered OUT by a
 * bus-line alert (an empty list means "no filter"), so the query reads just
 * those rows and the caller treats anyone absent as unfiltered. That keeps this
 * off the bound-parameter ceiling on the path that needs it most: bus-line
 * alerts are city-wide, so `userIds` there is the entire user base.
 */
export async function getBusLineSubscriptions(
  env: Env, userIds: string[],
): Promise<Array<{ user_id: string; subscribed_bus_lines: string }>> {
  if (userIds.length === 0) return [];
  const wanted = new Set(userIds);
  const { results } = await env.DB.prepare(
    `SELECT user_id, subscribed_bus_lines FROM users
     WHERE subscribed_bus_lines NOT IN ('[]', '')`,
  ).all<{ user_id: string; subscribed_bus_lines: string }>();
  return results.filter((r) => wanted.has(r.user_id));
}

/**
 * Users among `userIds` who explicitly DISABLED the category (opt-out model).
 *
 * Preferences are stored as opt-outs only (migration 0004), so the whole
 * disabled set for one category is small — far smaller than the audience being
 * filtered. Reading it in one query and intersecting in memory costs a single
 * D1 query regardless of audience size, where an IN list would have needed one
 * per 100 users and broken outright past that.
 */
export async function getDisabledUserIds(env: Env, userIds: string[], category: string): Promise<string[]> {
  if (userIds.length === 0) return [];
  const wanted = new Set(userIds);
  const disabled = await idColumn(env.DB.prepare(
    `SELECT user_id FROM user_notification_preferences
     WHERE category = ? AND is_enabled = 0`,
  ).bind(category));
  return disabled.filter((id) => wanted.has(id));
}

/**
 * Users on any of the given streets, in one query — street-level targeting used
 * to issue a separate query per named street, which multiplied D1 usage against
 * the free plan's 50-queries-per-invocation cap for no benefit.
 */
export async function getUserIdsByStreets(
  env: Env, streetIds: number[], regionId: number | null,
): Promise<string[]> {
  if (streetIds.length === 0) return [];
  const ids = new Set<string>();
  // A boulevard can run through several regions — when a region matched too,
  // pairing the two stays the narrower (and safer) targeting. A NULL street_id
  // means "somewhere in this region", so those users stay included.
  for (const chunk of chunkKeys(streetIds, regionId === null ? 0 : 1)) {
    const sql = regionId === null
      ? `SELECT user_id FROM users WHERE street_id IN (${inList(chunk.length)})`
      : `SELECT user_id FROM users WHERE region_id = ?
         AND (street_id IN (${inList(chunk.length)}) OR street_id IS NULL)`;
    const binds = regionId === null ? chunk : [regionId, ...chunk];
    for (const id of await idColumn(env.DB.prepare(sql).bind(...binds))) ids.add(id);
  }
  return [...ids];
}

// ── alerts ────────────────────────────────────────────────────────────────────

export interface AlertRow {
  id: string;
  category: string;
  title: string;
  content: string;
  severity: string;
  start_time: string | null;
  end_time: string | null;
  /** Serialized AlertWindows when the envelope above loses detail, else NULL
   *  (migration 0012). See shared/datetime.ts. */
  windows_json: string | null;
  locations_json: string;
  created_on_utc: string;
  /** Stable "<category>:id=<n>" key back to the source message; NULL for
   *  manual /submit-data injections, which never dedup (migration 0009). */
  source_ref: string | null;
  /** ISO-8601 when the push landed; NULL = delivery still owed (migration 0009). */
  notified_at: string | null;
}

/** The canonical stored row for a source message: its id and delivery state. */
export interface StoredAlert {
  id: string;
  notified_at: string | null;
}

/**
 * Idempotent per source message (migration 0009): keyed by source_ref, a second
 * attempt at the same message finds the stored row instead of duplicating the
 * alert (and re-pushing to everyone). Returns the canonical row's id + delivery
 * state either way, so the caller can tell "freshly stored, push owed" from
 * "already delivered on an earlier tick".
 */
export async function insertAlert(env: Env, row: AlertRow): Promise<StoredAlert> {
  // The conflict target repeats the partial index's WHERE so SQLite matches it.
  await env.DB.prepare(
    `INSERT INTO alerts (id, category, title, content, severity, start_time, end_time, windows_json, locations_json, created_on_utc, source_ref, notified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
  ).bind(row.id, row.category, row.title, row.content, row.severity,
    row.start_time, row.end_time, row.windows_json, row.locations_json, row.created_on_utc,
    row.source_ref, row.notified_at).run();

  // No source_ref → no dedup key (NULLs never conflict under the partial index),
  // so the insert always created our own row; skip the read-back.
  if (row.source_ref === null) return { id: row.id, notified_at: row.notified_at };

  // With a source_ref the insert may have been a no-op (the message was stored
  // on an earlier tick); read back the canonical row to get its id + delivery
  // state, whether we just wrote it or it already existed.
  const stored = await env.DB.prepare(
    "SELECT id, notified_at FROM alerts WHERE source_ref = ?",
  ).bind(row.source_ref).first<StoredAlert>();
  return stored!;
}

/** Stamp delivery time once a push for an alert has landed (idempotency flag). */
export async function markAlertNotified(env: Env, alertId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE alerts SET notified_at = ? WHERE id = ?",
  ).bind(nowIso(), alertId).run();
}

/**
 * Record one more failed push attempt for an alert and return the new total.
 * Persisted per alert (keyed by source_ref across re-drives) so the pipeline can
 * cap retries on a permanently-failing send (migration 0010).
 */
export async function incrementPushAttempts(env: Env, alertId: string): Promise<number> {
  const row = await env.DB.prepare(
    "UPDATE alerts SET push_attempts = push_attempts + 1 WHERE id = ? RETURNING push_attempts",
  ).bind(alertId).first<{ push_attempts: number }>();
  return row?.push_attempts ?? 0;
}

export async function getRecentAlertRows(env: Env, cutoffIso: string, limit: number): Promise<AlertRow[]> {
  // ISO-8601 "Z" strings sort correctly lexicographically (§1.2).
  const { results } = await env.DB.prepare(
    "SELECT * FROM alerts WHERE created_on_utc >= ? ORDER BY created_on_utc DESC LIMIT ?",
  ).bind(cutoffIso, limit).all<AlertRow>();
  return results;
}
