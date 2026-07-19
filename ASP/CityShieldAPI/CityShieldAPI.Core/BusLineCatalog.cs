namespace CityShieldAPI.Core
{
    /// <summary>
    /// The Varna public-transport lines users can subscribe to, in the same
    /// canonical format the VT scraper's AI prompt produces ("number +
    /// uppercase Latin letter", e.g. "31A", "209B" for "209 Бърз").
    /// Source: varnatraffic.com line list.
    /// </summary>
    public static class BusLineCatalog
    {
        public static readonly IReadOnlyList<string> Lines = new[]
        {
            "1", "7", "9", "10", "12", "13", "14", "17", "17A", "18", "18A",
            "20", "22", "23", "29", "30", "31", "31A", "32", "36", "37", "39",
            "40", "41", "46", "55", "60", "82", "83", "88", "109", "118",
            "118A", "122", "148", "209", "209B", "409",
        };

        private static readonly HashSet<string> LineSet = new(Lines);

        /// <summary>
        /// Canonicalizes a scraped or user-supplied line name: trims,
        /// uppercases and maps the Cyrillic suffixes the sources use (31А,
        /// 209Б) onto their Latin catalog equivalents. Returns null for the
        /// "0" sentinel (route change with no line identified) and blanks.
        /// </summary>
        public static string? Normalize(string? line)
        {
            if (string.IsNullOrWhiteSpace(line)) return null;
            var normalized = line.Trim().ToUpperInvariant()
                .Replace('А', 'A').Replace('Б', 'B');
            return normalized == "0" ? null : normalized;
        }

        public static bool IsKnown(string line) => LineSet.Contains(line);
    }
}
