namespace FcmDemo.Services;

public interface IFcmTokenService
{
    Task UpsertTokenAsync(Guid userId, string token, string? platform = null, string? deviceName = null);
    Task RemoveTokenAsync(Guid userId, string token);
    Task SendNotificationAsync(Guid userId, string title, string body, Dictionary<string, string>? data = null);
    Task SendToMultipleUsersAsync(IEnumerable<Guid> userIds, string title, string body);
    Task CleanupStaleTokensAsync();
}
