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
        //TO-DO Add more password client-side validation
        public required string Password { get; set; }
        //TO-DO Add client-side validation for CGM Link

        public required decimal Latitude { get; set; }
        public required decimal Longitude { get; set; }
    }
}
