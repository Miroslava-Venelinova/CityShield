using CityShieldAPI.Data.Models;
using Microsoft.EntityFrameworkCore;

namespace CityShieldAPI.Data
{
    public class ApplicationDbContext : DbContext
    {
        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
            : base(options)
        {
        }

        public DbSet<User> Users { get; set; }
        public DbSet<Street> Streets { get; set; }
        public DbSet<Region> Regions { get; set; }
        public DbSet<DeviceToken> DeviceTokens => Set<DeviceToken>();
        public DbSet<UserNotificationPreference> UserNotificationPreferences { get; set; }
        public DbSet<Alert> Alerts { get; set; }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            // pg_trgm powers the fuzzy name matching (% operator, similarity());
            // declaring it here makes migrations create it on fresh databases.
            modelBuilder.HasPostgresExtension("pg_trgm");

            modelBuilder.Entity<DeviceToken>(e =>
            {
                e.HasIndex(t => t.Token).IsUnique();
                e.HasIndex(t => t.UserId);
                e.Property(t => t.Token).HasMaxLength(512);
                e.Property(t => t.UserId).HasMaxLength(128);
                e.Property(t => t.Platform).HasMaxLength(16);
                e.Property(t => t.DeviceName).HasMaxLength(128);
            });

            modelBuilder.Entity<User>(e =>
            {
                // Location is now nullable — set after registration via Nominatim geocoding
                e.Property(u => u.Location)
                    .HasColumnType("geometry(Point,4326)")
                    .IsRequired(false);

                e.Property(u => u.Latitude).IsRequired(false);
                e.Property(u => u.Longitude).IsRequired(false);
                e.Property(u => u.RegionId).IsRequired(false);
            });

            modelBuilder.Entity<Alert>(e =>
            {
                e.HasIndex(a => a.CreatedOnUTC);
                e.HasIndex(a => a.Category);
            });

            modelBuilder.Entity<UserNotificationPreference>(e =>
            {
                // One row per (user, category) pair
                e.HasIndex(p => new { p.UserId, p.Category }).IsUnique();

                e.HasOne(p => p.User)
                    .WithMany(u => u.NotificationPreferences)
                    .HasForeignKey(p => p.UserId)
                    .OnDelete(DeleteBehavior.Cascade);
            });

            base.OnModelCreating(modelBuilder);
        }
    }
}
