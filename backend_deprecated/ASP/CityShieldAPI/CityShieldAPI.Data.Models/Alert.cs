using System;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace CityShieldAPI.Data.Models
{
    /// <summary>
    /// A stored alert as received from the ingestion backend, with its
    /// locations enriched with coordinates so the mobile app can draw them
    /// on the map without re-geocoding.
    /// </summary>
    [Table("alerts")]
    public class Alert
    {
        [Key]
        [Column("id")]
        public Guid Id { get; set; }

        /// <summary>Source category: vik, epro, heating, roads, vt.</summary>
        [Column("category")]
        [MaxLength(32)]
        public string Category { get; set; } = null!;

        [Column("title")]
        public string Title { get; set; } = null!;

        [Column("content")]
        public string Content { get; set; } = null!;

        /// <summary>danger | warning | info — drives marker colors in the app.</summary>
        [Column("severity")]
        [MaxLength(16)]
        public string Severity { get; set; } = "info";

        /// <summary>Outage window as scraped ("HH:MM"), free-form.</summary>
        [Column("start_time")]
        [MaxLength(32)]
        public string? StartTime { get; set; }

        [Column("end_time")]
        [MaxLength(32)]
        public string? EndTime { get; set; }

        /// <summary>
        /// Enriched locations array as JSON: location_name, sublocations,
        /// is_polygon, polygon_geojson (Polygon geometry), lat, lng.
        /// </summary>
        [Column("locations_json", TypeName = "jsonb")]
        public string LocationsJson { get; set; } = "[]";

        [Column("created_on_utc")]
        public DateTime CreatedOnUTC { get; set; }
    }
}
