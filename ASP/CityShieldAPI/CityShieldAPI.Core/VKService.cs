using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using FcmDemo.Services;
using Microsoft.EntityFrameworkCore;
using NetTopologySuite;
using NetTopologySuite.Geometries;
using System.IO;
using System.Text.Json;

public class VKService : IVKService
{
    private readonly ApplicationDbContext _context;
    private readonly IFcmTokenService _tokenService;

    public VKService(ApplicationDbContext context, IFcmTokenService tokenService)
    {
        _context = context;
        _tokenService = tokenService;
    }

    public async Task<List<User>> GetUsersInRangeAsync(JsonElement locations)
    {
        var usersQuery = _context.Users.AsQueryable();

        var userIds = new HashSet<Guid>();

        foreach (JsonElement location in locations.EnumerateArray())
        {
            string locationName =
                location.GetProperty("location_name").GetString() ?? string.Empty;

            // Fuzzy match region
            Region? matchedRegion = await _context.Regions
                .FromSqlInterpolated($@"
                    SELECT *
                    FROM regions
                    WHERE region_name % {locationName}
                    ORDER BY similarity(region_name, {locationName}) DESC
                    LIMIT 1
                ")
                .FirstOrDefaultAsync();

            if (matchedRegion == null)
                continue;

            // Check sublocations
            if (location.TryGetProperty("sublocations", out JsonElement sublocations)
                && sublocations.ValueKind == JsonValueKind.Array
                && sublocations.GetArrayLength() > 0)
            {
                foreach (JsonElement sublocation in sublocations.EnumerateArray())
                {
                    string streetName = sublocation.GetString() ?? string.Empty;

                    Street? matchedStreet = await _context.Streets
                        .FromSqlInterpolated($@"
                            SELECT *
                            FROM streets
                            WHERE street_name % {streetName}
                            ORDER BY similarity(street_name, {streetName}) DESC
                            LIMIT 1
                        ")
                        .FirstOrDefaultAsync();

                    if (matchedStreet == null)
                        continue;

                    List<Guid> ids = await _context.Users
                        .Where(u =>
                            u.RegionId == matchedRegion.Id &&
                            u.StreetId == matchedStreet.Id)
                        .Select(u => u.UserId)
                        .ToListAsync();

                    foreach (Guid id in ids)
                        userIds.Add(id);
                }
            }
            else
            {
                // Only region filtering
                List<Guid> ids = await _context.Users
                    .Where(u => u.RegionId == matchedRegion.Id)
                    .Select(u => u.UserId)
                    .ToListAsync();

                foreach (Guid id in ids)
                    userIds.Add(id);
            }
        }

        return await _context.Users
            .Where(u => userIds.Contains(u.UserId))
            .ToListAsync();
    }
    public async Task<List<User>> GetUsersInPolygonRangeAsync(JsonElement polygonJson)
    {
        var geometryFactory =
            NtsGeometryServices.Instance.CreateGeometryFactory(srid: 4326);

        var userIds = new HashSet<Guid>();

        var features = polygonJson
            .GetProperty("features");

        foreach (var feature in features.EnumerateArray())
        {
            var coordinates = feature
                .GetProperty("geometry")
                .GetProperty("coordinates")[0];

            var polygonCoordinates = coordinates
                .EnumerateArray()
                .Select(c => new Coordinate(
                    c[0].GetDouble(), // longitude
                    c[1].GetDouble()  // latitude
                ))
                .ToArray();

            var polygon = geometryFactory.CreatePolygon(polygonCoordinates);

            var users = await _context.Users
                .Where(u => polygon.Contains(u.Location))
                .ToListAsync();

            foreach (var user in users)
                userIds.Add(user.UserId);
        }

        return await _context.Users
            .Where(u => userIds.Contains(u.UserId))
            .ToListAsync();
    }
    public async Task<List<Guid>> SendUsersNotificationAsync(JsonElement locations)
    {
        var users = new List<User>();
    
        foreach(var location in locations.EnumerateArray())
        {
            bool isPolygon = location
                .GetProperty("is_polygon")
                .GetBoolean();
    
            if(isPolygon)
            {
                var polygon = location
                    .GetProperty("polygon_geojson");
    
                users.AddRange(
                    await GetUsersInPolygonRangeAsync(polygon)
                );
            }
            else
            {
                users.AddRange(
                    await GetUsersInRangeAsync(locations)
                );
            }
        }
    
        users = users
            .GroupBy(x => x.UserId)
            .Select(g => g.First())
            .ToList();
    
        await _tokenService.SendToMultipleUsersAsync(
            users.Select(x => x.UserId),
            "Avariq",
            "shte spira vodata"
        );
    
        return users.Select(x => x.UserId).ToList();
    }
}