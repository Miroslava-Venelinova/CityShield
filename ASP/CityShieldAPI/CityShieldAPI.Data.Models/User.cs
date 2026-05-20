using NetTopologySuite.Geometries;
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace CityShieldAPI.Data.Models
{
    public class User
    {
        [Key]
        public Guid UserId { get; set; }

        [EmailAddress]
        public required string Email { get; set; }
        public required string PasswordHash { get; set; }

        public required double Latitude { get; set; }
        public required double Longitude { get; set; }

        public Point Location { get; set; } = null!;

        public required int RegionId { get; set; }
        public int? StreetId { get; set; }

        public DateTime CreatedOnUTC { get; set; }
        public DateTime UpdatedOnUTC { get; set; }
    }
}
