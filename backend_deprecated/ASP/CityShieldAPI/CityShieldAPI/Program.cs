using CityShieldAPI.Common;
using CityShieldAPI.Core;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using FirebaseAdmin;
using Google.Apis.Auth.OAuth2;
using Microsoft.AspNetCore.Authentication.JwtBearer;
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
// (env: Firebase__CredentialsFile).
if (!builder.Environment.IsEnvironment("Testing"))
{
    var fcmPath = builder.Configuration["Firebase:CredentialsFile"] ?? "fcm.json";
    FirebaseApp.Create(new AppOptions
    {
        Credential = GoogleCredential.FromFile(fcmPath),
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
// Daily removal of device tokens unseen for 60+ days.
builder.Services.AddHostedService<StaleTokenCleanupService>();

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

app.UseHttpsRedirection();

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
app.Urls.Add("http://0.0.0.0:5276");
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
