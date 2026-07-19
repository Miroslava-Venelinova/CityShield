using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using CityShieldAPI.Core;
using CityShieldAPI.DTOs;
using CityShieldAPI.DTOs.Users;
using CityShieldAPI.Data.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace CityShieldAPI.Tests.Unit;

public class AuthServiceTests
{
    private static AuthService CreateService(
        Data.ApplicationDbContext context, HttpMessageHandler? nominatim = null)
    {
        nominatim ??= FakeHttpMessageHandler.Throws(new HttpRequestException("no network in unit tests"));
        // A real geocoding service over a fake HTTP handler, so the
        // Nominatim failure/fallback paths stay covered end-to-end.
        var geocoder = new NominatimGeocodingService(
            new FakeHttpClientFactory(nominatim),
            NullLogger<NominatimGeocodingService>.Instance);
        return new AuthService(context, TestHelpers.JwtOptions(), geocoder);
    }

    // ── RegisterAsync ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Register_CreatesUserWithHashedPasswordAndNoLocation()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);

        await service.RegisterAsync(new RegisterRequest
        {
            Email = "new@example.com",
            Password = "secret-password",
        });

        var user = Assert.Single(db.Users);
        Assert.Equal("new@example.com", user.Email);
        Assert.NotEqual("secret-password", user.PasswordHash);
        Assert.True(BCrypt.Net.BCrypt.Verify("secret-password", user.PasswordHash));
        Assert.Null(user.Latitude);
        Assert.Null(user.Longitude);
        Assert.Null(user.Location);
        Assert.Null(user.RegionId);
        Assert.Null(user.StreetId);
    }

    [Fact]
    public async Task Register_DuplicateEmail_Throws()
    {
        using var db = TestHelpers.NewDbContext();
        db.Users.Add(TestHelpers.NewUser("taken@example.com"));
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.RegisterAsync(new RegisterRequest
            {
                Email = "taken@example.com",
                Password = "irrelevant123",
            }));
        Assert.Contains("already exists", ex.Message);
        Assert.Equal(1, db.Users.Count());
    }

    // ── LoginAsync ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Login_ValidCredentials_ReturnsJwtWithExpectedClaims()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser("login@example.com", "correct-password");
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var token = await service.LoginAsync(new LoginRequest
        {
            Email = "login@example.com",
            Password = "correct-password",
        });

        Assert.NotNull(token);
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);
        Assert.Equal(TestHelpers.JwtSettings.Issuer, jwt.Issuer);
        Assert.Contains(TestHelpers.JwtSettings.Audience, jwt.Audiences);
        // AuthService builds JwtSecurityToken directly, so claim types keep
        // their full ClaimTypes URIs (no short-name outbound mapping).
        Assert.Equal(user.UserId.ToString(),
            jwt.Claims.First(c => c.Type == ClaimTypes.NameIdentifier).Value);
        Assert.Equal("login@example.com",
            jwt.Claims.First(c => c.Type == ClaimTypes.Email).Value);
        // Expiry honours ExpireMinutes (with a minute of slack)
        Assert.InRange(jwt.ValidTo,
            DateTime.UtcNow.AddMinutes(TestHelpers.JwtSettings.ExpireMinutes - 1),
            DateTime.UtcNow.AddMinutes(TestHelpers.JwtSettings.ExpireMinutes + 1));
    }

    [Fact]
    public async Task Login_WrongPassword_ReturnsNull()
    {
        using var db = TestHelpers.NewDbContext();
        db.Users.Add(TestHelpers.NewUser("login@example.com", "correct-password"));
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var token = await service.LoginAsync(new LoginRequest
        {
            Email = "login@example.com",
            Password = "wrong-password",
        });

        Assert.Null(token);
    }

    [Fact]
    public async Task Login_UnknownEmail_ReturnsNull()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);

        var token = await service.LoginAsync(new LoginRequest
        {
            Email = "ghost@example.com",
            Password = "whatever123",
        });

        Assert.Null(token);
    }

    // ── GetUserDataAsync ──────────────────────────────────────────────────────

    [Fact]
    public async Task GetUserData_ReturnsProfileWithRegionAndStreetNames()
    {
        using var db = TestHelpers.NewDbContext();
        var region = new Region { Id = 1, RegionName = "Аспарухово" };
        var street = new Street { Id = 2, StreetName = "ул. Дубровник" };
        var user = TestHelpers.NewUser("me@example.com");
        user.Latitude = 43.2;
        user.Longitude = 27.9;
        user.RegionId = region.Id;
        user.Region = region;
        user.StreetId = street.Id;
        user.Street = street;
        db.AddRange(region, street, user);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var dto = await service.GetUserDataAsync(user.UserId.ToString());

        Assert.Equal("me@example.com", dto.Email);
        Assert.Equal(43.2, dto.Latitude);
        Assert.Equal(27.9, dto.Longitude);
        Assert.True(dto.HasLocation);
        Assert.Equal("Аспарухово", dto.RegionName);
        Assert.Equal("ул. Дубровник", dto.StreetName);
    }

    [Fact]
    public async Task GetUserData_UserWithoutLocation_HasLocationFalse()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = CreateService(db);

        var dto = await service.GetUserDataAsync(user.UserId.ToString());

        Assert.False(dto.HasLocation);
        Assert.Null(dto.RegionName);
        Assert.Null(dto.StreetName);
    }

    [Fact]
    public async Task GetUserData_UnknownUser_ThrowsArgumentException()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            service.GetUserDataAsync(Guid.NewGuid().ToString()));
    }

    // ── UpdateLocationAsync ───────────────────────────────────────────────────
    // The Nominatim-success path runs raw pg_trgm SQL and is covered by the
    // PostgreSQL integration tests; here we cover the failure/fallback paths.

    [Fact]
    public async Task UpdateLocation_UnknownUser_ThrowsArgumentException()
    {
        using var db = TestHelpers.NewDbContext();
        var service = CreateService(db);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            service.UpdateLocationAsync(Guid.NewGuid().ToString(),
                new UpdateLocationRequest { Latitude = 43.2, Longitude = 27.9 }));
    }

    [Fact]
    public async Task UpdateLocation_NominatimUnreachable_StillPersistsCoordinates()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = CreateService(db,
            FakeHttpMessageHandler.Throws(new HttpRequestException("timeout")));

        await service.UpdateLocationAsync(user.UserId.ToString(),
            new UpdateLocationRequest { Latitude = 43.2, Longitude = 27.9 });

        var saved = db.Users.Single();
        Assert.Equal(43.2, saved.Latitude);
        Assert.Equal(27.9, saved.Longitude);
        Assert.NotNull(saved.Location);
        Assert.Equal(27.9, saved.Location!.X); // X = longitude
        Assert.Equal(43.2, saved.Location!.Y); // Y = latitude
        Assert.Equal(4326, saved.Location!.SRID);
        Assert.Null(saved.RegionId);
        Assert.Null(saved.StreetId);
    }

    [Fact]
    public async Task UpdateLocation_NominatimResponseWithoutAddress_PersistsCoordinatesOnly()
    {
        using var db = TestHelpers.NewDbContext();
        var user = TestHelpers.NewUser();
        db.Users.Add(user);
        await db.SaveChangesAsync();
        var service = CreateService(db,
            FakeHttpMessageHandler.Json("""{"error": "Unable to geocode"}"""));

        await service.UpdateLocationAsync(user.UserId.ToString(),
            new UpdateLocationRequest { Latitude = 43.2, Longitude = 27.9 });

        var saved = db.Users.Single();
        Assert.Equal(43.2, saved.Latitude);
        Assert.Null(saved.RegionId);
    }
}
