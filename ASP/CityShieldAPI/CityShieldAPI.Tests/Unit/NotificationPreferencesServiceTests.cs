using CityShieldAPI.Core;
using CityShieldAPI.Data.Models;
using Xunit;

namespace CityShieldAPI.Tests.Unit;

public class NotificationPreferencesServiceTests
{
    [Fact]
    public async Task GetPreferences_NoRows_AllKnownCategoriesDefaultEnabled()
    {
        using var db = TestHelpers.NewDbContext();
        var service = new NotificationPreferencesService(db);

        var prefs = await service.GetPreferencesAsync(Guid.NewGuid());

        Assert.Equal(NotificationPreferencesService.KnownCategories.Count, prefs.Count);
        Assert.All(prefs, p => Assert.True(p.IsEnabled));
        Assert.Contains(prefs, p => p.Category == "vik");
        Assert.Contains(prefs, p => p.Category == "epro");
        Assert.Contains(prefs, p => p.Category == "heating");
        Assert.Contains(prefs, p => p.Category == "roads");
        Assert.Contains(prefs, p => p.Category == "vt");
    }

    [Fact]
    public async Task GetPreferences_ExistingRowOverridesDefault()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        db.UserNotificationPreferences.Add(new UserNotificationPreference
        {
            UserId = user.UserId,
            Category = "vik",
            IsEnabled = false,
        });
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        var prefs = await service.GetPreferencesAsync(user.UserId);

        Assert.False(prefs.Single(p => p.Category == "vik").IsEnabled);
        Assert.True(prefs.Single(p => p.Category == "epro").IsEnabled);
    }

    [Fact]
    public async Task SetPreference_UnknownCategory_Throws()
    {
        using var db = TestHelpers.NewDbContext();
        var service = new NotificationPreferencesService(db);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            service.SetPreferenceAsync(Guid.NewGuid(), "not-a-category", true));
    }

    [Fact]
    public async Task SetPreference_CreatesThenUpdatesSingleRow()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        await service.SetPreferenceAsync(user.UserId, "heating", false);
        Assert.False(await service.IsCategoryEnabledForUserAsync(user.UserId, "heating"));

        await service.SetPreferenceAsync(user.UserId, "heating", true);
        Assert.True(await service.IsCategoryEnabledForUserAsync(user.UserId, "heating"));

        Assert.Equal(1, db.UserNotificationPreferences.Count());
    }

    [Fact]
    public async Task IsCategoryEnabled_DefaultsToTrueWithoutRow()
    {
        using var db = TestHelpers.NewDbContext();
        var service = new NotificationPreferencesService(db);

        Assert.True(await service.IsCategoryEnabledForUserAsync(Guid.NewGuid(), "vik"));
    }

    [Fact]
    public async Task FilterEnabledUsers_RemovesOnlyExplicitlyDisabledUsers()
    {
        using var db = TestHelpers.NewDbContext();
        var enabledByDefault = TestHelpers.NewUser("a@example.com");
        var explicitlyEnabled = TestHelpers.NewUser("b@example.com");
        var disabled = TestHelpers.NewUser("c@example.com");
        db.Users.AddRange(enabledByDefault, explicitlyEnabled, disabled);
        db.UserNotificationPreferences.AddRange(
            new UserNotificationPreference
            { UserId = explicitlyEnabled.UserId, Category = "vik", IsEnabled = true },
            new UserNotificationPreference
            { UserId = disabled.UserId, Category = "vik", IsEnabled = false },
            // Disabled for a different category — must NOT affect "vik"
            new UserNotificationPreference
            { UserId = enabledByDefault.UserId, Category = "epro", IsEnabled = false });
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        var ids = new[] { enabledByDefault.UserId, explicitlyEnabled.UserId, disabled.UserId };
        var filtered = await service.FilterEnabledUsersAsync(ids, "vik");

        Assert.Equal(2, filtered.Count);
        Assert.Contains(enabledByDefault.UserId, filtered);
        Assert.Contains(explicitlyEnabled.UserId, filtered);
        Assert.DoesNotContain(disabled.UserId, filtered);
    }

    [Fact]
    public async Task FilterEnabledUsers_EmptyInput_ReturnsEmpty()
    {
        using var db = TestHelpers.NewDbContext();
        var service = new NotificationPreferencesService(db);

        var filtered = await service.FilterEnabledUsersAsync(
            Enumerable.Empty<Guid>(), "vik");

        Assert.Empty(filtered);
    }

    // ── Bus-line subscription ────────────────────────────────────────────────

    [Fact]
    public async Task GetBusLineSubscription_DefaultsToEmptySelectionWithFullCatalog()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        var subscription = await service.GetBusLineSubscriptionAsync(user.UserId);

        Assert.Empty(subscription.Selected);
        Assert.Equal(BusLineCatalog.Lines, subscription.Available);
    }

    [Fact]
    public async Task SetBusLineSubscription_NormalizesAndPersists()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        // Lowercase Latin, Cyrillic suffix, a duplicate and the "0" sentinel —
        // all collapse to the canonical catalog entries.
        await service.SetBusLineSubscriptionAsync(
            user.UserId, new List<string> { "31a", "31А", "18", "0" });

        var subscription = await service.GetBusLineSubscriptionAsync(user.UserId);
        Assert.Equal(new List<string> { "31A", "18" }, subscription.Selected);
    }

    [Fact]
    public async Task SetBusLineSubscription_UnknownLine_Throws()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            service.SetBusLineSubscriptionAsync(user.UserId, new List<string> { "999" }));
    }

    [Fact]
    public async Task SetBusLineSubscription_EmptyList_ClearsFilter()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        user.SubscribedBusLines = new List<string> { "18" };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = new NotificationPreferencesService(db);

        await service.SetBusLineSubscriptionAsync(user.UserId, new List<string>());

        var subscription = await service.GetBusLineSubscriptionAsync(user.UserId);
        Assert.Empty(subscription.Selected);
    }
}
