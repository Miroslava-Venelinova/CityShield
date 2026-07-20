using CityShieldAPI.Core;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace CityShieldAPI.Tests.Unit;

public class FcmTokenServiceTests
{
    private readonly Mock<IFirebaseMessenger> _messenger = new();

    private FcmTokenService CreateService(Data.ApplicationDbContext db)
    {
        // Default: every send succeeds
        _messenger
            .Setup(m => m.SendMulticastAsync(
                It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()))
            .ReturnsAsync((IReadOnlyList<string> tokens, string t, string b,
                           Dictionary<string, string>? d) =>
                tokens.Select(_ => new FcmSendOutcome(true, false)).ToList());

        return new FcmTokenService(db, _messenger.Object,
            NullLogger<FcmTokenService>.Instance);
    }

    // ── UpsertTokenAsync ──────────────────────────────────────────────────────

    [Fact]
    public async Task Upsert_NewToken_InsertsRow()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var userId = Guid.NewGuid();

        await service.UpsertTokenAsync(userId, "tok-1", "android", "Pixel");

        var row = Assert.Single(db.DeviceTokens);
        Assert.Equal(userId, row.UserId);
        Assert.Equal("tok-1", row.Token);
        Assert.Equal("android", row.Platform);
        Assert.Equal("Pixel", row.DeviceName);
    }

    [Fact]
    public async Task Upsert_ExistingToken_RefreshesInsteadOfDuplicating()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var oldOwner = Guid.NewGuid();
        var newOwner = Guid.NewGuid();
        db.DeviceTokens.Add(new DeviceToken
        {
            UserId = oldOwner,
            Token = "tok-1",
            Platform = "android",
            DeviceName = "Pixel",
            LastSeenAt = DateTime.UtcNow.AddDays(-30),
        });
        await db.SaveChangesAsync();

        await service.UpsertTokenAsync(newOwner, "tok-1");

        var row = Assert.Single(db.DeviceTokens);
        // Token moves to the new owner (e.g. different account on same device)
        Assert.Equal(newOwner, row.UserId);
        Assert.True(row.LastSeenAt > DateTime.UtcNow.AddMinutes(-1));
        // Null platform/device on refresh keeps existing values
        Assert.Equal("android", row.Platform);
        Assert.Equal("Pixel", row.DeviceName);
    }

    // ── RemoveTokenAsync ──────────────────────────────────────────────────────

    [Fact]
    public async Task Remove_ExistingToken_DeletesRow()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var userId = Guid.NewGuid();
        db.DeviceTokens.Add(new DeviceToken { UserId = userId, Token = "tok-1" });
        await db.SaveChangesAsync();

        await service.RemoveTokenAsync(userId, "tok-1");

        Assert.Empty(db.DeviceTokens);
    }

    [Fact]
    public async Task Remove_TokenOwnedByAnotherUser_IsIgnored()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        db.DeviceTokens.Add(new DeviceToken { UserId = Guid.NewGuid(), Token = "tok-1" });
        await db.SaveChangesAsync();

        await service.RemoveTokenAsync(Guid.NewGuid(), "tok-1");

        Assert.Single(db.DeviceTokens);
    }

    // ── SendNotificationAsync / SendToMultipleUsersAsync ─────────────────────

    [Fact]
    public async Task Send_UserWithoutTokens_DoesNotCallFirebase()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);

        await service.SendNotificationAsync(Guid.NewGuid(), "t", "b");

        _messenger.Verify(m => m.SendMulticastAsync(
            It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(),
            It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()), Times.Never);
    }

    [Fact]
    public async Task Send_TargetsOnlyTheUsersOwnTokens()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var userId = Guid.NewGuid();
        db.DeviceTokens.AddRange(
            new DeviceToken { UserId = userId, Token = "mine-1" },
            new DeviceToken { UserId = userId, Token = "mine-2" },
            new DeviceToken { UserId = Guid.NewGuid(), Token = "other-1" });
        await db.SaveChangesAsync();

        IReadOnlyList<string>? sent = null;
        _messenger
            .Setup(m => m.SendMulticastAsync(
                It.IsAny<IReadOnlyList<string>>(), "title", "body",
                It.IsAny<Dictionary<string, string>?>()))
            .Callback((IReadOnlyList<string> tokens, string t, string b,
                       Dictionary<string, string>? d) => sent = tokens)
            .ReturnsAsync(new List<FcmSendOutcome>
                { new(true, false), new(true, false) });

        await service.SendNotificationAsync(userId, "title", "body");

        Assert.NotNull(sent);
        Assert.Equal(new[] { "mine-1", "mine-2" }, sent!.OrderBy(x => x));
    }

    [Fact]
    public async Task SendToMultipleUsers_CollectsTokensAcrossUsers()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var user1 = Guid.NewGuid();
        var user2 = Guid.NewGuid();
        db.DeviceTokens.AddRange(
            new DeviceToken { UserId = user1, Token = "u1-a" },
            new DeviceToken { UserId = user2, Token = "u2-a" },
            new DeviceToken { UserId = Guid.NewGuid(), Token = "excluded" });
        await db.SaveChangesAsync();

        IReadOnlyList<string>? sent = null;
        _messenger
            .Setup(m => m.SendMulticastAsync(
                It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()))
            .Callback((IReadOnlyList<string> tokens, string t, string b,
                       Dictionary<string, string>? d) => sent = tokens)
            .ReturnsAsync(new List<FcmSendOutcome>
                { new(true, false), new(true, false) });

        await service.SendToMultipleUsersAsync(new[] { user1, user2 }, "t", "b");

        Assert.Equal(new[] { "u1-a", "u2-a" }, sent!.OrderBy(x => x));
    }

    [Fact]
    public async Task Send_InvalidTokensAreDeletedAfterSend()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var userId = Guid.NewGuid();
        db.DeviceTokens.AddRange(
            new DeviceToken { UserId = userId, Token = "alive" },
            new DeviceToken { UserId = userId, Token = "dead" });
        await db.SaveChangesAsync();

        _messenger
            .Setup(m => m.SendMulticastAsync(
                It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()))
            .ReturnsAsync((IReadOnlyList<string> tokens, string t, string b,
                           Dictionary<string, string>? d) =>
                tokens.Select(tok => tok == "dead"
                    ? new FcmSendOutcome(false, true)      // permanently invalid
                    : new FcmSendOutcome(true, false)).ToList());

        await service.SendNotificationAsync(userId, "t", "b");

        var remaining = Assert.Single(db.DeviceTokens);
        Assert.Equal("alive", remaining.Token);
    }

    [Fact]
    public async Task Send_TransientFailureDoesNotDeleteToken()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var userId = Guid.NewGuid();
        db.DeviceTokens.Add(new DeviceToken { UserId = userId, Token = "flaky" });
        await db.SaveChangesAsync();

        _messenger
            .Setup(m => m.SendMulticastAsync(
                It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()))
            .ReturnsAsync(new List<FcmSendOutcome>
                { new(false, false) });   // failed, but token not invalid

        await service.SendNotificationAsync(userId, "t", "b");

        Assert.Single(db.DeviceTokens);
    }

    [Fact]
    public async Task Send_MoreThan500Tokens_IsChunkedIntoBatches()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        var userId = Guid.NewGuid();
        for (int i = 0; i < 501; i++)
            db.DeviceTokens.Add(new DeviceToken { UserId = userId, Token = $"tok-{i}" });
        await db.SaveChangesAsync();

        var batchSizes = new List<int>();
        _messenger
            .Setup(m => m.SendMulticastAsync(
                It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()))
            .Callback((IReadOnlyList<string> tokens, string t, string b,
                       Dictionary<string, string>? d) => batchSizes.Add(tokens.Count))
            .ReturnsAsync((IReadOnlyList<string> tokens, string t, string b,
                           Dictionary<string, string>? d) =>
                tokens.Select(_ => new FcmSendOutcome(true, false)).ToList());

        await service.SendNotificationAsync(userId, "t", "b");

        Assert.Equal(new[] { 500, 1 }, batchSizes);
    }

    // ── CleanupStaleTokensAsync ───────────────────────────────────────────────

    [Fact]
    public async Task Cleanup_RemovesTokensOlderThan60Days()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);
        db.DeviceTokens.AddRange(
            new DeviceToken
            {
                UserId = Guid.NewGuid(), Token = "ancient",
                LastSeenAt = DateTime.UtcNow.AddDays(-61),
            },
            new DeviceToken
            {
                UserId = Guid.NewGuid(), Token = "recent",
                LastSeenAt = DateTime.UtcNow.AddDays(-59),
            });
        await db.SaveChangesAsync();

        await service.CleanupStaleTokensAsync();

        var remaining = Assert.Single(db.DeviceTokens);
        Assert.Equal("recent", remaining.Token);
    }
}
