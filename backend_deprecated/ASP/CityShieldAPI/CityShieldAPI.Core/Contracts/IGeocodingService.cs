namespace CityShieldAPI.Core.Contracts
{
    public sealed record GeoPoint(double Lat, double Lon);

    /// <summary>Region/street names resolved from coordinates; either may be null.</summary>
    public sealed record ReverseAddress(string? RegionName, string? StreetName);

    /// <summary>Resolves place names to coordinates and vice versa.</summary>
    public interface IGeocodingService
    {
        /// <summary>Returns coordinates for the query, or null if nothing matched / the lookup failed.</summary>
        Task<GeoPoint?> GeocodeAsync(string query, CancellationToken ct = default);

        /// <summary>
        /// Returns the region (suburb/district/city) and street names for the
        /// coordinates. Fields are null when unresolved; never throws.
        /// </summary>
        Task<ReverseAddress> ReverseGeocodeAsync(double lat, double lon, CancellationToken ct = default);
    }
}
