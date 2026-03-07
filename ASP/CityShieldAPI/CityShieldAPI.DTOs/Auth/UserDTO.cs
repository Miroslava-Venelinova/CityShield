using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace CityShieldAPI.DTOs
{
    public class UserDTO
    {
        public string? Email { get; set; }
        public string? PasswordHash { get; set; }

        public required decimal Latitude { get; set; }
        public required decimal Longitude { get; set; }

        public DateTime CreatedOnUTC { get; set; }
        public DateTime UpdatedOnUTC { get; set; }
    }
}
