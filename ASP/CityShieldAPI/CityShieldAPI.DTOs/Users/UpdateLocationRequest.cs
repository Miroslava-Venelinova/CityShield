using System.ComponentModel.DataAnnotations;

namespace CityShieldAPI.DTOs.Users
{
    public class UpdateLocationRequest
    {
        [Range(-90, 90)]
        public required double Latitude { get; set; }

        [Range(-180, 180)]
        public required double Longitude { get; set; }
    }
}
