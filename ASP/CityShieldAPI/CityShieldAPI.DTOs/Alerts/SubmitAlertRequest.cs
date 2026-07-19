using System.Text.Json;
using System.Text.Json.Serialization;

namespace CityShieldAPI.DTOs.Alerts
{
    /// <summary>
    /// Ingest payload for POST /api/alerts/submit-data, produced by the Python
    /// scraping backend (services/common.py submit_to_api). Property names are
    /// snake_case to match that payload. The `required` members make malformed
    /// payloads fail JSON binding with a 400 instead of throwing inside the
    /// controller.
    /// </summary>
    public class SubmitAlertRequest
    {
        [JsonPropertyName("original_message")]
        public required SubmitAlertMessageDTO OriginalMessage { get; set; }

        /// <summary>Source category ("vik", "epro", ...); older payloads omit it.</summary>
        [JsonPropertyName("category")]
        public string? Category { get; set; }

        [JsonPropertyName("processed_data")]
        public required SubmitAlertProcessedDataDTO ProcessedData { get; set; }
    }

    public class SubmitAlertMessageDTO
    {
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("content")]
        public string? Content { get; set; }
    }

    public class SubmitAlertProcessedDataDTO
    {
        [JsonPropertyName("start_time")]
        public string? StartTime { get; set; }

        [JsonPropertyName("end_time")]
        public string? EndTime { get; set; }

        /// <summary>
        /// Kept as raw JSON: locations carry free-form GeoJSON polygons that
        /// AlertService normalizes itself. Must be an array (enforced in the
        /// controller so a null can never turn into an accidental broadcast).
        /// </summary>
        [JsonPropertyName("locations")]
        public required JsonElement Locations { get; set; }

        /// <summary>
        /// Explicit broadcast flag from the scraper. true → notify everyone
        /// (per-category preferences still apply); false → never broadcast,
        /// even when locations is empty (protects against an LLM misparse
        /// dropping the locations of a street-level outage); null → legacy
        /// payload, keeps the old empty-locations-broadcast behavior.
        /// </summary>
        [JsonPropertyName("city_wide")]
        public bool? CityWide { get; set; }

        /// <summary>
        /// Bus lines affected by a "vt" route-change alert, as extracted by
        /// the scraper's LLM ("18", "31A", ...). When present and specific,
        /// the broadcast is narrowed to users subscribed to one of these
        /// lines (users with no line filter still get everything). "0" is the
        /// scraper's "route change but no line identified" sentinel; null or
        /// empty means no line information.
        /// </summary>
        [JsonPropertyName("bus_lines")]
        public List<string>? BusLines { get; set; }
    }
}
