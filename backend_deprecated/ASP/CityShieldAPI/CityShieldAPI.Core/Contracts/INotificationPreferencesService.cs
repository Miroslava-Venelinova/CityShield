using CityShieldAPI.DTOs.Preferences;

namespace CityShieldAPI.Core.Contracts
{
    public interface INotificationPreferencesService
    {
        /// <summary>
        /// Returns preferences for all known categories for the given user.
        /// If a row doesn't exist yet, the category defaults to enabled=true
        /// (opt-out model — users receive everything unless they explicitly disable).
        /// </summary>
        Task<List<NotificationPreferenceDTO>> GetPreferencesAsync(Guid userId);

        Task SetPreferenceAsync(Guid userId, string category, bool isEnabled);

        /// <summary>
        /// Returns true if the user has notifications enabled for the given category.
        /// Used by AlertService before sending FCM messages.
        /// </summary>
        Task<bool> IsCategoryEnabledForUserAsync(Guid userId, string category);

        /// <summary>
        /// Filters a list of user IDs down to only those who have the given
        /// category enabled. Scales by doing a single bulk DB query.
        /// </summary>
        Task<List<Guid>> FilterEnabledUsersAsync(
            IEnumerable<Guid> userIds, string category);

        /// <summary>
        /// The user's bus-line filter for "vt" alerts plus the catalog of
        /// selectable lines. Empty selection = alerts for all lines.
        /// </summary>
        Task<BusLineSubscriptionDTO> GetBusLineSubscriptionAsync(Guid userId);

        /// <summary>
        /// Replaces the user's bus-line filter. Lines are normalized to the
        /// catalog format; unknown lines throw <see cref="ArgumentException"/>.
        /// </summary>
        Task SetBusLineSubscriptionAsync(Guid userId, List<string> busLines);
    }
}
