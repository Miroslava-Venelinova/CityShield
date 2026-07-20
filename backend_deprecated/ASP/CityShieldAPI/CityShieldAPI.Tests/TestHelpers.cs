using System.Net;
using System.Security.Claims;
using System.Text;
using CityShieldAPI.Common;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CityShieldAPI.Tests;

public static class TestHelpers
{
    /// <summary>A fresh, isolated in-memory database per call.</summary>
    public static ApplicationDbContext NewDbContext()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new ApplicationDbContext(options);
    }

    public static readonly JwtSettings JwtSettings = new()
    {
        Key = "unit-test-signing-key-with-at-least-32-chars!",
        Issuer = "CityShieldTests",
        Audience = "CityShieldTestAudience",
        ExpireMinutes = 30,
    };

    public static IOptions<JwtSettings> JwtOptions() => Options.Create(JwtSettings);

    public static User NewUser(string email = "user@example.com",
        string password = "password123", Guid? id = null)
    {
        return new User
        {
            UserId = id ?? Guid.NewGuid(),
            Email = email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
            CreatedOnUTC = DateTime.UtcNow,
            UpdatedOnUTC = DateTime.UtcNow,
        };
    }

    /// <summary>Attach an authenticated ClaimsPrincipal to a controller.</summary>
    public static T WithUser<T>(this T controller, Guid userId) where T : ControllerBase
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.NameIdentifier, userId.ToString()),
            new Claim(ClaimTypes.Email, "user@example.com"),
        }, authenticationType: "Test");

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(identity),
            },
        };
        return controller;
    }
}

/// <summary>HttpMessageHandler returning a canned response (or throwing).</summary>
public class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
    public List<HttpRequestMessage> Requests { get; } = new();

    public FakeHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
        => _responder = responder;

    public static FakeHttpMessageHandler Json(string json, HttpStatusCode status = HttpStatusCode.OK)
        => new(_ => new HttpResponseMessage(status)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        });

    public static FakeHttpMessageHandler Throws(Exception ex)
        => new(_ => throw ex);

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return Task.FromResult(_responder(request));
    }
}

/// <summary>IHttpClientFactory serving a single fake handler for every client name.</summary>
public class FakeHttpClientFactory : IHttpClientFactory
{
    private readonly HttpMessageHandler _handler;
    public FakeHttpClientFactory(HttpMessageHandler handler) => _handler = handler;

    // BaseAddress mirrors the named "Nominatim" client from Program.cs so
    // services using relative request URLs work against the fake handler.
    public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false)
    {
        BaseAddress = new Uri("https://nominatim.openstreetmap.org/"),
    };
}
