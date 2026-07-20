using System.Text.Json;
using CityShieldAPI.Core;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.DTOs.Users;
using CityShieldAPI.Data.Models;
using Moq;
using NetTopologySuite;
using NetTopologySuite.Geometries;
using Xunit;

namespace CityShieldAPI.Tests.Integration;

/// <summary>
/// Exercises the raw-SQL paths that cannot run on the EF InMemory provider:
/// pg_trgm fuzzy matching (region_name % ..., similarity(...)) and PostGIS
/// polygon containment, against a real PostgreSQL container.
/// </summary>
[Collection("Postgres")]
public class AlertServiceIntegrationTests : IAsyncLifetime
{
    private readonly PostgresFixture _pg;
    private readonly GeometryFactory _geometry =
        NtsGeometryServices.Instance.CreateGeometryFactory(srid: 4326);

    private Region _asparuhovo = null!;
    private Region _mladost = null!;
    private Street _dubrovnik = null!;
    private User _userOnDubrovnik = null!;
    private User _userElsewhereInAsparuhovo = null!;
    private User _userInMladost = null!;

    public AlertServiceIntegrationTests(PostgresFixture pg) => _pg = pg;

    public async Task InitializeAsync()
    {
        await _pg.ResetAsync();

        await using var db = _pg.CreateContext();
        _asparuhovo = new Region { RegionName = "Аспарухово" };
        _mladost = new Region { RegionName = "Младост" };
        _dubrovnik = new Street { StreetName = "ул. Дубровник" };
        var studentska = new Street { StreetName = "ул. Студентска" };
        db.AddRange(_asparuhovo, _mladost, _dubrovnik, studentska);
        await db.SaveChangesAsync();

        _userOnDubrovnik = TestHelpers.NewUser("dubrovnik@example.com");
        _userOnDubrovnik.RegionId = _asparuhovo.Id;
        _userOnDubrovnik.StreetId = _dubrovnik.Id;

        _userElsewhereInAsparuhovo = TestHelpers.NewUser("asparuhovo@example.com");
        _userElsewhereInAsparuhovo.RegionId = _asparuhovo.Id;
        _userElsewhereInAsparuhovo.StreetId = studentska.Id;

        _userInMladost = TestHelpers.NewUser("mladost@example.com");
        _userInMladost.RegionId = _mladost.Id;

        db.Users.AddRange(_userOnDubrovnik, _userElsewhereInAsparuhovo, _userInMladost);
        await db.SaveChangesAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private AlertService CreateService(Data.ApplicationDbContext db) =>
        new(db, Mock.Of<IFcmTokenService>(), new NotificationPreferencesService(db),
            Mock.Of<IGeocodingService>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<AlertService>.Instance);

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement;

    // ── pg_trgm fuzzy matching ───────────────────────────────────────────────

    [Fact]
    public async Task FuzzyRegionAndStreet_MatchesDespiteAbbreviations()
    {
        await using var db = _pg.CreateContext();
        var service = CreateService(db);

        // Scraper output rarely matches the DB spelling exactly:
        // "кв. Аспарухово" vs "Аспарухово", "Дубровник" vs "ул. Дубровник".
        var location = Json("""
            { "location_name": "кв. Аспарухово", "sublocations": ["Дубровник"] }
            """);

        var users = await service.GetUsersInRangeAsync(location);

        var match = Assert.Single(users);
        Assert.Equal(_userOnDubrovnik.UserId, match.UserId);
    }

    [Fact]
    public async Task RegionWithoutSublocations_MatchesWholeRegion()
    {
        await using var db = _pg.CreateContext();
        var service = CreateService(db);

        var location = Json("""
            { "location_name": "Аспарухово", "sublocations": [] }
            """);

        var users = await service.GetUsersInRangeAsync(location);

        Assert.Equal(2, users.Count);
        Assert.DoesNotContain(users, u => u.UserId == _userInMladost.UserId);
    }

    [Fact]
    public async Task CompletelyUnknownRegion_ReturnsNoUsers()
    {
        await using var db = _pg.CreateContext();
        var service = CreateService(db);

        var location = Json("""
            { "location_name": "Шумен", "sublocations": [] }
            """);

        var users = await service.GetUsersInRangeAsync(location);

        Assert.Empty(users);
    }

    [Fact]
    public async Task UnknownStreetInKnownRegion_ReturnsNoUsers()
    {
        await using var db = _pg.CreateContext();
        var service = CreateService(db);

        var location = Json("""
            { "location_name": "Аспарухово", "sublocations": ["Крайезерна магистрала"] }
            """);

        var users = await service.GetUsersInRangeAsync(location);

        // The dissimilar street name must not fuzzy-match ул. Дубровник/Студентска
        Assert.Empty(users);
    }

    // ── PostGIS polygon containment (ST_Contains through EF LINQ) ───────────

    [Fact]
    public async Task PolygonContainment_TranslatesToPostGis()
    {
        await using var db = _pg.CreateContext();
        var inside = TestHelpers.NewUser("inside-poly@example.com");
        inside.Location = _geometry.CreatePoint(new Coordinate(27.5, 43.5));
        var outside = TestHelpers.NewUser("outside-poly@example.com");
        outside.Location = _geometry.CreatePoint(new Coordinate(20.0, 40.0));
        db.Users.AddRange(inside, outside);
        await db.SaveChangesAsync();

        var service = CreateService(db);
        var geojson = Json("""
            {
              "features": [
                { "geometry": { "coordinates": [[[27,43],[28,43],[28,44],[27,44],[27,43]]] } }
              ]
            }
            """);

        var users = await service.GetUsersInPolygonRangeAsync(geojson);

        var match = Assert.Single(users);
        Assert.Equal(inside.UserId, match.UserId);
    }

    // ── AuthService.UpdateLocationAsync — geocode + fuzzy match end-to-end ──

    [Fact]
    public async Task UpdateLocation_GeocodesAndFuzzyMatchesRegionAndStreet()
    {
        await using var db = _pg.CreateContext();
        var user = TestHelpers.NewUser("locate-me@example.com");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        // Nominatim reply with both suburb and city: suburb must win.
        var nominatim = FakeHttpMessageHandler.Json("""
            {
              "address": {
                "road": "Дубровник",
                "suburb": "Аспарухово",
                "city": "Варна"
              }
            }
            """);
        var service = new AuthService(
            db, TestHelpers.JwtOptions(),
            new NominatimGeocodingService(
                new FakeHttpClientFactory(nominatim),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<NominatimGeocodingService>.Instance));

        await service.UpdateLocationAsync(user.UserId.ToString(),
            new UpdateLocationRequest { Latitude = 43.18, Longitude = 27.89 });

        await using var verify = _pg.CreateContext();
        var saved = verify.Users.Single(u => u.UserId == user.UserId);
        Assert.Equal(_asparuhovo.Id, saved.RegionId);   // suburb, not city
        Assert.Equal(_dubrovnik.Id, saved.StreetId);
        Assert.Equal(43.18, saved.Latitude);
        Assert.NotNull(saved.Location);
    }
}
