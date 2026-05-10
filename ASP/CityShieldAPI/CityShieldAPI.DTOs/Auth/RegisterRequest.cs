using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace CityShieldAPI.DTOs
{
    public class RegisterRequest
    {
        [EmailAddress]
        [StringLength(50, MinimumLength = 5)]
        public required string Email { get; set; }
        [StringLength(50, MinimumLength = 8)]
        public required string Password { get; set; }

        public required int RegionId { get; set; }
        public int? StreetId { get; set; }
    }
}
