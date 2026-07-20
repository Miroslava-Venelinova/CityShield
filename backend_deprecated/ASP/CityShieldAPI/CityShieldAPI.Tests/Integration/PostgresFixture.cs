using CityShieldAPI.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Testcontainers.PostgreSql;
using Xunit;

namespace CityShieldAPI.Tests.Integration;

/// <summary>
/// One PostgreSQL container (with postgis + pg_trgm) shared by every test in
/// the "Postgres" collection. Schema is created once via EnsureCreated;
/// individual test classes are responsible for cleaning the rows they need.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
        .WithImage("postgis/postgis:16-3.4")
        .WithDatabase("cityshield_test")
        .WithUsername("postgres")
        .WithPassword("postgres")
        .Build();

    private NpgsqlDataSource? _dataSource;

    public string ConnectionString => _container.GetConnectionString();

    /// <summary>Data source with the NetTopologySuite plugin enabled.</summary>
    public NpgsqlDataSource DataSource => _dataSource!;

    public async Task InitializeAsync()
    {
        await _container.StartAsync();

        // postgis is enabled by the image's init scripts; pg_trgm is not.
        await using (var conn = new NpgsqlConnection(ConnectionString))
        {
            await conn.OpenAsync();
            await using var cmd = new NpgsqlCommand(
                "CREATE EXTENSION IF NOT EXISTS postgis; " +
                "CREATE EXTENSION IF NOT EXISTS pg_trgm;", conn);
            await cmd.ExecuteNonQueryAsync();
        }

        var dataSourceBuilder = new NpgsqlDataSourceBuilder(ConnectionString);
        dataSourceBuilder.UseNetTopologySuite();
        _dataSource = dataSourceBuilder.Build();

        await using var context = CreateContext();
        await context.Database.EnsureCreatedAsync();
    }

    public async Task DisposeAsync()
    {
        if (_dataSource is not null) await _dataSource.DisposeAsync();
        await _container.DisposeAsync();
    }

    public ApplicationDbContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseNpgsql(DataSource, o => o.UseNetTopologySuite())
            .Options;
        return new ApplicationDbContext(options);
    }

    /// <summary>Delete all rows so a test class starts from a blank database.</summary>
    public async Task ResetAsync()
    {
        await using var context = CreateContext();
        await context.Database.ExecuteSqlRawAsync("""
            DELETE FROM alerts;
            DELETE FROM user_notification_preferences;
            DELETE FROM "DeviceTokens";
            DELETE FROM "Users";
            DELETE FROM streets;
            DELETE FROM regions;
            """);
    }
}

[CollectionDefinition("Postgres")]
public class PostgresCollection : ICollectionFixture<PostgresFixture>
{
    // Marker class: ties the fixture to the collection. Classes in this
    // collection run sequentially, so they can share one database safely.
}
