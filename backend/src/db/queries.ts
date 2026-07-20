// All D1 SQL in one place (PLAN.MD §1.1 — no ORM). Timestamps are
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

export async function getDeviceTokenMetadata(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT platform, device_name, created_at, last_seen_at FROM device_tokens WHERE user_id = ?",
  ).bind(userId).all<{ platform: string | null; device_name: string | null; created_at: string; last_seen_at: string }>();
  return results;
}

// ── reference tables (module-scope cache, §1.3) ───────────────────────────────

interface RefCache { rows: NamedRow[]; loadedAt: number; }
const REF_TTL_MS = 6 * 60 * 60 * 1000;
let regionsCache: RefCache | null = null;
let streetsCache: RefCache | null = null;

async function loadRef(env: Env, sql: string, cache: RefCache | null): Promise<RefCache> {
  if (cache && Date.now() - cache.loadedAt < REF_TTL_MS) return cache;
  const { results } = await env.DB.prepare(sql).all<NamedRow>();
  return { rows: results, loadedAt: Date.now() };
}

export async function getRegions(env: Env): Promise<NamedRow[]> {
  regionsCache = await loadRef(env, "SELECT id, region_name AS name FROM regions", regionsCache);
  return regionsCache.rows;
}

export async function getStreets(env: Env): Promise<NamedRow[]> {
  streetsCache = await loadRef(env, "SELECT id, street_name AS name FROM streets", streetsCache);
  return streetsCache.rows;
}

/** Test hook: drop the module-scope reference caches. */
export function clearRefCaches(): void {
  regionsCache = null;
  streetsCache = null;
}

// ── device tokens ─────────────────────────────────────────────────────────────

export async function upsertDeviceToken(
  env: Env, userId: string, token: string,
  platform: string | null, deviceName: string | null,
) {
  const now = nowIso();
  // Port of FcmTokenService.UpsertTokenAsync: an existing row is re-owned by
  // the caller and refreshed; platform/deviceName only overwrite when provided.
  await env.DB.prepare(
    `INSERT INTO device_tokens (user_id, token, platform, device_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id,
       last_seen_at = excluded.last_seen_at,
       platform = COALESCE(excluded.platform, device_tokens.platform),
       device_name = COALESCE(excluded.device_name, device_tokens.device_name)`,
  ).bind(userId, token, platform, deviceName, now, now).run();
}

export async function deleteDeviceToken(env: Env, userId: string, token: string) {
  await env.DB.prepare("DELETE FROM device_tokens WHERE user_id = ? AND token = ?")
    .bind(userId, token).run();
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

export async function upsertPreference(env: Env, userId: string, category: string, isEnabled: boolean) {
  await env.DB.prepare(
    `INSERT INTO user_notification_preferences (user_id, category, is_enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, category) DO UPDATE SET
       is_enabled = excluded.is_enabled,
       updated_at = excluded.updated_at`,
  ).bind(userId, category, isEnabled ? 1 : 0, nowIso()).run();
}

// ── alert targeting (user-id queries; only ids are materialized) ─────────────

const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");

async function idColumn(stmt: D1PreparedStatement): Promise<string[]> {
  const { results } = await stmt.all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export function getUserIdsByRegion(env: Env, regionId: number) {
  return idColumn(env.DB.prepare("SELECT user_id FROM users WHERE region_id = ?").bind(regionId));
}

export function getUserIdsByRegionAndStreet(env: Env, regionId: number, streetId: number) {
  return idColumn(env.DB.prepare(
    "SELECT user_id FROM users WHERE region_id = ? AND street_id = ?").bind(regionId, streetId));
}

export function getAllUserIds(env: Env) {
  return idColumn(env.DB.prepare("SELECT user_id FROM users"));
}

export function getReceivesAllUserIds(env: Env) {
  return idColumn(env.DB.prepare("SELECT user_id FROM users WHERE receives_all_alerts = 1"));
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

export async function getBusLineSubscriptions(
  env: Env, userIds: string[],
): Promise<Array<{ user_id: string; subscribed_bus_lines: string }>> {
  if (userIds.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT user_id, subscribed_bus_lines FROM users WHERE user_id IN (${inList(userIds.length)})`,
  ).bind(...userIds).all<{ user_id: string; subscribed_bus_lines: string }>();
  return results;
}

/** Users among `userIds` who explicitly DISABLED the category (opt-out model). */
export async function getDisabledUserIds(env: Env, userIds: string[], category: string): Promise<string[]> {
  if (userIds.length === 0) return [];
  return idColumn(env.DB.prepare(
    `SELECT user_id FROM user_notification_preferences
     WHERE category = ? AND is_enabled = 0 AND user_id IN (${inList(userIds.length)})`,
  ).bind(category, ...userIds));
}

export async function getTokensForUsers(env: Env, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT token FROM device_tokens WHERE user_id IN (${inList(userIds.length)})`,
  ).bind(...userIds).all<{ token: string }>();
  return results.map((r) => r.token);
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
  locations_json: string;
  created_on_utc: string;
}

export async function insertAlert(env: Env, row: AlertRow) {
  await env.DB.prepare(
    `INSERT INTO alerts (id, category, title, content, severity, start_time, end_time, locations_json, created_on_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.id, row.category, row.title, row.content, row.severity,
    row.start_time, row.end_time, row.locations_json, row.created_on_utc).run();
}

export async function getRecentAlertRows(env: Env, cutoffIso: string, limit: number): Promise<AlertRow[]> {
  // ISO-8601 "Z" strings sort correctly lexicographically (§1.2).
  const { results } = await env.DB.prepare(
    "SELECT * FROM alerts WHERE created_on_utc >= ? ORDER BY created_on_utc DESC LIMIT ?",
  ).bind(cutoffIso, limit).all<AlertRow>();
  return results;
}
