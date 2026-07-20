using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using CityShieldAPI.DTOs.Alerts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using NetTopologySuite;
using NetTopologySuite.Geometries;
using System.Text.Json;

namespace CityShieldAPI.Core
{
    /// <summary>
    /// Resolves which users are affected by a scraped alert (region/street
    /// fuzzy matching or point-in-polygon) and dispatches FCM notifications.
    /// Source-agnostic: the alert category ("vik", "epro", ...) only drives
    /// the per-user preference filter.
    /// </summary>
    public class AlertService : IAlertService
    {
        private readonly ApplicationDbContext _context;
        private readonly IFcmTokenService _tokenService;
        private readonly INotificationPreferencesService _preferences;
        private readonly IGeocodingService _geocoder;
        private readonly ILogger<AlertService> _logger;

        // FCM's total message limit is 4 KB; keep push bodies well under it.
        private const int MaxNotificationBodyLength = 1000;

        // Marker color bucket per source category (danger | warning | info).
        private static readonly IReadOnlyDictionary<string, string> CategorySeverity =
            new Dictionary<string, string>
            {
                ["vik"]     = "warning",
                ["epro"]    = "warning",
                ["heating"] = "warning",
                ["roads"]   = "info",
                ["vt"]      = "info",
            };

        public AlertService(
            ApplicationDbContext context,
            IFcmTokenService tokenService,
            INotificationPreferencesService preferences,
            IGeocodingService geocoder,
            ILogger<AlertService> logger)
        {
            _context = context;
            _tokenService = tokenService;
            _preferences = preferences;
            _geocoder = geocoder;
            _logger = logger;
        }

        public async Task<List<User>> GetUsersInRangeAsync(JsonElement location)
        {
            var usersById = new Dictionary<Guid, User>();

            string locationName =
                location.GetProperty("location_name").GetString() ?? string.Empty;

            Region? matchedRegion = await _context.FuzzyMatchRegionAsync(locationName);
            if (matchedRegion == null) return new List<User>();

            if (location.TryGetProperty("sublocations", out JsonElement sublocations)
                && sublocations.ValueKind == JsonValueKind.Array
                && sublocations.GetArrayLength() > 0)
            {
                foreach (JsonElement sublocation in sublocations.EnumerateArray())
                {
                    string streetName = sublocation.GetString() ?? string.Empty;

                    Street? matchedStreet = await _context.FuzzyMatchStreetAsync(streetName);
                    if (matchedStreet == null) continue;

                    var users = await _context.Users
                        .Where(u => u.RegionId == matchedRegion.Id
                                 && u.StreetId == matchedStreet.Id)
                        .ToListAsync();

                    foreach (var user in users) usersById[user.UserId] = user;
                }
            }
            else
            {
                var users = await _context.Users
                    .Where(u => u.RegionId == matchedRegion.Id)
                    .ToListAsync();

                foreach (var user in users) usersById[user.UserId] = user;
            }

            return usersById.Values.ToList();
        }

        public async Task<List<User>> GetUsersInPolygonRangeAsync(JsonElement polygonJson)
        {
            var geometryFactory =
                NtsGeometryServices.Instance.CreateGeometryFactory(srid: 4326);

            var usersById = new Dictionary<Guid, User>();

            // Accept both shapes the pipeline treats as valid (see
            // ExtractPolygonGeometry): a FeatureCollection or a bare geometry.
            var geometries = new List<JsonElement>();
            if (polygonJson.TryGetProperty("features", out var features)
                && features.ValueKind == JsonValueKind.Array)
            {
                foreach (var feature in features.EnumerateArray())
                {
                    if (feature.TryGetProperty("geometry", out var geometry)
                        && geometry.ValueKind == JsonValueKind.Object)
                        geometries.Add(geometry);
                }
            }
            else if (polygonJson.TryGetProperty("coordinates", out _))
            {
                geometries.Add(polygonJson);
            }

            foreach (var geometry in geometries)
            {
                var coordinates = geometry.GetProperty("coordinates")[0];

                var polygonCoordinates = coordinates
                    .EnumerateArray()
                    .Select(c => new Coordinate(c[0].GetDouble(), c[1].GetDouble()))
                    .ToArray();

                var polygon = geometryFactory.CreatePolygon(polygonCoordinates);

                var users = await _context.Users
                    .Where(u => u.Location != null && polygon.Contains(u.Location))
                    .ToListAsync();

                foreach (var user in users) usersById[user.UserId] = user;
            }

            return usersById.Values.ToList();
        }

        public async Task<List<Guid>> SendUsersNotificationAsync(
            JsonElement locations,
            string title,
            string body,
            string category,
            string? startTime,
            string? endTime,
            bool? cityWide = null,
            List<string>? busLines = null)
        {
            // ── 1. Gather target users ─────────────────────────────────────────────
            var userIds = new List<Guid>();
            bool hasLocations = locations.ValueKind == JsonValueKind.Array
                             && locations.GetArrayLength() > 0;

            if (hasLocations)
            {
                foreach (var location in locations.EnumerateArray())
                {
                    bool isPolygon = location.TryGetProperty("is_polygon", out var poly)
                                  && poly.GetBoolean();

                    if (isPolygon
                        && location.TryGetProperty("polygon_geojson", out var polygonJson)
                        && polygonJson.ValueKind == JsonValueKind.Object)
                    {
                        userIds.AddRange(
                            (await GetUsersInPolygonRangeAsync(polygonJson)).Select(u => u.UserId));
                    }
                    else
                    {
                        userIds.AddRange(
                            (await GetUsersInRangeAsync(location)).Select(u => u.UserId));
                    }
                }
            }
            else if (cityWide == false)
            {
                // The scraper explicitly said this is NOT city-wide, yet no
                // locations arrived — almost certainly an LLM misparse of a
                // street-level outage. Store-only; never escalate it into a
                // broadcast to the whole user base.
                _logger.LogWarning(
                    "Alert '{Title}' ({Category}) has no locations and city_wide=false — skipping notifications.",
                    title, category);
                return new List<Guid>();
            }
            else
            {
                // city_wide=true (road news, route changes, all-clients
                // outages) or a legacy payload without the flag. Broadcast to
                // everyone; the per-category preference filter below still
                // applies. Only ids are needed, so don't materialize full
                // User entities.
                userIds = await _context.Users.Select(u => u.UserId).ToListAsync();
            }

            // Alerts naming specific bus lines (vt route changes) go only to
            // users subscribed to an affected line. No subscription = no
            // filter: those users keep receiving every alert of the category,
            // since picking lines is an opt-in narrowing.
            var lines = (busLines ?? new List<string>())
                .Select(BusLineCatalog.Normalize)
                .Where(l => l is not null)
                .Select(l => l!)
                .Distinct()
                .ToList();
            if (lines.Count > 0 && userIds.Count > 0)
            {
                // The overlap test runs client-side: primitive-collection
                // predicates aren't translatable on every provider (InMemory).
                var candidateIds = userIds.Distinct().ToList();
                var subscriptions = await _context.Users
                    .Where(u => candidateIds.Contains(u.UserId))
                    .Select(u => new { u.UserId, u.SubscribedBusLines })
                    .ToListAsync();
                userIds = subscriptions
                    .Where(u => u.SubscribedBusLines.Count == 0
                             || u.SubscribedBusLines.Any(l => lines.Contains(l)))
                    .Select(u => u.UserId)
                    .ToList();
            }

            // Debug/monitoring accounts receive every alert regardless of location.
            userIds.AddRange(await _context.Users
                .Where(u => u.ReceivesAllAlerts)
                .Select(u => u.UserId)
                .ToListAsync());

            // ── 2. Filter to users who have this category enabled ─────────────────
            var allIds = userIds.Distinct();
            var filteredIds = await _preferences.FilterEnabledUsersAsync(allIds, category);

            if (filteredIds.Count == 0) return filteredIds;

            // ── 3. Build FCM data payload — received by the frontend handler ───────
            // All values must be strings in the FCM data dict.
            var fcmData = new Dictionary<string, string>
            {
                ["category"]  = category,
                ["startTime"] = startTime ?? string.Empty,
                ["endTime"]   = endTime   ?? string.Empty,
            };

            // ── 4. Build the notification body with time info appended ─────────────
            var fullBody = body;
            if (!string.IsNullOrEmpty(startTime) || !string.IsNullOrEmpty(endTime))
            {
                var timePart = (startTime, endTime) switch
                {
                    ({ } s, { } e) when !string.IsNullOrEmpty(s) && !string.IsNullOrEmpty(e)
                        => $" ({s} – {e})",
                    ({ } s, _) when !string.IsNullOrEmpty(s)
                        => $" (from {s})",
                    (_, { } e) when !string.IsNullOrEmpty(e)
                        => $" (until {e})",
                    _ => string.Empty
                };
                fullBody = body + timePart;
            }

            // Scraped content is unbounded, but FCM rejects oversized payloads
            // with INVALID_ARGUMENT for the whole batch — cap the push body.
            if (fullBody.Length > MaxNotificationBodyLength)
                fullBody = fullBody[..(MaxNotificationBodyLength - 1)] + "…";

            // ── 5. Send ────────────────────────────────────────────────────────────
            await _tokenService.SendToMultipleUsersAsync(
                filteredIds, title, fullBody, fcmData);

            return filteredIds;
        }

        // ── Alert storage (map/read side) ──────────────────────────────────────────

        public async Task<Guid> StoreAlertAsync(
            string category,
            string title,
            string content,
            string? startTime,
            string? endTime,
            JsonElement locations)
        {
            var enriched = await EnrichLocationsAsync(locations);

            var alert = new Alert
            {
                Id = Guid.NewGuid(),
                Category = category,
                Title = title,
                Content = content,
                StartTime = startTime,
                EndTime = endTime,
                Severity = CategorySeverity.TryGetValue(category, out var sev) ? sev : "info",
                LocationsJson = JsonSerializer.Serialize(enriched),
                CreatedOnUTC = DateTime.UtcNow,
            };

            _context.Alerts.Add(alert);
            await _context.SaveChangesAsync();
            return alert.Id;
        }

        public async Task<List<AlertDTO>> GetRecentAlertsAsync(TimeSpan maxAge, int limit)
        {
            var cutoff = DateTime.UtcNow - maxAge;

            var alerts = await _context.Alerts
                .AsNoTracking() // read-only hot path; skip change-tracker snapshots
                .Where(a => a.CreatedOnUTC >= cutoff)
                .OrderByDescending(a => a.CreatedOnUTC)
                .Take(limit)
                .ToListAsync();

            return alerts.Select(a => new AlertDTO
            {
                Id = a.Id,
                OriginalMessage = new AlertOriginalMessageDTO
                {
                    Title = a.Title,
                    Content = a.Content,
                },
                ProcessedData = new AlertProcessedDataDTO
                {
                    Locations = DeserializeLocations(a),
                    StartTime = a.StartTime,
                    EndTime = a.EndTime,
                },
                Source = a.Category,
                Severity = a.Severity,
                CreatedAt = a.CreatedOnUTC,
            }).ToList();
        }

        private List<AlertLocationDTO> DeserializeLocations(Alert alert)
        {
            try
            {
                return JsonSerializer.Deserialize<List<AlertLocationDTO>>(alert.LocationsJson)
                    ?? new List<AlertLocationDTO>();
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Corrupt locations JSON on alert {AlertId}", alert.Id);
                return new List<AlertLocationDTO>();
            }
        }

        // ── Location enrichment ────────────────────────────────────────────────────

        /// <summary>
        /// Converts the raw scraper locations into DTOs carrying coordinates:
        /// polygon locations get their centroid, everything else is resolved by
        /// fuzzy-matching names against the regions/streets tables and forward-
        /// geocoding the canonical name via Nominatim. Never throws — an alert
        /// without coordinates is still worth storing.
        /// </summary>
        private async Task<List<AlertLocationDTO>> EnrichLocationsAsync(JsonElement locations)
        {
            var result = new List<AlertLocationDTO>();
            if (locations.ValueKind != JsonValueKind.Array) return result;

            foreach (var location in locations.EnumerateArray())
            {
                var dto = new AlertLocationDTO
                {
                    LocationName = location.TryGetProperty("location_name", out var nameEl)
                        && nameEl.ValueKind == JsonValueKind.String
                        ? nameEl.GetString() ?? string.Empty
                        : string.Empty,
                    IsPolygon = location.TryGetProperty("is_polygon", out var polyFlag)
                        && polyFlag.ValueKind == JsonValueKind.True,
                };

                if (location.TryGetProperty("sublocations", out var subs)
                    && subs.ValueKind == JsonValueKind.Array)
                {
                    dto.Sublocations = subs.EnumerateArray()
                        .Where(s => s.ValueKind == JsonValueKind.String)
                        .Select(s => s.GetString()!)
                        .ToList();
                }

                // Normalize the polygon to a bare GeoJSON geometry — the scraper
                // sends a FeatureCollection, the app expects {type, coordinates}.
                var geometry = ExtractPolygonGeometry(location);
                if (geometry is not null)
                {
                    dto.PolygonGeojson = geometry.Value.Clone();
                    var centroid = PolygonCentroid(geometry.Value);
                    dto.Lat = centroid?.Lat;
                    dto.Lng = centroid?.Lon;
                }
                else
                {
                    dto.IsPolygon = false; // polygon was requested but not built
                    var point = await ResolveCoordinatesAsync(dto);
                    dto.Lat = point?.Lat;
                    dto.Lng = point?.Lon;
                }

                result.Add(dto);
            }

            return result;
        }

        /// <summary>Returns the Polygon geometry element from either a FeatureCollection or a bare geometry.</summary>
        private static JsonElement? ExtractPolygonGeometry(JsonElement location)
        {
            if (!location.TryGetProperty("polygon_geojson", out var poly)
                || poly.ValueKind != JsonValueKind.Object)
                return null;

            if (poly.TryGetProperty("coordinates", out _))
                return poly;

            if (poly.TryGetProperty("features", out var features)
                && features.ValueKind == JsonValueKind.Array
                && features.GetArrayLength() > 0
                && features[0].TryGetProperty("geometry", out var geometry)
                && geometry.ValueKind == JsonValueKind.Object
                && geometry.TryGetProperty("coordinates", out _))
                return geometry;

            return null;
        }

        /// <summary>Average of the polygon's outer ring — good enough for a map pin.</summary>
        private static GeoPoint? PolygonCentroid(JsonElement geometry)
        {
            try
            {
                var ring = geometry.GetProperty("coordinates")[0];
                double latSum = 0, lonSum = 0;
                int count = 0;

                foreach (var coord in ring.EnumerateArray())
                {
                    lonSum += coord[0].GetDouble();
                    latSum += coord[1].GetDouble();
                    count++;
                }

                return count == 0 ? null : new GeoPoint(latSum / count, lonSum / count);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Geocoding strategy: canonicalize names against our own DB first
        /// (pg_trgm fuzzy match), then ask Nominatim. Street-level pin when a
        /// street is listed, otherwise district/locality-level.
        /// </summary>
        private async Task<GeoPoint?> ResolveCoordinatesAsync(AlertLocationDTO dto)
        {
            // 1. Street-level: first sublocation that geocodes wins
            foreach (var raw in dto.Sublocations.Take(3))
            {
                var street = await FuzzyMatchStreetNameAsync(raw) ?? StripLocationPrefix(raw);
                var point = await _geocoder.GeocodeAsync(BuildQuery(street));
                if (point is not null) return point;
            }

            // 2. District / locality level
            if (!string.IsNullOrWhiteSpace(dto.LocationName))
            {
                var region = await FuzzyMatchRegionNameAsync(dto.LocationName)
                    ?? StripLocationPrefix(dto.LocationName);
                return await _geocoder.GeocodeAsync(BuildQuery(region));
            }

            return null;
        }

        private static readonly string[] LocationPrefixes =
            { "ул. ", "бул. ", "ж.к. ", "кв. ", "с. ", "гр. ", "м-т ", "к.к. " };

        private static string StripLocationPrefix(string name)
        {
            foreach (var prefix in LocationPrefixes)
                if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    return name[prefix.Length..].Trim();
            return name.Trim();
        }

        /// <summary>All current sources are Varna-scoped, so anchor every query there.</summary>
        private static string BuildQuery(string name) =>
            name.Contains("Варна", StringComparison.OrdinalIgnoreCase)
                ? $"{name}, България"
                : $"{name}, Варна, България";

        private async Task<string?> FuzzyMatchRegionNameAsync(string name)
        {
            try
            {
                var region = await _context.FuzzyMatchRegionAsync(name);
                return region?.RegionName;
            }
            catch (Exception ex)
            {
                // Non-PostgreSQL provider (tests) or missing pg_trgm — fall back to the raw name.
                _logger.LogDebug(ex, "Region fuzzy match unavailable for '{Name}'", name);
                return null;
            }
        }

        private async Task<string?> FuzzyMatchStreetNameAsync(string name)
        {
            try
            {
                var street = await _context.FuzzyMatchStreetAsync(name);
                return street?.StreetName;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Street fuzzy match unavailable for '{Name}'", name);
                return null;
            }
        }
    }
}
