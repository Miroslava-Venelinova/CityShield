// crawl_state repository on D1 — port of data/postgres/state_repository.py.
// Two shapes: a numeric cursor (vik, heating) and a seen-id set (vt, epro;
// JSON array capped at MAX_SEEN_IDS).
//
// Read failures return null, distinct from "no row yet" (0 / []). The
// distinction is load-bearing: a lost cursor read that degrades to 0, or a lost
// seen-id read that degrades to [], makes every already-processed message look
// new — and the source re-ingests and re-push-notifies messages users were
// alerted about hours ago. A source that cannot read its state must skip the
// tick instead, since the next tick costs at most five minutes of latency.

import type { Env } from "../env";

// Sources only ever compare against ids still visible on the listing page,
// so old ids can be dropped; keeping the newest few hundred stops the array
// growing forever.
export const MAX_SEEN_IDS = 500;

const nowIso = () => new Date().toISOString();

/**
 * Whether a source has any stored state. First run ever → false, and sources
 * bootstrap by marking the current listing as known WITHOUT processing it —
 * otherwise a fresh deploy would slowly ingest (and push-notify) the entire
 * visible history of every source.
 */
export async function hasStateRow(env: Env, source: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT 1 FROM crawl_state WHERE source = ?")
      .bind(source).first();
    return row !== null;
  } catch (e) {
    console.error(`[state] hasStateRow(${source}) failed: ${e}`);
    return true; // fail safe: don't re-bootstrap (and re-skip) on a DB hiccup
  }
}

/** Cursor value, 0 when there is no row yet, or null when the read failed. */
export async function getLastId(env: Env, source: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare("SELECT last_id FROM crawl_state WHERE source = ?")
      .bind(source).first<{ last_id: number }>();
    if (!row) {
      console.warn(`[state] ${source} state row not found — defaulting to 0.`);
      return 0;
    }
    return row.last_id;
  } catch (e) {
    console.error(`[state] getLastId(${source}) failed: ${e}`);
    return null;
  }
}

export async function writeLastId(env: Env, source: string, lastId: number): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO crawl_state (source, last_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
    ).bind(source, lastId, nowIso()).run();
  } catch (e) {
    console.error(`[state] writeLastId(${source}) failed: ${e}`);
  }
}

/** Seen ids, [] when there is no row yet, or null when the read failed. */
export async function getSeenIds(env: Env, source: string): Promise<string[] | null> {
  try {
    const row = await env.DB.prepare("SELECT seen_ids FROM crawl_state WHERE source = ?")
      .bind(source).first<{ seen_ids: string }>();
    if (!row) {
      console.warn(`[state] ${source} state row not found — defaulting to [].`);
      return [];
    }
    const parsed = JSON.parse(row.seen_ids);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch (e) {
    console.error(`[state] getSeenIds(${source}) failed: ${e}`);
    return null;
  }
}

/** Append new ids (deduplicated, order-preserving), keep the newest MAX_SEEN_IDS. */
export function mergeSeenIds(existing: string[], newIds: string[]): string[] {
  const merged = [...existing];
  const known = new Set(existing);
  for (const id of newIds) {
    if (!known.has(id)) {
      merged.push(id);
      known.add(id);
    }
  }
  return merged.slice(-MAX_SEEN_IDS);
}

export async function addSeenIds(env: Env, source: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    // Read-merge-write: each source has a single writer (one cron tick at a
    // time), so this is not racy in practice.
    const existing = await getSeenIds(env, source);
    if (existing === null) {
      // Writing a merge onto a failed read would drop every id already stored,
      // re-opening the whole seen set for reprocessing.
      console.error(`[state] addSeenIds(${source}) aborted — could not read existing ids.`);
      return;
    }
    const merged = mergeSeenIds(existing, ids);
    if (merged.length === existing.length && merged.every((v, i) => v === existing[i])) return;
    await env.DB.prepare(
      `INSERT INTO crawl_state (source, seen_ids, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET seen_ids = excluded.seen_ids, updated_at = excluded.updated_at`,
    ).bind(source, JSON.stringify(merged), nowIso()).run();
  } catch (e) {
    console.error(`[state] addSeenIds(${source}) failed: ${e}`);
  }
}
