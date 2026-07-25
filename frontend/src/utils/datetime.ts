// Alert start/end times are ISO 8601 *local* datetimes ("YYYY-MM-DDTHH:MM:00",
// Europe/Sofia wall clock — see backend shared/datetime.ts). The app parses them
// in device-local time (correct for users in Bulgaria) to decide whether an
// alert is still active and to render its window. Legacy rows may still carry a
// bare "HH:MM" clock time with no date; both shapes are handled here.

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

function clock(p: AlertTime): string {
  return `${pad(p.at.getHours())}:${pad(p.at.getMinutes())}`;
}

function dayMonth(p: AlertTime): string {
  return `${pad(p.at.getDate())}.${pad(p.at.getMonth() + 1)}`;
}

/**
 * Human-readable window for display, e.g. "27.07 08:00 – 17:00" (end date shown
 * only when it differs from the start's) or "От 08:00" for an open-ended one.
 * Empty string when neither bound is usable.
 */
export function formatTimeRange(
  startStr: string | null | undefined,
  endStr: string | null | undefined,
  t: T,
): string {
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
