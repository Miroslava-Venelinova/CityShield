namespace CityShieldAPI.DTOs
{
    public class UserDTO
    {
        public string? Email { get; set; }
        public double? Latitude { get; set; }
        public double? Longitude { get; set; }
        /// <summary>True once the user has set their location via PUT /api/auth/location.</summary>
        public bool HasLocation { get; set; }
        /// <summary>Human-readable region name resolved from RegionId, null if no location set.</summary>
        public string? RegionName { get; set; }
        /// <summary>Human-readable street name resolved from StreetId, null if not matched.</summary>
        public string? StreetName { get; set; }
        public DateTime CreatedOnUTC { get; set; }
        public DateTime UpdatedOnUTC { get; set; }
    }
}
