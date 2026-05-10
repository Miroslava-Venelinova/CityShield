using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using Microsoft.EntityFrameworkCore;
using System.IO;
using System.Text.Json;

public class VKService : IVKService
{
    private readonly ApplicationDbContext _context;

    public VKService(ApplicationDbContext context)
    {
        _context = context;
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
}