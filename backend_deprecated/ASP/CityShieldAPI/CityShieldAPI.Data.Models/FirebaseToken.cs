using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace CityShieldAPI.Data.Models
{
    public class FirebaseToken
    {
        [Key]
        public Guid Id { get; set; }

        public required Guid UserId { get; set; }
        public virtual required User User { get; set; }

        public required DateTime CreatedOn { get; set; }

        public required string Token { get; set; }
    }
}
