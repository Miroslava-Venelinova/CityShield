using CityShieldAPI.Data.Models;
using CityShieldAPI.DTOs.Alerts;
using System.Text.Json;

namespace CityShieldAPI.Core.Contracts
{
    public interface IAlertService
    {
        Task<List<User>> GetUsersInRangeAsync(JsonElement location);
        Task<List<User>> GetUsersInPolygonRangeAsync(JsonElement polygon);
        /// <summary>
        /// Notifies the users affected by an alert. With an empty locations
        /// array, <paramref name="cityWide"/> decides: true or null (legacy
        /// payloads) → broadcast to every user with the category enabled;
        /// false → notify nobody (guards against LLM misparses).
        /// When <paramref name="busLines"/> names specific lines (vt route
        /// changes), the audience is narrowed to users subscribed to one of
        /// them; users with no line filter always stay included.
        /// </summary>
        Task<List<Guid>> SendUsersNotificationAsync(
            JsonElement locations,
            string title,
            string body,
            string category,
            string? startTime,
            string? endTime,
            bool? cityWide = null,
            List<string>? busLines = null);

        /// <summary>
        /// Persists an incoming alert. Locations are enriched with coordinates
        /// first (region/street fuzzy match in the DB + Nominatim geocoding,
        /// or the polygon centroid) so the app can render them directly.
        /// Returns the stored alert's id.
        /// </summary>
        Task<Guid> StoreAlertAsync(
            string category,
            string title,
            string content,
            string? startTime,
            string? endTime,
            JsonElement locations);

        /// <summary>Returns stored alerts newer than <paramref name="maxAge"/>, newest first.</summary>
        Task<List<AlertDTO>> GetRecentAlertsAsync(TimeSpan maxAge, int limit);
    }
}
