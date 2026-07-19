using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace CityShieldAPI.Data.Models
{
    [Table("user_notification_preferences")]
    public class UserNotificationPreference
    {
        [Key]
        [Column("id")]
        public int Id { get; set; }

        [Column("user_id")]
        public Guid UserId { get; set; }

        public User User { get; set; } = null!;

        /// <summary>Category key, e.g. "vik", "vt", "epro". Using a string keeps
        /// this scalable — new categories require no schema change.</summary>
        [Column("category")]
        [MaxLength(64)]
        public required string Category { get; set; }

        [Column("is_enabled")]
        public bool IsEnabled { get; set; } = true;

        [Column("updated_at")]
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    }
}
