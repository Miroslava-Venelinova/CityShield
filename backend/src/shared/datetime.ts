// Outage start/end times used to be free-form "HH:MM" strings anchored to the
// alert's publish day on the client. Sources like epro schedule interruptions
// days ahead ("От 27.07.2026 г. до 29.07.2026 г."), so a bare clock time is
// ambiguous and mis-dates the active window. Times are now ISO 8601 *local*
// datetimes — "YYYY-MM-DDT HH:MM:00", Europe/Sofia wall clock, seconds always
// 00 — which the app parses directly to decide whether an alert is still active.
//
// "Local" carries no offset on purpose: the app serves Varna, users' devices sit
// in Bulgaria's timezone, and `new Date("2026-07-27T08:00:00")` parses in device
// local — correct for them. If the audience ever widens, switch to an explicit
// +02:00/+03:00 offset here and everything downstream keeps working.

/** Today's calendar date in Europe/Sofia as "YYYY-MM-DD" (the default when a
 *  message states a time but no date). */
export function sofiaToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; timeZone shifts to Sofia's calendar day, which
  // can differ from UTC's for a few hours around midnight.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// "YYYY-MM-DD" + "T"/" " + "H:MM" or "HH:MM", optional ":SS" we discard.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/;
// Bare clock time, the fallback when the model omits the date it was told to add.
const HM_RE = /^(\d{1,2}):(\d{2})$/;

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Coerce a model-produced time into the canonical ISO local datetime, or null.
 *
 * Accepts a full ISO datetime (date trusted as-is) or a bare "HH:MM" (dated to
 * `today`, the Sofia calendar day). Seconds are forced to 00. Anything else —
 * or an out-of-range field — becomes null rather than poisoning storage, so a
 * mis-parse degrades to "no time" exactly as before, never a wrong window.
 */
export function normalizeDateTime(value: string | null | undefined, today: string): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return null;

  let y: string, mo: string, d: string, h: string, mi: string;
  const iso = ISO_RE.exec(v);
  if (iso) {
    y = iso[1]!; mo = iso[2]!; d = iso[3]!; h = iso[4]!; mi = iso[5]!;
  } else {
    const hm = HM_RE.exec(v);
    if (!hm) return null;
    h = hm[1]!; mi = hm[2]!;
    const [py, pmo, pd] = today.split("-");
    if (!py || !pmo || !pd) return null;
    y = py; mo = pmo; d = pd;
  }

  const MO = Number(mo), D = Number(d), H = Number(h), MI = Number(mi);
  if (!(MO >= 1 && MO <= 12 && D >= 1 && D <= 31 && H >= 0 && H <= 23 && MI >= 0 && MI <= 59)) {
    return null;
  }
  return `${y.padStart(4, "0")}-${p2(MO)}-${p2(D)}T${p2(H)}:${p2(MI)}:00`;
}

// ── Schedules ────────────────────────────────────────────────────────────────
// A single start/end pair cannot say what these sources actually publish. epro
// writes "От 30.07 до 31.07 В периода 8:30 до 17:00", which means 08:30–17:00
// *on each day* — stored as one flat pair it read as 55 continuous hours, and
// the app showed the outage as active all night. Others list two windows in one
// day ("от 9 до 11 и от 15 до 17"), which the pair flattened into 09:00–17:00.
//
// So the model is asked for a schedule instead, and the flat pair is derived
// from it as the ENVELOPE — first date at the first start clock, last date at
// the last end clock. Everything downstream that only understands the pair keeps
// working unchanged; `windows` carries the detail for those that don't.

/** One clock window, "HH:MM" both ends. */
export interface TimeWindow {
  start: string;
  end: string;
}

/** The stored shape of `alerts.windows_json` (migration 0012). */
export interface AlertWindows {
  /** First day the windows apply to, "YYYY-MM-DD". */
  from_date: string;
  /** Last day, inclusive — equal to from_date for a single-day alert. */
  to_date: string;
  /** Windows repeating on EVERY day of the range, sorted by start clock. */
  daily: TimeWindow[];
}

export interface NormalizedSchedule {
  /** Envelope start: from_date at the earliest start clock. */
  start_time: string | null;
  /** Envelope end: to_date at the latest end clock. */
  end_time: string | null;
  /** Null whenever the envelope already says everything (one window, one day). */
  windows: AlertWindows | null;
}

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
// Bulgarian sources write day.month.year; the model is asked for ISO but a
// misformatted date is better coerced than dropped.
const BG_DATE_RE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\.?$/;

/** Coerce a model-produced date to "YYYY-MM-DD", or null. */
function normalizeDate(value: unknown, today: string): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;

  let y: number, mo: number, d: number;
  const iso = DATE_RE.exec(v);
  if (iso) {
    y = Number(iso[1]); mo = Number(iso[2]); d = Number(iso[3]);
  } else {
    const bg = BG_DATE_RE.exec(v);
    if (!bg) return null;
    d = Number(bg[1]); mo = Number(bg[2]); y = bg[3] ? Number(bg[3]) : Number(today.slice(0, 4));
  }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${String(y).padStart(4, "0")}-${p2(mo)}-${p2(d)}`;
}

/** Coerce a model-produced clock time to "HH:MM", or null. Accepts a full ISO datetime. */
function normalizeClock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;

  const iso = ISO_RE.exec(v);
  if (iso) return `${p2(Number(iso[4]))}:${iso[5]}`;
  const hm = HM_RE.exec(v);
  if (!hm) return null;
  const h = Number(hm[1]), mi = Number(hm[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return `${p2(h)}:${p2(mi)}`;
}

/** "YYYY-MM-DD" shifted by whole days, in UTC so no timezone can move the date. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${shifted.getUTCFullYear()}-${p2(shifted.getUTCMonth() + 1)}-${p2(shifted.getUTCDate())}`;
}

/**
 * Turn the model's `schedule` object into the stored envelope plus, when the
 * envelope loses information, the windows themselves.
 *
 * Never throws and never trusts a field: anything unusable degrades to "no
 * time", exactly as normalizeDateTime does, because a wrong active window is
 * worse than none.
 */
export function normalizeSchedule(raw: unknown, today: string): NormalizedSchedule {
  const none: NormalizedSchedule = { start_time: null, end_time: null, windows: null };
  if (raw === null || typeof raw !== "object") return none;
  const schedule = raw as { from_date?: unknown; to_date?: unknown; windows?: unknown };

  const windows: Array<{ start: string | null; end: string | null }> = [];
  if (Array.isArray(schedule.windows)) {
    for (const w of schedule.windows) {
      if (w === null || typeof w !== "object") continue;
      const start = normalizeClock((w as { start?: unknown }).start);
      const end = normalizeClock((w as { end?: unknown }).end);
      if (start !== null || end !== null) windows.push({ start, end });
    }
  }
  // Sorted, so "the first start" and "the last end" are the envelope's bounds
  // whatever order the model listed them in. An open-started window sorts first.
  windows.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));

  // A message that states times but no date means today — the same default the
  // prompt gives the model, applied again here in case it didn't.
  const from = normalizeDate(schedule.from_date, today) ?? (windows.length > 0 ? today : null);
  if (from === null) return none;
  const parsedTo = normalizeDate(schedule.to_date, today) ?? from;
  // A range that ends before it starts is a misparse; collapse it to one day
  // rather than storing a window that can never be active.
  const to = parsedTo < from ? from : parsedTo;

  const startClock = windows.find((w) => w.start !== null)?.start ?? null;
  let endClock: string | null = null;
  for (const w of windows) if (w.end !== null) endClock = w.end;

  // A single-day window whose end clock precedes its start crosses midnight.
  const endDate = from === to && startClock !== null && endClock !== null && endClock < startClock
    ? addDays(to, 1)
    : to;

  const complete = windows.filter((w): w is TimeWindow => w.start !== null && w.end !== null);
  // Store the detail only when the envelope drops some: a lone window on a lone
  // day is fully described by start_time/end_time, and a window missing a bound
  // cannot be rendered as a repeating one.
  const keepWindows = windows.length > 0 && complete.length === windows.length
    && (windows.length > 1 || from !== to);

  return {
    start_time: startClock === null ? null : `${from}T${startClock}:00`,
    end_time: endClock === null ? null : `${endDate}T${endClock}:00`,
    windows: keepWindows ? { from_date: from, to_date: to, daily: complete } : null,
  };
}

/** Read back `alerts.windows_json`. Returns null for NULL, malformed or empty values. */
export function parseWindows(json: string | null | undefined): AlertWindows | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<AlertWindows>;
    if (!parsed || typeof parsed !== "object") return null;
    const { from_date, to_date, daily } = parsed;
    if (typeof from_date !== "string" || typeof to_date !== "string" || !Array.isArray(daily))
      return null;
    const clean = daily.filter(
      (w): w is TimeWindow => !!w && typeof w.start === "string" && typeof w.end === "string");
    return clean.length > 0 ? { from_date, to_date, daily: clean } : null;
  } catch {
    return null;
  }
}

function parts(v: string | null): { date: string | null; hm: string } | null {
  if (!v) return null;
  const iso = ISO_RE.exec(v.trim());
  if (iso) return { date: `${iso[3]}.${iso[2]}`, hm: `${p2(Number(iso[4]))}:${iso[5]}` };
  const hm = HM_RE.exec(v.trim());
  if (hm) return { date: null, hm: `${p2(Number(hm[1]))}:${hm[2]}` };
  return null;
}

/** "2026-07-30" → "30.07". */
function dayMonthOf(date: string): string {
  const iso = DATE_RE.exec(date);
  return iso ? `${p2(Number(iso[3]))}.${p2(Number(iso[2]))}` : date;
}

/**
 * Compact, human-readable window for a push body: "27.07 08:00 – 17:00", with
 * the end date shown only when it differs ("27.07 08:00 – 29.07 17:00"). Bare
 * legacy "HH:MM" values render as just the clock time. Returns "" when neither
 * bound is usable. The caller wraps this (e.g. in parentheses).
 *
 * With `windows` the envelope is not what the alert means, so it is not what
 * gets rendered: a daily recurrence reads "30.07–31.07, 08:30 – 17:00 daily"
 * and several windows in one day read "30.07 09:00 – 11:00, 15:00 – 17:00".
 */
export function formatWindow(
  start: string | null, end: string | null, windows: AlertWindows | null = null,
): string {
  if (windows && windows.daily.length > 0) {
    const clocks = windows.daily.map((w) => `${w.start} – ${w.end}`).join(", ");
    const from = dayMonthOf(windows.from_date);
    return windows.from_date === windows.to_date
      ? `${from} ${clocks}`
      : `${from}–${dayMonthOf(windows.to_date)}, ${clocks} daily`;
  }

  const s = parts(start), e = parts(end);
  const dated = (p: { date: string | null; hm: string }, showDate: boolean) =>
    showDate && p.date ? `${p.date} ${p.hm}` : p.hm;

  if (s && e) {
    const showEndDate = !!e.date && e.date !== s.date;
    return `${dated(s, true)} – ${dated(e, showEndDate)}`;
  }
  if (s) return `from ${dated(s, true)}`;
  if (e) return `until ${dated(e, true)}`;
  return "";
}
