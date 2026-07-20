using System.ComponentModel.DataAnnotations;

namespace CityShieldAPI.DTOs
{
    public class RegisterRequest
    {
        [EmailAddress]
        [StringLength(50, MinimumLength = 5)]
        public required string Email { get; set; }

        [StringLength(50, MinimumLength = 8)]
        public required string Password { get; set; }
    }
}
