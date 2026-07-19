using System.Text.Json;
using CityShieldAPI.Controllers;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.DTOs;
using CityShieldAPI.DTOs.Alerts;
using CityShieldAPI.DTOs.Preferences;
using CityShieldAPI.DTOs.Users;
using CityShieldAPI.Data.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace CityShieldAPI.Tests.Unit;

// ── AlertsController ─────────────────────────────────────────────────────────

public class AlertsControllerTests
{
    private readonly Mock<IAlertService> _alerts = new();

    // Built from JSON (not object initializers) so the snake_case binding of
    // SubmitAlertRequest stays exercised.
    private static SubmitAlertRequest Payload(
        string? category = "vik",
        string title = "Заглавие",
        string content = "Съдържание",
        string? startTime = "09:00",
        string? endTime = "17:00",
        string[]? busLines = null)
    {
        var categoryPart = category is null ? "" : $"\"category\": \"{category}\",";
        var busLinesPart = busLines is null
            ? ""
            : $",\"bus_lines\": [{string.Join(",", busLines.Select(l => $"\"{l}\""))}]";
        var json = $$"""
            {
                "id": "abc-123",
                {{categoryPart}}
                "original_message": { "title": "{{title}}", "content": "{{content}}" },
                "processed_data": {
                    "locations": [],
                    "start_time": {{(startTime is null ? "null" : $"\"{startTime}\"")}},
                    "end_time": {{(endTime is null ? "null" : $"\"{endTime}\"")}}
                    {{busLinesPart}}
                }
            }
            """;
        return JsonSerializer.Deserialize<SubmitAlertRequest>(json)!;
    }

    [Fact]
    public async Task SubmitData_ValidPayload_ReturnsNotifiedUsers()
    {
        var ids = new List<Guid> { Guid.NewGuid() };
        _alerts
            .Setup(a => a.SendUsersNotificationAsync(
                It.IsAny<JsonElement>(), "Заглавие", "Съдържание", "epro", "09:00", "17:00",
                It.IsAny<bool?>(), It.IsAny<List<string>?>()))
            .ReturnsAsync(ids);
        var controller = new AlertsController(_alerts.Object, NullLogger<AlertsController>.Instance);

        var result = await controller.SubmitData(Payload(category: "epro"));

        var ok = Assert.IsType<OkObjectResult>(result);
        _alerts.VerifyAll();
        // Response contains the count and the ids
        var json = JsonSerializer.Serialize(ok.Value);
        Assert.Contains("\"notified_count\":1", json);
    }

    [Fact]
    public async Task SubmitData_UnknownCategory_ReturnsBadRequestWithoutDispatching()
    {
        var controller = new AlertsController(_alerts.Object, NullLogger<AlertsController>.Instance);

        var result = await controller.SubmitData(Payload(category: "sewers"));

        Assert.IsType<BadRequestObjectResult>(result);
        _alerts.Verify(a => a.SendUsersNotificationAsync(
            It.IsAny<JsonElement>(), It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
            It.IsAny<bool?>(), It.IsAny<List<string>?>()), Times.Never);
    }

    [Fact]
    public async Task SubmitData_MissingCategory_DefaultsToVik()
    {
        string? usedCategory = null;
        _alerts
            .Setup(a => a.SendUsersNotificationAsync(
                It.IsAny<JsonElement>(), It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<bool?>(), It.IsAny<List<string>?>()))
            .Callback((JsonElement l, string t, string c, string cat, string? s, string? e,
                       bool? cw, List<string>? bl)
                => usedCategory = cat)
            .ReturnsAsync(new List<Guid>());
        var controller = new AlertsController(_alerts.Object, NullLogger<AlertsController>.Instance);

        await controller.SubmitData(Payload(category: null));

        Assert.Equal("vik", usedCategory);
    }

    [Fact]
    public async Task SubmitData_NullTimes_ArePassedAsNull()
    {
        (string?, string?)? times = null;
        _alerts
            .Setup(a => a.SendUsersNotificationAsync(
                It.IsAny<JsonElement>(), It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<bool?>(), It.IsAny<List<string>?>()))
            .Callback((JsonElement l, string t, string c, string cat, string? s, string? e,
                       bool? cw, List<string>? bl)
                => times = (s, e))
            .ReturnsAsync(new List<Guid>());
        var controller = new AlertsController(_alerts.Object, NullLogger<AlertsController>.Instance);

        await controller.SubmitData(Payload(startTime: null, endTime: null));

        Assert.Equal((null, null), times);
    }

    [Fact]
    public async Task SubmitData_BusLines_ArePassedToDispatch()
    {
        List<string>? usedBusLines = null;
        _alerts
            .Setup(a => a.SendUsersNotificationAsync(
                It.IsAny<JsonElement>(), It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<bool?>(), It.IsAny<List<string>?>()))
            .Callback((JsonElement l, string t, string c, string cat, string? s, string? e,
                       bool? cw, List<string>? bl)
                => usedBusLines = bl)
            .ReturnsAsync(new List<Guid>());
        var controller = new AlertsController(_alerts.Object, NullLogger<AlertsController>.Instance);

        await controller.SubmitData(Payload(category: "vt", busLines: new[] { "18", "31A" }));

        Assert.Equal(new List<string> { "18", "31A" }, usedBusLines);
    }
}

// ── AuthController ───────────────────────────────────────────────────────────

public class AuthControllerTests
{
    private readonly Mock<IAuthService> _auth = new();

    [Fact]
    public async Task Login_ValidCredentials_ReturnsToken()
    {
        _auth.Setup(a => a.LoginAsync(It.IsAny<LoginRequest>())).ReturnsAsync("jwt-token");
        var controller = new AuthController(_auth.Object);

        var result = await controller.Login(
            new LoginRequest { Email = "a@b.com", Password = "pass" });

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.Contains("jwt-token", JsonSerializer.Serialize(ok.Value));
    }

    [Fact]
    public async Task Login_InvalidCredentials_ReturnsUnauthorized()
    {
        _auth.Setup(a => a.LoginAsync(It.IsAny<LoginRequest>())).ReturnsAsync((string?)null);
        var controller = new AuthController(_auth.Object);

        var result = await controller.Login(
            new LoginRequest { Email = "a@b.com", Password = "wrong" });

        Assert.IsType<UnauthorizedObjectResult>(result);
    }

    [Fact]
    public async Task Register_Success_ReturnsOk()
    {
        var controller = new AuthController(_auth.Object);

        var result = await controller.Register(
            new RegisterRequest { Email = "a@b.com", Password = "password123" });

        Assert.IsType<OkObjectResult>(result);
        _auth.Verify(a => a.RegisterAsync(It.IsAny<RegisterRequest>()), Times.Once);
    }

    [Fact]
    public async Task Register_DuplicateEmail_ReturnsConflict()
    {
        _auth.Setup(a => a.RegisterAsync(It.IsAny<RegisterRequest>()))
             .ThrowsAsync(new InvalidOperationException("An account with this email already exists"));
        var controller = new AuthController(_auth.Object);

        var result = await controller.Register(
            new RegisterRequest { Email = "a@b.com", Password = "password123" });

        Assert.IsType<ConflictObjectResult>(result);
    }

    [Fact]
    public async Task Me_ReturnsProfileForAuthenticatedUser()
    {
        var userId = Guid.NewGuid();
        var dto = new UserDTO { Email = "a@b.com", HasLocation = false };
        _auth.Setup(a => a.GetUserDataAsync(userId.ToString())).ReturnsAsync(dto);
        var controller = new AuthController(_auth.Object).WithUser(userId);

        var result = await controller.Me();

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.Same(dto, ok.Value);
    }

    [Fact]
    public async Task Me_UnknownUser_ReturnsNotFound()
    {
        var userId = Guid.NewGuid();
        _auth.Setup(a => a.GetUserDataAsync(userId.ToString()))
             .ThrowsAsync(new ArgumentException("User does not exist"));
        var controller = new AuthController(_auth.Object).WithUser(userId);

        var result = await controller.Me();

        Assert.IsType<NotFoundObjectResult>(result);
    }

    [Fact]
    public async Task UpdateLocation_Success_ReturnsNoContent()
    {
        var userId = Guid.NewGuid();
        var controller = new AuthController(_auth.Object).WithUser(userId);
        var request = new UpdateLocationRequest { Latitude = 43.2, Longitude = 27.9 };

        var result = await controller.UpdateLocation(request);

        Assert.IsType<NoContentResult>(result);
        _auth.Verify(a => a.UpdateLocationAsync(userId.ToString(), request), Times.Once);
    }

    [Fact]
    public async Task UpdateLocation_UnknownUser_ReturnsNotFound()
    {
        var userId = Guid.NewGuid();
        _auth.Setup(a => a.UpdateLocationAsync(
                It.IsAny<string>(), It.IsAny<UpdateLocationRequest>()))
             .ThrowsAsync(new ArgumentException("User does not exist"));
        var controller = new AuthController(_auth.Object).WithUser(userId);

        var result = await controller.UpdateLocation(
            new UpdateLocationRequest { Latitude = 1, Longitude = 2 });

        Assert.IsType<NotFoundObjectResult>(result);
    }
}

// ── TokensController ─────────────────────────────────────────────────────────

public class TokensControllerTests
{
    private readonly Mock<IFcmTokenService> _fcm = new();

    [Fact]
    public async Task Register_UpsertsTokenForAuthenticatedUser()
    {
        var userId = Guid.NewGuid();
        var controller = new TokensController(_fcm.Object).WithUser(userId);

        var result = await controller.Register(
            new RegisterTokenRequest("tok-1", "android", "Pixel"));

        Assert.IsType<NoContentResult>(result);
        _fcm.Verify(f => f.UpsertTokenAsync(userId, "tok-1", "android", "Pixel"), Times.Once);
    }

    [Fact]
    public async Task Unregister_RemovesTokenForAuthenticatedUser()
    {
        var userId = Guid.NewGuid();
        var controller = new TokensController(_fcm.Object).WithUser(userId);

        var result = await controller.Unregister(new UnregisterTokenRequest("tok-1"));

        Assert.IsType<NoContentResult>(result);
        _fcm.Verify(f => f.RemoveTokenAsync(userId, "tok-1"), Times.Once);
    }
}

// ── NotificationPreferencesController ────────────────────────────────────────

public class NotificationPreferencesControllerTests
{
    private readonly Mock<INotificationPreferencesService> _prefs = new();

    [Fact]
    public async Task GetAll_ReturnsPreferences()
    {
        var userId = Guid.NewGuid();
        var prefs = new List<NotificationPreferenceDTO>
        {
            new() { Category = "vik", Label = "Water", IsEnabled = true },
        };
        _prefs.Setup(p => p.GetPreferencesAsync(userId)).ReturnsAsync(prefs);
        var controller = new NotificationPreferencesController(_prefs.Object).WithUser(userId);

        var result = await controller.GetAll();

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.Same(prefs, ok.Value);
    }

    [Fact]
    public async Task Set_ValidCategory_ReturnsNoContent()
    {
        var userId = Guid.NewGuid();
        var controller = new NotificationPreferencesController(_prefs.Object).WithUser(userId);

        var result = await controller.Set("vik", new SetPreferenceRequest { IsEnabled = false });

        Assert.IsType<NoContentResult>(result);
        _prefs.Verify(p => p.SetPreferenceAsync(userId, "vik", false), Times.Once);
    }

    [Fact]
    public async Task Set_UnknownCategory_ReturnsBadRequest()
    {
        var userId = Guid.NewGuid();
        _prefs.Setup(p => p.SetPreferenceAsync(userId, "bogus", It.IsAny<bool>()))
              .ThrowsAsync(new ArgumentException("Unknown category: bogus"));
        var controller = new NotificationPreferencesController(_prefs.Object).WithUser(userId);

        var result = await controller.Set("bogus", new SetPreferenceRequest { IsEnabled = true });

        Assert.IsType<BadRequestObjectResult>(result);
    }

    [Fact]
    public async Task GetBusLines_ReturnsSubscription()
    {
        var userId = Guid.NewGuid();
        var subscription = new BusLineSubscriptionDTO
        {
            Available = new List<string> { "18", "31A" },
            Selected  = new List<string> { "18" },
        };
        _prefs.Setup(p => p.GetBusLineSubscriptionAsync(userId)).ReturnsAsync(subscription);
        var controller = new NotificationPreferencesController(_prefs.Object).WithUser(userId);

        var result = await controller.GetBusLines();

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.Same(subscription, ok.Value);
    }

    [Fact]
    public async Task SetBusLines_Valid_ReturnsNoContent()
    {
        var userId = Guid.NewGuid();
        var lines = new List<string> { "18", "31A" };
        var controller = new NotificationPreferencesController(_prefs.Object).WithUser(userId);

        var result = await controller.SetBusLines(new SetBusLinesRequest { BusLines = lines });

        Assert.IsType<NoContentResult>(result);
        _prefs.Verify(p => p.SetBusLineSubscriptionAsync(userId, lines), Times.Once);
    }

    [Fact]
    public async Task SetBusLines_UnknownLine_ReturnsBadRequest()
    {
        var userId = Guid.NewGuid();
        _prefs.Setup(p => p.SetBusLineSubscriptionAsync(userId, It.IsAny<List<string>>()))
              .ThrowsAsync(new ArgumentException("Unknown bus line(s): 999"));
        var controller = new NotificationPreferencesController(_prefs.Object).WithUser(userId);

        var result = await controller.SetBusLines(
            new SetBusLinesRequest { BusLines = new List<string> { "999" } });

        Assert.IsType<BadRequestObjectResult>(result);
    }
}
