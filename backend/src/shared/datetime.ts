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

function parts(v: string | null): { date: string | null; hm: string } | null {
  if (!v) return null;
  const iso = ISO_RE.exec(v.trim());
  if (iso) return { date: `${iso[3]}.${iso[2]}`, hm: `${p2(Number(iso[4]))}:${iso[5]}` };
  const hm = HM_RE.exec(v.trim());
  if (hm) return { date: null, hm: `${p2(Number(hm[1]))}:${hm[2]}` };
  return null;
}

/**
 * Compact, human-readable window for a push body: "27.07 08:00 – 17:00", with
 * the end date shown only when it differs ("27.07 08:00 – 29.07 17:00"). Bare
 * legacy "HH:MM" values render as just the clock time. Returns "" when neither
 * bound is usable. The caller wraps this (e.g. in parentheses).
 */
export function formatWindow(start: string | null, end: string | null): string {
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
