using CityShieldAPI.Data;
using FcmDemo.Models;
using FirebaseAdmin.Messaging;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FcmDemo.Services;

public class FcmTokenService : IFcmTokenService
{
    private readonly ApplicationDbContext _db;
    private readonly ILogger<FcmTokenService> _logger;

    public FcmTokenService(ApplicationDbContext db, ILogger<FcmTokenService> logger)
    {
        _db = db;
        _logger = logger;
    }

    // ── Upsert: insert or refresh LastSeenAt ─────────────────────────────────
    public async Task UpsertTokenAsync(Guid userId, string token,
        string? platform = null, string? deviceName = null)
    {
        var existing = await _db.DeviceTokens
            .FirstOrDefaultAsync(t => t.Token == token);

        if (existing is not null)
        {
            existing.UserId = userId;
            existing.LastSeenAt = DateTime.UtcNow;
            existing.Platform = platform ?? existing.Platform;
            existing.DeviceName = deviceName ?? existing.DeviceName;
        }
        else
        {
            _db.DeviceTokens.Add(new DeviceToken
            {
                UserId = userId,
                Token = token,
                Platform = platform,
                DeviceName = deviceName
            });
        }

        Console.WriteLine("hihihi");

        await _db.SaveChangesAsync();
    }

    // ── Remove a single token ─────────────────────────────────────────────────
    public async Task RemoveTokenAsync(Guid userId, string token)
    {
        var row = await _db.DeviceTokens
            .FirstOrDefaultAsync(t => t.UserId == userId && t.Token == token);

        if (row is not null)
        {
            _db.DeviceTokens.Remove(row);
            await _db.SaveChangesAsync();
        }
    }

    // ── Send to all devices of one user ───────────────────────────────────────
    public async Task SendNotificationAsync(Guid userId, string title, string body,
        Dictionary<string, string>? data = null)
    {
        var tokens = await _db.DeviceTokens
            .Where(t => t.UserId == userId)
            .Select(t => t.Token)
            .ToListAsync();

        if (tokens.Count == 0) return;

        await SendToTokensAsync(tokens, title, body, data);
    }

    // ── Send to multiple users (e.g. broadcast) ───────────────────────────────
    public async Task SendToMultipleUsersAsync(IEnumerable<Guid> userIds,
        string title, string body)
    {
        var tokens = await _db.DeviceTokens
            .Where(t => userIds.Contains(t.UserId))
            .Select(t => t.Token)
            .ToListAsync();

        if (tokens.Count == 0) return;

        await SendToTokensAsync(tokens, title, body);
    }

    // ── Core send — handles stale token cleanup ───────────────────────────────
    private async Task SendToTokensAsync(List<string> tokens, string title, string body,
        Dictionary<string, string>? data = null)
    {
        const int batchSize = 500; // FCM multicast limit
        var staleTokens = new List<string>();

        foreach (var batch in tokens.Chunk(batchSize))
        {
            var message = new MulticastMessage
            {
                Tokens = batch,
                Notification = new Notification { Title = title, Body = body },
                Data = data
            };

            var response = await FirebaseMessaging.DefaultInstance
                .SendEachForMulticastAsync(message);

            for (int i = 0; i < response.Responses.Count; i++)
            {
                var r = response.Responses[i];
                if (!r.IsSuccess && IsTokenInvalid(r.Exception))
                    staleTokens.Add(batch[i]);
            }

            _logger.LogInformation(
                "FCM batch sent. Success: {Success}, Failure: {Failure}",
                response.SuccessCount, response.FailureCount);
        }

        if (staleTokens.Count > 0)
        {
            _db.DeviceTokens.RemoveRange(
                _db.DeviceTokens.Where(t => staleTokens.Contains(t.Token)));
            await _db.SaveChangesAsync();
            _logger.LogInformation("Removed {Count} stale FCM tokens.", staleTokens.Count);
        }
    }

    private static bool IsTokenInvalid(FirebaseMessagingException? ex) =>
         ex?.MessagingErrorCode is
             MessagingErrorCode.Unregistered or
             MessagingErrorCode.InvalidArgument;

    // ── Periodic cleanup: remove tokens not seen in 60 days ──────────────────
    public async Task CleanupStaleTokensAsync()
    {
        var cutoff = DateTime.UtcNow.AddDays(-60);
        var stale = await _db.DeviceTokens
            .Where(t => t.LastSeenAt < cutoff)
            .ToListAsync();

        if (stale.Count > 0)
        {
            _db.DeviceTokens.RemoveRange(stale);
            await _db.SaveChangesAsync();
            _logger.LogInformation("Cleaned up {Count} expired FCM tokens.", stale.Count);
        }
    }
}
