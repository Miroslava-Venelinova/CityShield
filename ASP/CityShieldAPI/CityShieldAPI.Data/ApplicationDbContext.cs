using CityShieldAPI.Data.Models;
using FcmDemo.Models;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
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

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<DeviceToken>(e =>
            {
                e.HasIndex(t => t.Token).IsUnique();
                e.HasIndex(t => t.UserId);
                e.Property(t => t.Token).HasMaxLength(512);
                e.Property(t => t.UserId).HasMaxLength(128);
                e.Property(t => t.Platform).HasMaxLength(16);
                e.Property(t => t.DeviceName).HasMaxLength(128);
            });

            modelBuilder.Entity<User>()
                .Property(u => u.Location)
                .HasColumnType("geometry(Point,4326)");
            base.OnModelCreating(modelBuilder);
        }
    }
}
