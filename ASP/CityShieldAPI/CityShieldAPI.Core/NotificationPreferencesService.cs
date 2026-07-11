using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using CityShieldAPI.DTOs.Preferences;
using Microsoft.EntityFrameworkCore;

namespace CityShieldAPI.Core
{
    public class NotificationPreferencesService : INotificationPreferencesService
    {
        private readonly ApplicationDbContext _db;

        // All known categories. Adding a new one here is the only schema-free
        // change required to support a new alert source.
        public static readonly IReadOnlyDictionary<string, string> KnownCategories =
            new Dictionary<string, string>
            {
                ["vik"]     = "Water (ВиК)",
                ["vt"]      = "Traffic",
                ["epro"]    = "Power (ЕРП Север)",
                ["heating"] = "Heating (Веолия)",
                ["roads"]   = "Roads (АПИ)",
            };

        public NotificationPreferencesService(ApplicationDbContext db)
        {
            _db = db;
        }

        public async Task<List<NotificationPreferenceDTO>> GetPreferencesAsync(Guid userId)
        {
            // Fetch whatever rows already exist for this user
            var existing = await _db.UserNotificationPreferences
                .Where(p => p.UserId == userId)
                .ToDictionaryAsync(p => p.Category, p => p.IsEnabled);

            // Return one entry per known category, defaulting to enabled
            return KnownCategories
                .Select(kv => new NotificationPreferenceDTO
                {
                    Category  = kv.Key,
                    Label     = kv.Value,
                    IsEnabled = existing.TryGetValue(kv.Key, out var enabled) ? enabled : true,
                })
                .ToList();
        }

        public async Task SetPreferenceAsync(Guid userId, string category, bool isEnabled)
        {
            if (!KnownCategories.ContainsKey(category))
                throw new ArgumentException($"Unknown category: {category}");

            var existing = await _db.UserNotificationPreferences
                .FirstOrDefaultAsync(p => p.UserId == userId && p.Category == category);

            if (existing is not null)
            {
                existing.IsEnabled  = isEnabled;
                existing.UpdatedAt  = DateTime.UtcNow;
            }
            else
            {
                _db.UserNotificationPreferences.Add(new UserNotificationPreference
                {
                    UserId    = userId,
                    Category  = category,
                    IsEnabled = isEnabled,
                    UpdatedAt = DateTime.UtcNow,
                });
            }

            await _db.SaveChangesAsync();
        }

        public async Task<bool> IsCategoryEnabledForUserAsync(Guid userId, string category)
        {
            var pref = await _db.UserNotificationPreferences
                .FirstOrDefaultAsync(p => p.UserId == userId && p.Category == category);

            // Default: enabled (opt-out model)
            return pref?.IsEnabled ?? true;
        }

        public async Task<List<Guid>> FilterEnabledUsersAsync(
            IEnumerable<Guid> userIds, string category)
        {
            var ids = userIds.ToList();
            if (ids.Count == 0) return ids;

            // Users who have explicitly DISABLED this category
            var disabledIds = (await _db.UserNotificationPreferences
                .Where(p => ids.Contains(p.UserId)
                         && p.Category == category
                         && !p.IsEnabled)
                .Select(p => p.UserId)
                .ToListAsync())
                .ToHashSet();

            // Everyone else gets the notification (opt-out default)
            return ids.Where(id => !disabledIds.Contains(id)).ToList();
        }

        public async Task<BusLineSubscriptionDTO> GetBusLineSubscriptionAsync(Guid userId)
        {
            var selected = await _db.Users
                .Where(u => u.UserId == userId)
                .Select(u => u.SubscribedBusLines)
                .FirstOrDefaultAsync() ?? new List<string>();

            return new BusLineSubscriptionDTO
            {
                Available = BusLineCatalog.Lines.ToList(),
                Selected  = selected,
            };
        }

        public async Task SetBusLineSubscriptionAsync(Guid userId, List<string> busLines)
        {
            var normalized = busLines
                .Select(BusLineCatalog.Normalize)
                .Where(l => l is not null)
                .Select(l => l!)
                .Distinct()
                .ToList();

            var unknown = normalized.Where(l => !BusLineCatalog.IsKnown(l)).ToList();
            if (unknown.Count > 0)
                throw new ArgumentException($"Unknown bus line(s): {string.Join(", ", unknown)}");

            var user = await _db.Users.FirstOrDefaultAsync(u => u.UserId == userId)
                ?? throw new ArgumentException($"Unknown user: {userId}");

            user.SubscribedBusLines = normalized;
            user.UpdatedOnUTC = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }
    }
}
