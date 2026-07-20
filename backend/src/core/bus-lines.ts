// Port of BusLineCatalog.cs — the Varna public-transport lines users can
// subscribe to, in the canonical format the VT scraper's AI prompt produces
// ("number + uppercase Latin letter", e.g. "31A", "209B" for "209 Бърз").
// Source: varnatraffic.com line list.

export const BUS_LINES: readonly string[] = [
  "1", "7", "9", "10", "12", "13", "14", "17", "17A", "18", "18A",
  "20", "22", "23", "29", "30", "31", "31A", "32", "36", "37", "39",
  "40", "41", "46", "55", "60", "82", "83", "88", "109", "118",
  "118A", "122", "148", "209", "209B", "409",
];

const LINE_SET = new Set(BUS_LINES);

/**
 * Canonicalizes a scraped or user-supplied line name: trims, uppercases and
 * maps the Cyrillic suffixes the sources use (31А, 209Б) onto their Latin
 * catalog equivalents. Returns null for the "0" sentinel (route change with
 * no line identified) and blanks.
 */
export function normalizeBusLine(line: string | null | undefined): string | null {
  if (!line || !line.trim()) return null;
  const normalized = line.trim().toUpperCase().replace(/А/g, "A").replace(/Б/g, "B");
  return normalized === "0" ? null : normalized;
}

export function isKnownBusLine(line: string): boolean {
  return LINE_SET.has(line);
}
