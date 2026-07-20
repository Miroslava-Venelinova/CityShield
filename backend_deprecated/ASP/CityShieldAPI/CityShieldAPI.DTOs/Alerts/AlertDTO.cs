using System.Text.Json;
using System.Text.Json.Serialization;

namespace CityShieldAPI.DTOs.Alerts
{
    /// <summary>
    /// One affected location of an alert. Property names are snake_case to
    /// match both the ingestion payload and the mobile app's Alert type.
    /// </summary>
    public class AlertLocationDTO
    {
        [JsonPropertyName("location_name")]
        public string LocationName { get; set; } = string.Empty;

        [JsonPropertyName("sublocations")]
        public List<string> Sublocations { get; set; } = new();

        [JsonPropertyName("is_polygon")]
        public bool IsPolygon { get; set; }

        /// <summary>GeoJSON Polygon *geometry* ({"type":"Polygon","coordinates":[...]}), if any.</summary>
        [JsonPropertyName("polygon_geojson")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public JsonElement? PolygonGeojson { get; set; }

        [JsonPropertyName("lat")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public double? Lat { get; set; }

        [JsonPropertyName("lng")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public double? Lng { get; set; }
    }

    public class AlertOriginalMessageDTO
    {
        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("content")]
        public string Content { get; set; } = string.Empty;
    }

    public class AlertProcessedDataDTO
    {
        [JsonPropertyName("locations")]
        public List<AlertLocationDTO> Locations { get; set; } = new();

        [JsonPropertyName("start_time")]
        public string? StartTime { get; set; }

        [JsonPropertyName("end_time")]
        public string? EndTime { get; set; }
    }

    /// <summary>Shape returned by GET /api/alerts/recent — mirrors the app's Alert type.</summary>
    public class AlertDTO
    {
        [JsonPropertyName("id")]
        public Guid Id { get; set; }

        [JsonPropertyName("original_message")]
        public AlertOriginalMessageDTO OriginalMessage { get; set; } = new();

        [JsonPropertyName("processed_data")]
        public AlertProcessedDataDTO ProcessedData { get; set; } = new();

        [JsonPropertyName("source")]
        public string Source { get; set; } = string.Empty;

        [JsonPropertyName("severity")]
        public string Severity { get; set; } = "info";

        [JsonPropertyName("created_at")]
        public DateTime CreatedAt { get; set; }
    }
}
