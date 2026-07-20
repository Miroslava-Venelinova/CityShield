using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace CityShieldAPI.Core;

public class FcmTokenService : IFcmTokenService
{
    private readonly ApplicationDbContext _db;
    private readonly IFirebaseMessenger _messenger;
    private readonly ILogger<FcmTokenService> _logger;

    public FcmTokenService(ApplicationDbContext db, IFirebaseMessenger messenger,
        ILogger<FcmTokenService> logger)
    {
        _db = db;
        _messenger = messenger;
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
        string title, string body,
        Dictionary<string, string>? data = null)
    {
        var tokens = await _db.DeviceTokens
            .Where(t => userIds.Contains(t.UserId))
            .Select(t => t.Token)
            .ToListAsync();

        if (tokens.Count == 0) return;

        await SendToTokensAsync(tokens, title, body, data);
    }

    // ── Core send — handles stale token cleanup ───────────────────────────────
    private async Task SendToTokensAsync(List<string> tokens, string title, string body,
        Dictionary<string, string>? data = null)
    {
        const int batchSize = 500; // FCM multicast limit
        var staleTokens = new List<string>();

        foreach (var batch in tokens.Chunk(batchSize))
        {
            var outcomes = await _messenger.SendMulticastAsync(batch, title, body, data);

            for (int i = 0; i < outcomes.Count; i++)
            {
                var r = outcomes[i];
                if (!r.IsSuccess && r.IsTokenInvalid)
                    staleTokens.Add(batch[i]);
            }

            _logger.LogInformation(
                "FCM batch sent. Success: {Success}, Failure: {Failure}",
                outcomes.Count(o => o.IsSuccess), outcomes.Count(o => !o.IsSuccess));
        }

        if (staleTokens.Count > 0)
        {
            _db.DeviceTokens.RemoveRange(
                _db.DeviceTokens.Where(t => staleTokens.Contains(t.Token)));
            await _db.SaveChangesAsync();
            _logger.LogInformation("Removed {Count} stale FCM tokens.", staleTokens.Count);
        }
    }

    // ── Periodic cleanup: remove tokens not seen in 60 days ──────────────────
    public async Task CleanupStaleTokensAsync()
    {
        var cutoff = DateTime.UtcNow.AddDays(-60);
        // Delete by key only — no need to materialize full token rows.
        // (ExecuteDeleteAsync would be ideal, but the unit suite runs on the
        // InMemory provider, which doesn't support set-based deletes.)
        var staleIds = await _db.DeviceTokens
            .Where(t => t.LastSeenAt < cutoff)
            .Select(t => t.Id)
            .ToListAsync();

        if (staleIds.Count > 0)
        {
            // Reuse an already-tracked instance when one exists; attaching a
            // key-only stub for a tracked entity throws.
            _db.DeviceTokens.RemoveRange(staleIds.Select(id =>
                _db.DeviceTokens.Local.FirstOrDefault(t => t.Id == id)
                    ?? new DeviceToken { Id = id }));
            await _db.SaveChangesAsync();
            _logger.LogInformation("Cleaned up {Count} expired FCM tokens.", staleIds.Count);
        }
    }
}
