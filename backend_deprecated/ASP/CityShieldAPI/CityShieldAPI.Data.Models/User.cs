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

        public double? Latitude { get; set; }
        public double? Longitude { get; set; }

        public Point? Location { get; set; }

        // Nullable: users register without a location and set it later via PUT /api/users/location
        public int? RegionId { get; set; }

        public Region? Region { get; set; }

        public int? StreetId { get; set; }

        public Street? Street { get; set; }

        // Debug/monitoring accounts: when true, the user is included in every
        // alert notification regardless of their region/street/location.
        public bool ReceivesAllAlerts { get; set; }

        // Bus lines the user wants transport ("vt") alerts for, in the
        // canonical catalog format ("18", "31A", "209B"). Empty = no filter:
        // the user receives every vt alert (mapped to text[] by Npgsql).
        public List<string> SubscribedBusLines { get; set; } = new();

        public ICollection<UserNotificationPreference> NotificationPreferences { get; set; }
            = new List<UserNotificationPreference>();

        public DateTime CreatedOnUTC { get; set; }
        public DateTime UpdatedOnUTC { get; set; }
    }
}
