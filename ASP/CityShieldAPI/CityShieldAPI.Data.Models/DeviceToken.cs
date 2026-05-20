namespace FcmDemo.Models;

public class DeviceToken
{
    public int Id { get; set; }
    public Guid UserId { get; set; }
    public string Token { get; set; } = null!;
    public string? DeviceName { get; set; }
    public string? Platform { get; set; } // "ios" | "android" | "web"
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastSeenAt { get; set; } = DateTime.UtcNow;
}
