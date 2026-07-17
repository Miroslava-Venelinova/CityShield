using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data.Models;
using CityShieldAPI.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;

namespace CityShieldAPI.Tests.Integration;

/// <summary>Records every FCM send instead of talking to Firebase.</summary>
public class RecordingFirebaseMessenger : IFirebaseMessenger
{
    public record Sent(IReadOnlyList<string> Tokens, string Title, string Body,
        Dictionary<string, string>? Data);

    public List<Sent> Sends { get; } = new();

    public Task<IReadOnlyList<FcmSendOutcome>> SendMulticastAsync(
        IReadOnlyList<string> tokens, string title, string body,
        Dictionary<string, string>? data = null)
    {
        Sends.Add(new Sent(tokens, title, body, data));
        IReadOnlyList<FcmSendOutcome> outcomes =
            tokens.Select(_ => new FcmSendOutcome(true, false)).ToList();
        return Task.FromResult(outcomes);
    }
}

/// <summary>
/// Boots the real ASP.NET pipeline (routing, JWT auth, controllers, EF with
/// Npgsql) against the shared PostgreSQL container. Firebase is replaced by
/// a recorder and Nominatim by a canned HTTP handler.
/// </summary>
[Collection("Postgres")]
public class ApiIntegrationTests : IAsyncLifetime
{
    private readonly PostgresFixture _pg;
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;
    private readonly RecordingFirebaseMessenger _fcm = new();

    public ApiIntegrationTests(PostgresFixture pg)
    {
        _pg = pg;
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureTestServices(services =>
            {
                // Config-level connection-string overrides are applied BEFORE
                // appsettings.json in minimal-hosting apps and silently lose,
                // sending tests to the developer database. Re-registering the
                // DbContext here runs after Program.cs and always wins.
                services.RemoveAll<DbContextOptions<ApplicationDbContext>>();
                services.RemoveAll<ApplicationDbContext>();
                services.AddDbContext<ApplicationDbContext>(options =>
                    options.UseNpgsql(_pg.DataSource, o => o.UseNetTopologySuite()));

                services.RemoveAll<IFirebaseMessenger>();
                services.AddSingleton<IFirebaseMessenger>(_fcm);

                // Canned Nominatim reverse-geocode reply
                services.AddHttpClient("Nominatim")
                    .ConfigurePrimaryHttpMessageHandler(() =>
                        FakeHttpMessageHandler.Json("""
                            {
                              "address": {
                                "road": "Дубровник",
                                "suburb": "Аспарухово"
                              }
                            }
                            """));
            });
        });
        _client = _factory.CreateClient();
    }

    public async Task InitializeAsync()
    {
        await _pg.ResetAsync();
        await using var db = _pg.CreateContext();
        db.AddRange(
            new Region { RegionName = "Аспарухово" },
            new Region { RegionName = "Младост" },
            new Street { StreetName = "ул. Дубровник" });
        await db.SaveChangesAsync();
    }

    public Task DisposeAsync()
    {
        _factory.Dispose();
        return Task.CompletedTask;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private async Task<string> RegisterAndLoginAsync(string email)
    {
        var register = await _client.PostAsJsonAsync("/api/auth/register",
            new { email, password = "password-123" });
        Assert.True(register.StatusCode == HttpStatusCode.OK,
            $"register failed: {register.StatusCode} — {await register.Content.ReadAsStringAsync()}");

        var login = await _client.PostAsJsonAsync("/api/auth/login",
            new { email, password = "password-123" });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        var body = await login.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("token").GetString()!;
    }

    private static HttpRequestMessage Authorized(HttpMethod method, string url,
        string token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) request.Content = JsonContent.Create(body);
        return request;
    }

    // ── auth flow ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Register_Login_Me_FullFlow()
    {
        var token = await RegisterAndLoginAsync("flow@example.com");

        var me = await _client.SendAsync(
            Authorized(HttpMethod.Get, "/api/auth/me", token));

        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        var profile = await me.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("flow@example.com", profile.GetProperty("email").GetString());
        Assert.False(profile.GetProperty("hasLocation").GetBoolean());
    }

    [Fact]
    public async Task Register_DuplicateEmail_Returns409()
    {
        await RegisterAndLoginAsync("dupe@example.com");

        var second = await _client.PostAsJsonAsync("/api/auth/register",
            new { email = "dupe@example.com", password = "password-123" });

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
    }

    [Fact]
    public async Task Login_WrongPassword_Returns401()
    {
        await RegisterAndLoginAsync("badpass@example.com");

        var login = await _client.PostAsJsonAsync("/api/auth/login",
            new { email = "badpass@example.com", password = "wrong-password" });

        Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
    }

    [Fact]
    public async Task ProtectedEndpoints_WithoutToken_Return401()
    {
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await _client.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await _client.GetAsync("/api/preferences")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await _client.PostAsJsonAsync("/api/tokens", new { token = "x" })).StatusCode);
    }

    // ── preferences ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Preferences_DefaultAllEnabled_ThenDisableOne()
    {
        var token = await RegisterAndLoginAsync("prefs@example.com");

        var all = await _client.SendAsync(
            Authorized(HttpMethod.Get, "/api/preferences", token));
        var prefs = await all.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(5, prefs.GetArrayLength());

        var disable = await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/preferences/vik", token, new { isEnabled = false }));
        Assert.Equal(HttpStatusCode.NoContent, disable.StatusCode);

        var refreshed = await _client.SendAsync(
            Authorized(HttpMethod.Get, "/api/preferences", token));
        var updated = await refreshed.Content.ReadFromJsonAsync<JsonElement>();
        var vik = updated.EnumerateArray()
            .Single(p => p.GetProperty("category").GetString() == "vik");
        Assert.False(vik.GetProperty("isEnabled").GetBoolean());
    }

    [Fact]
    public async Task Preferences_UnknownCategory_Returns400()
    {
        var token = await RegisterAndLoginAsync("prefs400@example.com");

        var response = await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/preferences/sewers", token, new { isEnabled = false }));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ── alerts ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task SubmitData_UnknownCategory_Returns400()
    {
        var response = await _client.PostAsJsonAsync("/api/alerts/submit-data", new
        {
            category = "sewers",
            original_message = new { title = "t", content = "c" },
            processed_data = new { locations = Array.Empty<object>() },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task ScraperAlert_EndToEnd_NotifiesUserOnAffectedStreet()
    {
        // 1. A user registers, sets their location (canned Nominatim reply puts
        //    them on ул. Дубровник in Аспарухово) and registers a device token.
        var token = await RegisterAndLoginAsync("victim@example.com");

        var location = await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/auth/location", token,
            new { latitude = 43.18, longitude = 27.89 }));
        Assert.Equal(HttpStatusCode.NoContent, location.StatusCode);

        var device = await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/tokens", token,
            new { token = "device-token-1", platform = "android", deviceName = "Pixel" }));
        Assert.Equal(HttpStatusCode.NoContent, device.StatusCode);

        // 2. The Python scraper submits a water outage on that street.
        var alert = await _client.PostAsJsonAsync("/api/alerts/submit-data", new
        {
            id = Guid.NewGuid().ToString(),
            category = "vik",
            original_message = new
            {
                title = "Авария на водопровод",
                content = "Спряно водоподаване на ул. Дубровник",
            },
            processed_data = new
            {
                locations = new[]
                {
                    new
                    {
                        location_name = "кв. Аспарухово",
                        sublocations = new[] { "Дубровник" },
                        is_polygon = false,
                    },
                },
                start_time = "09:00",
                end_time = "17:00",
            },
        });

        // 3. The user is matched and the notification reaches their device.
        Assert.Equal(HttpStatusCode.OK, alert.StatusCode);
        var result = await alert.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, result.GetProperty("notified_count").GetInt32());

        var sent = Assert.Single(_fcm.Sends);
        Assert.Equal(new[] { "device-token-1" }, sent.Tokens);
        Assert.Equal("Авария на водопровод", sent.Title);
        Assert.EndsWith("(09:00 – 17:00)", sent.Body);
        Assert.Equal("vik", sent.Data!["category"]);
    }

    [Fact]
    public async Task ScraperAlert_UserWithCategoryDisabled_IsNotNotified()
    {
        var token = await RegisterAndLoginAsync("optout@example.com");
        await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/auth/location", token,
            new { latitude = 43.18, longitude = 27.89 }));
        await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/tokens", token,
            new { token = "optout-device", platform = "android", deviceName = "P" }));
        await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/preferences/vik", token, new { isEnabled = false }));

        var alert = await _client.PostAsJsonAsync("/api/alerts/submit-data", new
        {
            id = Guid.NewGuid().ToString(),
            category = "vik",
            original_message = new { title = "Авария", content = "ул. Дубровник" },
            processed_data = new
            {
                locations = new[]
                {
                    new
                    {
                        location_name = "Аспарухово",
                        sublocations = new[] { "Дубровник" },
                        is_polygon = false,
                    },
                },
                start_time = (string?)null,
                end_time = (string?)null,
            },
        });

        Assert.Equal(HttpStatusCode.OK, alert.StatusCode);
        var result = await alert.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, result.GetProperty("notified_count").GetInt32());
        Assert.Empty(_fcm.Sends);
    }

    [Fact]
    public async Task SubmittedAlert_IsStored_AndReturnedByRecent()
    {
        var token = await RegisterAndLoginAsync("mapreader@example.com");

        // Polygon alert: the FeatureCollection from the scraper must come back
        // as a bare GeoJSON geometry with a centroid pin.
        var submit = await _client.PostAsJsonAsync("/api/alerts/submit-data", new
        {
            id = Guid.NewGuid().ToString(),
            category = "vik",
            original_message = new
            {
                title = "Авария на водопровод",
                content = "Затворени улици в карето",
            },
            processed_data = new
            {
                locations = new object[]
                {
                    new
                    {
                        location_name = "кв. Аспарухово",
                        sublocations = new[] { "ул. А", "ул. Б", "ул. В" },
                        is_polygon = true,
                        polygon_geojson = new
                        {
                            type = "FeatureCollection",
                            features = new object[]
                            {
                                new
                                {
                                    type = "Feature",
                                    geometry = new
                                    {
                                        type = "Polygon",
                                        coordinates = new[]
                                        {
                                            new[]
                                            {
                                                new[] { 27.0, 43.0 },
                                                new[] { 28.0, 43.0 },
                                                new[] { 28.0, 44.0 },
                                                new[] { 27.0, 44.0 },
                                                new[] { 27.0, 43.0 },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                start_time = "09:00",
                end_time = "17:00",
            },
        });
        Assert.Equal(HttpStatusCode.OK, submit.StatusCode);

        // Unauthenticated read is rejected
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await _client.GetAsync("/api/alerts/recent")).StatusCode);

        var recent = await _client.SendAsync(
            Authorized(HttpMethod.Get, "/api/alerts/recent", token));
        Assert.Equal(HttpStatusCode.OK, recent.StatusCode);

        var alerts = await recent.Content.ReadFromJsonAsync<JsonElement>();
        var alert = Assert.Single(alerts.EnumerateArray());

        Assert.Equal("vik", alert.GetProperty("source").GetString());
        Assert.Equal("warning", alert.GetProperty("severity").GetString());
        Assert.Equal("Авария на водопровод",
            alert.GetProperty("original_message").GetProperty("title").GetString());

        var processed = alert.GetProperty("processed_data");
        Assert.Equal("09:00", processed.GetProperty("start_time").GetString());

        var location = Assert.Single(processed.GetProperty("locations").EnumerateArray());
        Assert.True(location.GetProperty("is_polygon").GetBoolean());

        // Normalized to a bare geometry the app can hand straight to Leaflet
        var polygon = location.GetProperty("polygon_geojson");
        Assert.Equal("Polygon", polygon.GetProperty("type").GetString());
        Assert.Equal(5, polygon.GetProperty("coordinates")[0].GetArrayLength());

        // Centroid pin of the square (ring average: closing point weighs 27 twice)
        Assert.Equal(43.4, location.GetProperty("lat").GetDouble(), precision: 1);
        Assert.Equal(27.4, location.GetProperty("lng").GetDouble(), precision: 1);
    }

    // ── account deletion ─────────────────────────────────────────────────────

    [Fact]
    public async Task DeleteMe_RemovesAccountAndEverythingKeyedToIt()
    {
        var token = await RegisterAndLoginAsync("erasure@example.com");
        await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/auth/location", token,
            new { latitude = 43.18, longitude = 27.89 }));
        await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/tokens", token,
            new { token = "erasure-device", platform = "android", deviceName = "P" }));
        await _client.SendAsync(Authorized(
            HttpMethod.Put, "/api/preferences/vik", token, new { isEnabled = false }));

        var delete = await _client.SendAsync(
            Authorized(HttpMethod.Delete, "/api/auth/me", token));
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        // The account is gone (token still validates cryptographically, but
        // the user row no longer exists) …
        var me = await _client.SendAsync(
            Authorized(HttpMethod.Get, "/api/auth/me", token));
        Assert.Equal(HttpStatusCode.NotFound, me.StatusCode);

        // … along with every row keyed to it (FK cascade + explicit deletes).
        await using var db = _pg.CreateContext();
        Assert.Empty(db.Users.Where(u => u.Email == "erasure@example.com"));
        Assert.Empty(db.DeviceTokens.Where(t => t.Token == "erasure-device"));
        Assert.Empty(db.UserNotificationPreferences);
    }

    [Fact]
    public async Task DeleteMe_WithoutToken_Returns401()
    {
        var response = await _client.DeleteAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── maintenance & health ─────────────────────────────────────────────────

    [Fact]
    public async Task Healthz_ReturnsOkWithoutAuth()
    {
        var response = await _client.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("ok", body.GetProperty("status").GetString());
    }

    [Fact]
    public async Task CleanupTokens_PurgesOnlyStaleTokens()
    {
        var token = await RegisterAndLoginAsync("cleanup@example.com");
        await _client.SendAsync(Authorized(
            HttpMethod.Post, "/api/tokens", token,
            new { token = "fresh-device", platform = "android", deviceName = "P" }));

        await using (var db = _pg.CreateContext())
        {
            var stale = await db.DeviceTokens.SingleAsync();
            db.DeviceTokens.Add(new DeviceToken
            {
                UserId = stale.UserId,
                Token = "stale-device",
                LastSeenAt = DateTime.UtcNow.AddDays(-90),
            });
            await db.SaveChangesAsync();
        }

        // No ingest key is configured under Testing, so the endpoint is open
        // (mirrors the local-dev behavior of the ingest endpoints).
        var response = await _client.PostAsync("/api/maintenance/cleanup-tokens", null);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        await using (var check = _pg.CreateContext())
        {
            var remaining = await check.DeviceTokens.Select(t => t.Token).ToListAsync();
            Assert.Equal(new[] { "fresh-device" }, remaining);
        }
    }

    // ── device tokens ────────────────────────────────────────────────────────

    [Fact]
    public async Task Tokens_RegisterAndUnregister_RoundTrip()
    {
        var token = await RegisterAndLoginAsync("devices@example.com");

        await _client.SendAsync(Authorized(HttpMethod.Post, "/api/tokens", token,
            new { token = "roundtrip-tok", platform = "web", deviceName = "Chrome" }));

        await using (var db = _pg.CreateContext())
            Assert.Single(db.DeviceTokens.Where(t => t.Token == "roundtrip-tok"));

        var unregister = await _client.SendAsync(Authorized(
            HttpMethod.Delete, "/api/tokens", token, new { token = "roundtrip-tok" }));
        Assert.Equal(HttpStatusCode.NoContent, unregister.StatusCode);

        await using (var db = _pg.CreateContext())
            Assert.Empty(db.DeviceTokens.Where(t => t.Token == "roundtrip-tok"));
    }
}
