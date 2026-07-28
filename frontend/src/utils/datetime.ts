// Alert start/end times are ISO 8601 *local* datetimes ("YYYY-MM-DDTHH:MM:00",
// Europe/Sofia wall clock — see backend shared/datetime.ts). The app parses them
// in device-local time (correct for users in Bulgaria) to decide whether an
// alert is still active and to render its window. Legacy rows may still carry a
// bare "HH:MM" clock time with no date; both shapes are handled here.

import type {AlertWindows, TimeWindow} from '../services/api';
import {TranslationKey} from '../i18n/translations';

type T = (key: TranslationKey) => string;

// Full ISO local datetime, or a bare clock time (the legacy/fallback shape).
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/;
const HM_RE = /^(\d{1,2}):(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export interface AlertTime {
  /** The instant, in device-local time. */
  at: Date;
  /** True for a full datetime; false for a legacy bare clock time (no date). */
  dated: boolean;
}

/**
 * Parse an alert time string. A full ISO datetime is built in local time; a bare
 * "HH:MM" is anchored to `fallbackDay` (defaults to now) and flagged `dated:
 * false` so callers can omit the meaningless date. Returns null when unusable.
 */
export function parseAlertTime(
  value: string | null | undefined,
  fallbackDay: Date = new Date(),
): AlertTime | null {
  if (!value) { return null; }
  const v = value.trim();

  const iso = ISO_RE.exec(v);
  if (iso) {
    const at = new Date(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
      Number(iso[4]), Number(iso[5]), 0, 0);
    return Number.isNaN(at.getTime()) ? null : {at, dated: true};
  }

  const hm = HM_RE.exec(v);
  if (hm) {
    const at = new Date(fallbackDay);
    at.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return Number.isNaN(at.getTime()) ? null : {at, dated: false};
  }

  return null;
}

// ── Display formats ───────────────────────────────────────────────────────────
// All numeric and 24-hour, so they read the same whatever the device locale is
// set to — `toLocaleString` would render English month names and a 12-hour clock
// next to Bulgarian UI text, and would drift from the windows shown by
// `formatTimeRange`.

/** 24-hour clock, e.g. "14:35". Empty string for an unusable date. */
export function formatClock(date: Date): string {
  return Number.isNaN(date.getTime())
    ? ''
    : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Day and month, e.g. "27.07". Empty string for an unusable date. */
export function formatDayMonth(date: Date): string {
  return Number.isNaN(date.getTime())
    ? ''
    : `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
}

/** Full stamp, e.g. "27.07.2026, 14:35". Empty string for an unusable date. */
export function formatDateTime(date: Date): string {
  return Number.isNaN(date.getTime())
    ? ''
    : `${formatDayMonth(date)}.${date.getFullYear()}, ${formatClock(date)}`;
}

function clock(p: AlertTime): string {
  return formatClock(p.at);
}

function dayMonth(p: AlertTime): string {
  return formatDayMonth(p.at);
}

// ── Windows ───────────────────────────────────────────────────────────────────
// The server sends `windows` when the flat start/end pair loses the alert's
// real shape (backend migration 0012): a window repeating on every day of a
// range, or several windows in one day. Everything below treats the pair as the
// fallback and `windows`, when present, as the truth.

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

/** Tolerant reader — the payload is server JSON, not something to trust blindly. */
export function readWindows(raw: unknown): AlertWindows | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const w = raw as Partial<AlertWindows>;
  if (
    typeof w.from_date !== 'string' || !DATE_ONLY_RE.test(w.from_date) ||
    typeof w.to_date !== 'string' || !DATE_ONLY_RE.test(w.to_date) ||
    !Array.isArray(w.daily)
  ) {
    return null;
  }
  const daily = w.daily.filter(
    (d): d is TimeWindow =>
      !!d && typeof d.start === 'string' && CLOCK_RE.test(d.start) &&
      typeof d.end === 'string' && CLOCK_RE.test(d.end),
  );
  return daily.length > 0 ? {from_date: w.from_date, to_date: w.to_date, daily} : null;
}

/** "2026-07-30" → "30.07". */
function dayMonthOf(date: string): string {
  const m = DATE_ONLY_RE.exec(date);
  return m ? `${m[3]}.${m[2]}` : date;
}

/** Local calendar date as "YYYY-MM-DD" — comparable to from_date/to_date. */
function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Local wall clock as "HH:MM" — comparable to a window's bounds. */
function localClock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Yesterday's local date, for a window that started before midnight. */
function previousDate(at: Date): string {
  const d = new Date(at);
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

const inRange = (date: string, w: AlertWindows) =>
  date >= w.from_date && date <= w.to_date;

/**
 * Whether `at` falls inside the schedule: a day within the range AND a clock
 * inside one of that day's windows.
 *
 * A window whose end is not after its start runs past midnight, so it is also
 * live in the small hours of the day after one in range.
 */
export function inWindows(w: AlertWindows, at: Date = new Date()): boolean {
  const date = localDate(at);
  const now = localClock(at);
  const today = inRange(date, w);
  const yesterday = inRange(previousDate(at), w);

  for (const {start, end} of w.daily) {
    if (end > start) {
      if (today && now >= start && now < end) { return true; }
    } else {
      // Crosses midnight: the evening half belongs to a day in range, the
      // morning half to the day after one.
      if (today && now >= start) { return true; }
      if (yesterday && now < end) { return true; }
    }
  }
  return false;
}

/**
 * Human-readable window for display, e.g. "27.07 08:00 – 17:00" (end date shown
 * only when it differs from the start's) or "От 08:00" for an open-ended one.
 * Empty string when neither bound is usable.
 *
 * With `windows`, the envelope is not what the alert means and is not shown:
 * a recurrence reads "30.07–31.07, 08:30 – 17:00 всеки ден" and several windows
 * in one day read "30.07 09:00 – 11:00, 15:00 – 17:00".
 */
export function formatTimeRange(
  startStr: string | null | undefined,
  endStr: string | null | undefined,
  t: T,
  windows?: AlertWindows | null,
): string {
  if (windows && windows.daily.length > 0) {
    const clocks = windows.daily.map(w => `${w.start} – ${w.end}`).join(', ');
    const from = dayMonthOf(windows.from_date);
    return windows.from_date === windows.to_date
      ? `${from} ${clocks}`
      : `${from}–${dayMonthOf(windows.to_date)}, ${clocks} ${t('common.daily')}`;
  }

  const s = parseAlertTime(startStr);
  const e = parseAlertTime(endStr);
  const withDate = (p: AlertTime, showDate: boolean) =>
    showDate && p.dated ? `${dayMonth(p)} ${clock(p)}` : clock(p);

  if (s && e) {
    const showEndDate = e.dated && (!s.dated || !sameDay(s.at, e.at));
    return `${withDate(s, true)} – ${withDate(e, showEndDate)}`;
  }
  if (s) { return `${t('common.from')} ${withDate(s, true)}`; }
  if (e) { return `${t('common.until')} ${withDate(e, true)}`; }
  return '';
}

// An alert with no stated end stays "active" for this long after publication.
const DEFAULT_ACTIVE_MS = 24 * 3600000;

/**
 * When an alert stops being "active", as epoch ms.
 *
 * A full end datetime is authoritative. A legacy bare "HH:MM" is anchored to the
 * publish day and rolls over to the next day when it lands before publication (a
 * window crossing midnight). No usable end → 24h after publication.
 */
export function activeUntil(endTime: string | null | undefined, createdAt: string): number {
  const created = new Date(createdAt);
  const end = parseAlertTime(endTime, created);
  if (!end) { return created.getTime() + DEFAULT_ACTIVE_MS; }
  let ms = end.at.getTime();
  if (!end.dated && ms < created.getTime()) { ms += DEFAULT_ACTIVE_MS; }
  return ms;
}

/**
 * Whether an alert is on right now.
 *
 * With `windows` this is the exact question — a day in the range and a clock in
 * one of its windows — which is the whole reason the server sends them: the
 * envelope of "8:30–17:00 on each of two days" is 30.07 08:30 → 31.07 17:00,
 * and reading that literally left the alert showing as active all night.
 * Without them, the envelope's end is all there is, as before.
 */
export function isAlertActive(
  endTime: string | null | undefined,
  createdAt: string,
  windows?: AlertWindows | null,
  now: Date = new Date(),
): boolean {
  if (windows && windows.daily.length > 0) { return inWindows(windows, now); }
  return activeUntil(endTime, createdAt) > now.getTime();
}
