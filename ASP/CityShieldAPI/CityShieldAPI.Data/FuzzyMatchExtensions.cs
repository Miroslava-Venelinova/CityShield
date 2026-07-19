using CityShieldAPI.Data.Models;
using Microsoft.EntityFrameworkCore;

namespace CityShieldAPI.Data
{
    /// <summary>
    /// pg_trgm fuzzy matching against the regions/streets reference tables:
    /// best match above the extension's similarity threshold, or null.
    /// Requires PostgreSQL with pg_trgm (the % operator); callers running on
    /// other providers (unit tests) must handle the resulting exception.
    /// </summary>
    public static class FuzzyMatchExtensions
    {
        public static Task<Region?> FuzzyMatchRegionAsync(
            this ApplicationDbContext db, string name) =>
            db.Regions
                .FromSqlInterpolated($@"
                    SELECT * FROM regions
                    WHERE region_name % {name}
                    ORDER BY similarity(region_name, {name}) DESC
                    LIMIT 1
                ")
                .FirstOrDefaultAsync();

        public static Task<Street?> FuzzyMatchStreetAsync(
            this ApplicationDbContext db, string name) =>
            db.Streets
                .FromSqlInterpolated($@"
                    SELECT * FROM streets
                    WHERE street_name % {name}
                    ORDER BY similarity(street_name, {name}) DESC
                    LIMIT 1
                ")
                .FirstOrDefaultAsync();
    }
}
