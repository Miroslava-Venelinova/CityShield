using CityShieldAPI.Core.Contracts;
using Microsoft.Extensions.Logging;
using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

namespace CityShieldAPI.Core
{
    /// <summary>
    /// Forward and reverse geocoding via the public Nominatim instance (the
    /// named "Nominatim" HttpClient sets the required User-Agent). Forward
    /// results are cached in memory and all requests are throttled to 1/s to
    /// comply with the Nominatim usage policy. Registered as a singleton so
    /// cache and throttle are shared across requests.
    /// </summary>
    public class NominatimGeocodingService : IGeocodingService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<NominatimGeocodingService> _logger;

        private readonly ConcurrentDictionary<string, GeoPoint?> _cache = new();
        private readonly SemaphoreSlim _gate = new(1, 1);
        private DateTime _lastRequestUtc = DateTime.MinValue;

        private static readonly TimeSpan MinRequestInterval = TimeSpan.FromSeconds(1);

        // The service is a singleton, so the cache lives for the whole process.
        // Reset it once it gets large rather than letting it grow unbounded;
        // repopulating is cheap relative to how rarely this triggers.
        private const int MaxCacheEntries = 5000;

        public NominatimGeocodingService(
            IHttpClientFactory httpClientFactory,
            ILogger<NominatimGeocodingService> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public async Task<GeoPoint?> GeocodeAsync(string query, CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(query)) return null;

            if (_cache.TryGetValue(query, out var cached)) return cached;

            await _gate.WaitAsync(ct);
            try
            {
                if (_cache.TryGetValue(query, out cached)) return cached;

                var wait = MinRequestInterval - (DateTime.UtcNow - _lastRequestUtc);
                if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);

                var result = await QueryNominatimAsync(query, ct);
                _lastRequestUtc = DateTime.UtcNow;

                // Cache misses too — repeated alerts for the same unresolvable
                // name shouldn't hammer Nominatim.
                if (_cache.Count >= MaxCacheEntries) _cache.Clear();
                _cache[query] = result;
                return result;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Geocoding failed for '{Query}'", query);
                return null;
            }
            finally
            {
                _gate.Release();
            }
        }

        public async Task<ReverseAddress> ReverseGeocodeAsync(
            double lat, double lon, CancellationToken ct = default)
        {
            await _gate.WaitAsync(ct);
            try
            {
                var wait = MinRequestInterval - (DateTime.UtcNow - _lastRequestUtc);
                if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);

                var result = await QueryNominatimReverseAsync(lat, lon, ct);
                _lastRequestUtc = DateTime.UtcNow;
                return result;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Reverse geocoding failed for ({Lat}, {Lon})", lat, lon);
                return new ReverseAddress(null, null);
            }
            finally
            {
                _gate.Release();
            }
        }

        private async Task<ReverseAddress> QueryNominatimReverseAsync(
            double lat, double lon, CancellationToken ct)
        {
            var client = _httpClientFactory.CreateClient("Nominatim");
            var url = FormattableString.Invariant(
                $"reverse?format=json&lat={lat}&lon={lon}&addressdetails=1");

            var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Nominatim reverse returned {Status} for ({Lat}, {Lon})",
                    (int)response.StatusCode, lat, lon);
                return new ReverseAddress(null, null);
            }

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);

            if (!doc.RootElement.TryGetProperty("address", out var address))
                return new ReverseAddress(null, null);

            // Prefer suburb → neighbourhood → city_district → city → town
            string? regionName =
                TryGet(address, "suburb") ??
                TryGet(address, "neighbourhood") ??
                TryGet(address, "city_district") ??
                TryGet(address, "city") ??
                TryGet(address, "town");

            string? streetName =
                TryGet(address, "road") ??
                TryGet(address, "pedestrian") ??
                TryGet(address, "path");

            return new ReverseAddress(regionName, streetName);
        }

        private static string? TryGet(JsonElement el, string key) =>
            el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString()
                : null;

        private async Task<GeoPoint?> QueryNominatimAsync(string query, CancellationToken ct)
        {
            var client = _httpClientFactory.CreateClient("Nominatim");
            var url = $"search?format=json&limit=1&countrycodes=bg&q={Uri.EscapeDataString(query)}";

            var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Nominatim returned {Status} for '{Query}'",
                    (int)response.StatusCode, query);
                return null;
            }

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);

            if (doc.RootElement.ValueKind != JsonValueKind.Array
                || doc.RootElement.GetArrayLength() == 0)
                return null;

            var first = doc.RootElement[0];
            if (!first.TryGetProperty("lat", out var latEl)
                || !first.TryGetProperty("lon", out var lonEl))
                return null;

            if (double.TryParse(latEl.GetString(), NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var lat)
                && double.TryParse(lonEl.GetString(), NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var lon))
            {
                return new GeoPoint(lat, lon);
            }

            return null;
        }
    }
}
