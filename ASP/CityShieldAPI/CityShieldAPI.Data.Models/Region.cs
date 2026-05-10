using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace CityShieldAPI.Data.Models
{
    [Table("regions")]
    public class Region
    {
        [Key]
        [Column("id")]
        public int Id { get; set; }

        [Column("region_name")]
        public string RegionName { get; set; } = null!;
    }
}
