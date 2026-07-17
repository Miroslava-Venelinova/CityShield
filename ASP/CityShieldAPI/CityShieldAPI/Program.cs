using CityShieldAPI.Common;
using CityShieldAPI.Core;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using FirebaseAdmin;
using Google.Apis.Auth.OAuth2;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using NetTopologySuite;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

// ── Firebase ──────────────────────────────────────────────────────────────────
// Skipped under the "Testing" environment: integration tests replace
// IFirebaseMessenger with a fake and have no fcm.json credentials file.
// The credential path is configurable so deployments can mount it anywhere
// (env: Firebase__CredentialsFile). When no key file is configured or present,
// Application Default Credentials are used — on Cloud Run that resolves to the
// service account attached to the service, so no key file exists at all.
if (!builder.Environment.IsEnvironment("Testing"))
{
    var fcmPath = builder.Configuration["Firebase:CredentialsFile"];
    var credential =
        fcmPath is not null      ? GoogleCredential.FromFile(fcmPath)
        : File.Exists("fcm.json") ? GoogleCredential.FromFile("fcm.json")
        : GoogleCredential.GetApplicationDefault();
    FirebaseApp.Create(new AppOptions
    {
        Credential = credential,
    });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
AuthConfig();

// ── Services ──────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<IFirebaseMessenger, FirebaseMessenger>();
builder.Services.AddScoped<IAuthService, AuthService>();
builder.Services.AddScoped<IAlertService, AlertService>();
builder.Services.AddScoped<IFcmTokenService, FcmTokenService>();
builder.Services.AddScoped<INotificationPreferencesService, NotificationPreferencesService>();
// Singleton: shares the geocode cache and the 1 req/s Nominatim throttle.
builder.Services.AddSingleton<IGeocodingService, NominatimGeocodingService>();
// Daily removal of device tokens unseen for 60+ days. In-process timers don't
// fire on scale-to-zero platforms (CPU is throttled between requests), so
// cloud deploys set TokenCleanup__InProcess=false and trigger the same logic
// via POST /api/maintenance/cleanup-tokens from an external scheduler instead.
if (builder.Configuration.GetValue("TokenCleanup:InProcess", true))
{
    builder.Services.AddHostedService<StaleTokenCleanupService>();
}

// Named HttpClient for Nominatim — sets the required User-Agent header
// (Nominatim ToS require a descriptive UA string).
builder.Services.AddHttpClient("Nominatim", client =>
{
    client.BaseAddress = new Uri("https://nominatim.openstreetmap.org/");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("CityShieldAPI/1.0");
    client.Timeout = TimeSpan.FromSeconds(10);
});

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// ── Database ──────────────────────────────────────────────────────────────────
// The NetTopologySuite plugin must be registered on the NpgsqlDataSource
// itself — passing only the connection string leaves geometry parameters
// (User.Location, polygon queries) unwritable at runtime.
var dataSourceBuilder = new NpgsqlDataSourceBuilder(
    builder.Configuration.GetConnectionString("DefaultConnection"));
dataSourceBuilder.UseNetTopologySuite();
var dataSource = dataSourceBuilder.Build();

builder.Services.AddDbContext<ApplicationDbContext>(options =>
    options.UseNpgsql(dataSource, o => o.UseNetTopologySuite()));

var app = builder.Build();

// Apply pending EF migrations on startup when enabled (containerized deploys
// set Database__AutoMigrate=true; local dev keeps using `dotnet ef database update`).
if (app.Configuration.GetValue<bool>("Database:AutoMigrate"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    db.Database.Migrate();
}

// Refuse to start a production instance on the committed placeholder JWT key.
if (app.Environment.IsProduction())
{
    var jwtKey = app.Configuration["Jwt:Key"] ?? "";
    if (jwtKey.Contains("CHANGE_THIS") || jwtKey.Length < 32)
        throw new InvalidOperationException(
            "Jwt:Key is unset or still the development placeholder. " +
            "Set a strong key via the Jwt__Key environment variable.");
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
else
{
    // Uniform 500 without stack traces outside development.
    app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
    {
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await context.Response.WriteAsJsonAsync(new { error = "An unexpected error occurred." });
    }));
}

// ── Reverse proxy (Proxy__Enabled=true, e.g. Cloud Run) ───────────────────────
// The platform terminates TLS, so the container only sees plain HTTP with the
// original scheme/client IP in X-Forwarded-Proto / X-Forwarded-For. Rewrite
// the request from those headers and skip the in-app HTTPS redirect (before
// the rewrite it would loop; the edge already refuses plain HTTP). Off by
// default: trusting forwarded headers without a proxy in front would let
// clients spoof their scheme and IP.
if (app.Configuration.GetValue<bool>("Proxy:Enabled"))
{
    var forwardedOptions = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    };
    // The platform's proxy addresses aren't knowable in advance; the service
    // is only reachable through the platform front end, so trust them all.
    forwardedOptions.KnownNetworks.Clear();
    forwardedOptions.KnownProxies.Clear();
    app.UseForwardedHeaders(forwardedOptions);
}
else
{
    app.UseHttpsRedirection();
}

// ── Ingest API key ────────────────────────────────────────────────────────────
// Ingest endpoints are machine-to-machine (Python backend → API) and are
// protected per-endpoint by [RequireIngestApiKey] (X-Api-Key must match
// Ingest:ApiKey / env: Ingest__ApiKey). Left unset, they stay open for local
// dev — but never in production.
if (string.IsNullOrEmpty(app.Configuration["Ingest:ApiKey"]) && app.Environment.IsProduction())
{
    throw new InvalidOperationException(
        "Ingest:ApiKey is not configured — the ingest endpoints would be unauthenticated. " +
        "Set the Ingest__ApiKey environment variable in production.");
}

app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();

// Liveness probe: unauthenticated, no data, one cheap DB round-trip so a
// deploy that can't reach the database fails visibly instead of serving 500s.
app.MapGet("/healthz", async (ApplicationDbContext db) =>
{
    try
    {
        await db.Database.ExecuteSqlRawAsync("SELECT 1");
        return Results.Ok(new { status = "ok" });
    }
    catch
    {
        return Results.Json(new { status = "unhealthy" },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

// Cloud Run's container contract: listen on the PORT env var (default 8080).
// Local development keeps the familiar 5276 when PORT is unset.
app.Urls.Add($"http://0.0.0.0:{Environment.GetEnvironmentVariable("PORT") ?? "5276"}");
app.Run();

void AuthConfig()
{
    builder.Services.Configure<JwtSettings>(
        builder.Configuration.GetSection("Jwt"));

    var jwtSettings = builder.Configuration
        .GetSection("Jwt")
        .Get<JwtSettings>()!;

    var key = Encoding.UTF8.GetBytes(jwtSettings.Key);

    builder.Services.AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
        options.DefaultChallengeScheme    = JwtBearerDefaults.AuthenticationScheme;
    })
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer           = true,
            ValidateAudience         = true,
            ValidateLifetime         = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer              = jwtSettings.Issuer,
            ValidAudience            = jwtSettings.Audience,
            IssuerSigningKey         = new SymmetricSecurityKey(key),
        };
    });

    builder.Services.AddAuthorization();
}

// Exposes the implicit Program class to WebApplicationFactory in the test project.
public partial class Program { }
