using System.Text.Json;
using CityShieldAPI.Core;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using NetTopologySuite;
using Xunit;

namespace CityShieldAPI.Tests.Unit;

public class AlertServiceTests
{
    private readonly Mock<IFcmTokenService> _fcm = new();
    private readonly Mock<INotificationPreferencesService> _prefs = new();
    private readonly Mock<IGeocodingService> _geocoder = new();

    private AlertService CreateService(ApplicationDbContext db)
    {
        // Default preference filter: everyone passes
        _prefs
            .Setup(p => p.FilterEnabledUsersAsync(
                It.IsAny<IEnumerable<Guid>>(), It.IsAny<string>()))
            .ReturnsAsync((IEnumerable<Guid> ids, string cat) => ids.ToList());

        return new AlertService(db, _fcm.Object, _prefs.Object,
            _geocoder.Object, NullLogger<AlertService>.Instance);
    }

    private static User UserAt(double lon, double lat, string email)
    {
        var factory = NtsGeometryServices.Instance.CreateGeometryFactory(srid: 4326);
        var user = TestHelpers.NewUser(email);
        user.Longitude = lon;
        user.Latitude = lat;
        user.Location = factory.CreatePoint(new NetTopologySuite.Geometries.Coordinate(lon, lat));
        return user;
    }

    private static JsonElement Json(string json) =>
        JsonDocument.Parse(json).RootElement;

    /// <summary>GeoJSON FeatureCollection with one square polygon (lon 27..28, lat 43..44).</summary>
    private const string SquarePolygonGeoJson = """
        {
          "type": "FeatureCollection",
          "features": [
            {
              "type": "Feature",
              "geometry": {
                "type": "Polygon",
                "coordinates": [[[27,43],[28,43],[28,44],[27,44],[27,43]]]
              }
            }
          ]
        }
        """;

    // ── GetUsersInPolygonRangeAsync ───────────────────────────────────────────

    [Fact]
    public async Task PolygonRange_ReturnsOnlyUsersInsidePolygon()
    {
        using var db = TestHelpers.NewDbContext();
        var inside1 = UserAt(27.5, 43.5, "in1@example.com");
        var inside2 = UserAt(27.9, 43.1, "in2@example.com");
        var outside = UserAt(26.0, 42.0, "out@example.com");
        var noLocation = TestHelpers.NewUser("nowhere@example.com");
        db.Users.AddRange(inside1, inside2, outside, noLocation);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var users = await service.GetUsersInPolygonRangeAsync(Json(SquarePolygonGeoJson));

        Assert.Equal(2, users.Count);
        Assert.Contains(users, u => u.UserId == inside1.UserId);
        Assert.Contains(users, u => u.UserId == inside2.UserId);
    }

    [Fact]
    public async Task PolygonRange_MultipleFeatures_UnionWithoutDuplicates()
    {
        using var db = TestHelpers.NewDbContext();
        var user = UserAt(27.5, 43.5, "in@example.com");
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        // Two overlapping squares that both contain the user
        var geojson = Json("""
            {
              "type": "FeatureCollection",
              "features": [
                { "geometry": { "coordinates": [[[27,43],[28,43],[28,44],[27,44],[27,43]]] } },
                { "geometry": { "coordinates": [[[27.4,43.4],[27.6,43.4],[27.6,43.6],[27.4,43.6],[27.4,43.4]]] } }
              ]
            }
            """);

        var users = await service.GetUsersInPolygonRangeAsync(geojson);

        Assert.Single(users);
    }

    // ── SendUsersNotificationAsync — broadcast path ──────────────────────────

    [Fact]
    public async Task Send_EmptyLocations_BroadcastsToAllUsers()
    {
        using var db = TestHelpers.NewDbContext();
        var user1 = TestHelpers.NewUser("a@example.com");
        var user2 = TestHelpers.NewUser("b@example.com");
        db.Users.AddRange(user1, user2);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "title", "body", "roads", null, null);

        Assert.Equal(2, notified.Count);
        _fcm.Verify(f => f.SendToMultipleUsersAsync(
            It.Is<IEnumerable<Guid>>(ids => ids.Count() == 2),
            "title", "body",
            It.IsAny<Dictionary<string, string>?>()), Times.Once);
    }

    [Fact]
    public async Task Send_EmptyLocations_CityWideFalse_NotifiesNobody()
    {
        using var db = TestHelpers.NewDbContext();
        db.Users.AddRange(
            TestHelpers.NewUser("a@example.com"),
            TestHelpers.NewUser("b@example.com"));
        await db.SaveChangesAsync();
        var service = CreateService(db);

        // Scraper explicitly said not city-wide (likely LLM misparse dropped
        // the locations) — must not escalate to a broadcast.
        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "title", "body", "vik", null, null, cityWide: false);

        Assert.Empty(notified);
        _fcm.Verify(f => f.SendToMultipleUsersAsync(
            It.IsAny<IEnumerable<Guid>>(), It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<Dictionary<string, string>?>()), Times.Never);
    }

    [Fact]
    public async Task Send_PreferenceFilterIsAppliedPerCategory()
    {
        using var db = TestHelpers.NewDbContext();
        var wants = TestHelpers.NewUser("wants@example.com");
        var optedOut = TestHelpers.NewUser("optedout@example.com");
        db.Users.AddRange(wants, optedOut);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        _prefs
            .Setup(p => p.FilterEnabledUsersAsync(It.IsAny<IEnumerable<Guid>>(), "vik"))
            .ReturnsAsync(new List<Guid> { wants.UserId });

        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "t", "b", "vik", null, null);

        Assert.Equal(new[] { wants.UserId }, notified);
        _fcm.Verify(f => f.SendToMultipleUsersAsync(
            It.Is<IEnumerable<Guid>>(ids => ids.Single() == wants.UserId),
            It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<Dictionary<string, string>?>()), Times.Once);
    }

    [Fact]
    public async Task Send_AllUsersFilteredOut_SendsNothing()
    {
        using var db = TestHelpers.NewDbContext();
        db.Users.Add(TestHelpers.NewUser());
        await db.SaveChangesAsync();
        var service = CreateService(db);

        _prefs
            .Setup(p => p.FilterEnabledUsersAsync(
                It.IsAny<IEnumerable<Guid>>(), It.IsAny<string>()))
            .ReturnsAsync(new List<Guid>());

        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "t", "b", "vik", "09:00", "17:00");

        Assert.Empty(notified);
        _fcm.Verify(f => f.SendToMultipleUsersAsync(
            It.IsAny<IEnumerable<Guid>>(), It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<Dictionary<string, string>?>()), Times.Never);
    }

    // ── SendUsersNotificationAsync — bus-line targeting (vt) ─────────────────

    [Fact]
    public async Task Send_BusLines_NarrowsToSubscribersAndUnfilteredUsers()
    {
        using var db = TestHelpers.NewDbContext();
        var rides18   = TestHelpers.NewUser("rides18@example.com");
        rides18.SubscribedBusLines = new List<string> { "18" };
        var rides31A  = TestHelpers.NewUser("rides31a@example.com");
        rides31A.SubscribedBusLines = new List<string> { "31A" };
        var noFilter  = TestHelpers.NewUser("nofilter@example.com"); // empty = wants everything
        db.Users.AddRange(rides18, rides31A, noFilter);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "t", "b", "vt", null, null,
            cityWide: true, busLines: new List<string> { "18" });

        Assert.Equal(2, notified.Count);
        Assert.Contains(rides18.UserId, notified);
        Assert.Contains(noFilter.UserId, notified);
        Assert.DoesNotContain(rides31A.UserId, notified);
    }

    [Fact]
    public async Task Send_BusLines_CyrillicSuffixMatchesLatinSubscription()
    {
        using var db = TestHelpers.NewDbContext();
        var rides31A = TestHelpers.NewUser("rides31a@example.com");
        rides31A.SubscribedBusLines = new List<string> { "31A" };
        db.Users.Add(rides31A);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        // The LLM sometimes emits the Cyrillic suffix from the source text
        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "t", "b", "vt", null, null,
            cityWide: true, busLines: new List<string> { "31А" });

        Assert.Equal(new[] { rides31A.UserId }, notified);
    }

    [Fact]
    public async Task Send_BusLinesUnknownSentinel_KeepsFullBroadcast()
    {
        using var db = TestHelpers.NewDbContext();
        var rides18  = TestHelpers.NewUser("rides18@example.com");
        rides18.SubscribedBusLines = new List<string> { "18" };
        var noFilter = TestHelpers.NewUser("nofilter@example.com");
        db.Users.AddRange(rides18, noFilter);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        // "0" = route change with no line identified — everyone stays included
        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "t", "b", "vt", null, null,
            cityWide: true, busLines: new List<string> { "0" });

        Assert.Equal(2, notified.Count);
    }

    // ── SendUsersNotificationAsync — polygon routing & dedup ─────────────────

    [Fact]
    public async Task Send_PolygonLocation_RoutesThroughPolygonMatching()
    {
        using var db = TestHelpers.NewDbContext();
        var inside = UserAt(27.5, 43.5, "in@example.com");
        var outside = UserAt(20.0, 40.0, "out@example.com");
        db.Users.AddRange(inside, outside);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var locations = Json($$"""
            [
              {
                "location_name": "гр. Варна",
                "sublocations": ["ул. А", "ул. Б", "ул. В"],
                "is_polygon": true,
                "polygon_geojson": {{SquarePolygonGeoJson}}
              }
            ]
            """);

        var notified = await service.SendUsersNotificationAsync(
            locations, "t", "b", "vik", null, null);

        Assert.Equal(new[] { inside.UserId }, notified);
    }

    [Fact]
    public async Task Send_OverlappingPolygonLocations_NotifiesEachUserOnce()
    {
        using var db = TestHelpers.NewDbContext();
        var user = UserAt(27.5, 43.5, "in@example.com");
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var locations = Json($$"""
            [
              { "location_name": "А", "is_polygon": true, "polygon_geojson": {{SquarePolygonGeoJson}} },
              { "location_name": "Б", "is_polygon": true, "polygon_geojson": {{SquarePolygonGeoJson}} }
            ]
            """);

        var notified = await service.SendUsersNotificationAsync(
            locations, "t", "b", "vik", null, null);

        Assert.Single(notified);
    }

    // ── ReceivesAllAlerts (debug users) ──────────────────────────────────────

    [Fact]
    public async Task Send_ReceivesAllAlertsUser_NotifiedOutsideTargetArea()
    {
        using var db = TestHelpers.NewDbContext();
        var inside = UserAt(27.5, 43.5, "in@example.com");
        var debugUser = UserAt(20.0, 40.0, "debug@example.com");
        debugUser.ReceivesAllAlerts = true;
        var outside = UserAt(20.0, 40.0, "out@example.com");
        db.Users.AddRange(inside, debugUser, outside);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var locations = Json($$"""
            [
              {
                "location_name": "гр. Варна",
                "is_polygon": true,
                "polygon_geojson": {{SquarePolygonGeoJson}}
              }
            ]
            """);

        var notified = await service.SendUsersNotificationAsync(
            locations, "t", "b", "vik", null, null);

        Assert.Equal(2, notified.Count);
        Assert.Contains(inside.UserId, notified);
        Assert.Contains(debugUser.UserId, notified);
    }

    [Fact]
    public async Task Send_ReceivesAllAlertsUser_InsideTargetArea_NotifiedOnce()
    {
        using var db = TestHelpers.NewDbContext();
        var debugUser = UserAt(27.5, 43.5, "debug@example.com");
        debugUser.ReceivesAllAlerts = true;
        db.Users.Add(debugUser);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var locations = Json($$"""
            [
              { "location_name": "А", "is_polygon": true, "polygon_geojson": {{SquarePolygonGeoJson}} }
            ]
            """);

        var notified = await service.SendUsersNotificationAsync(
            locations, "t", "b", "vik", null, null);

        Assert.Equal(new[] { debugUser.UserId }, notified);
    }

    [Fact]
    public async Task Send_ReceivesAllAlertsUser_SuppressedAlertStillNotifiesNobody()
    {
        using var db = TestHelpers.NewDbContext();
        var debugUser = TestHelpers.NewUser("debug@example.com");
        debugUser.ReceivesAllAlerts = true;
        db.Users.Add(debugUser);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        // No locations + city_wide=false is a store-only misparse guard —
        // even debug users must not be notified.
        var notified = await service.SendUsersNotificationAsync(
            Json("[]"), "t", "b", "vik", null, null, cityWide: false);

        Assert.Empty(notified);
        _fcm.Verify(f => f.SendToMultipleUsersAsync(
            It.IsAny<IEnumerable<Guid>>(), It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<Dictionary<string, string>?>()), Times.Never);
    }

    // ── Notification body & data payload ─────────────────────────────────────

    private async Task<(string body, Dictionary<string, string>? data)> CaptureSend(
        string? startTime, string? endTime)
    {
        using var db = TestHelpers.NewDbContext();
        db.Users.Add(TestHelpers.NewUser());
        await db.SaveChangesAsync();
        var service = CreateService(db);

        string? sentBody = null;
        Dictionary<string, string>? sentData = null;
        _fcm
            .Setup(f => f.SendToMultipleUsersAsync(
                It.IsAny<IEnumerable<Guid>>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<Dictionary<string, string>?>()))
            .Callback((IEnumerable<Guid> ids, string title, string body,
                       Dictionary<string, string>? data) =>
            {
                sentBody = body;
                sentData = data;
            })
            .Returns(Task.CompletedTask);

        await service.SendUsersNotificationAsync(
            Json("[]"), "title", "body", "vik", startTime, endTime);

        return (sentBody!, sentData);
    }

    [Fact]
    public async Task Send_BothTimes_AppendsTimeRangeToBody()
    {
        var (body, data) = await CaptureSend("09:00", "17:00");
        Assert.Equal("body (09:00 – 17:00)", body);
        Assert.Equal("vik", data!["category"]);
        Assert.Equal("09:00", data["startTime"]);
        Assert.Equal("17:00", data["endTime"]);
    }

    [Fact]
    public async Task Send_OnlyStartTime_AppendsFromClause()
    {
        var (body, _) = await CaptureSend("09:00", null);
        Assert.Equal("body (from 09:00)", body);
    }

    [Fact]
    public async Task Send_OnlyEndTime_AppendsUntilClause()
    {
        var (body, _) = await CaptureSend(null, "17:00");
        Assert.Equal("body (until 17:00)", body);
    }

    [Fact]
    public async Task Send_NoTimes_BodyUnchangedAndDataUsesEmptyStrings()
    {
        var (body, data) = await CaptureSend(null, null);
        Assert.Equal("body", body);
        // FCM data values must never be null — empty strings instead
        Assert.Equal("", data!["startTime"]);
        Assert.Equal("", data["endTime"]);
    }
}
