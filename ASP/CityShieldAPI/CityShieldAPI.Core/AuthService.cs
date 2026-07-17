using CityShieldAPI.Common;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using CityShieldAPI.DTOs;
using CityShieldAPI.DTOs.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using NetTopologySuite;
using NetTopologySuite.Geometries;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;

namespace CityShieldAPI.Core
{
    public class AuthService : IAuthService
    {
        private readonly ApplicationDbContext _context;
        private readonly JwtSettings _jwtSettings;
        private readonly IGeocodingService _geocoder;

        public AuthService(
            ApplicationDbContext context,
            IOptions<JwtSettings> jwtOptions,
            IGeocodingService geocoder)
        {
            _context = context;
            _jwtSettings = jwtOptions.Value;
            _geocoder = geocoder;
        }

        public async Task<UserDTO> GetUserDataAsync(string userId)
        {
            var id = ParseUserId(userId);
            var user = await _context.Users
                .Include(u => u.Region)
                .Include(u => u.Street)
                .FirstOrDefaultAsync(x => x.UserId == id);

            if (user == null)
                throw new ArgumentException("User does not exist");

            return new UserDTO
            {
                Email = user.Email,
                Latitude = user.Latitude,
                Longitude = user.Longitude,
                HasLocation = user.RegionId.HasValue,
                RegionName = user.Region?.RegionName,
                StreetName = user.Street?.StreetName,
                CreatedOnUTC = user.CreatedOnUTC,
                UpdatedOnUTC = user.UpdatedOnUTC,
            };
        }

        public async Task<string?> LoginAsync(LoginRequest request)
        {
            var user = await _context.Users
                .FirstOrDefaultAsync(u => u.Email == request.Email);

            if (user == null) return null;
            if (!BCrypt.Net.BCrypt.Verify(request.Password, user.PasswordHash)) return null;

            return GenerateJwtToken(user);
        }

        public async Task RegisterAsync(RegisterRequest request)
        {
            if (await _context.Users.AnyAsync(x => x.Email == request.Email))
                throw new InvalidOperationException("An account with this email already exists");

            var user = new User
            {
                Email = request.Email,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password),
                // Location is null until the user explicitly sets it
                Latitude = null,
                Longitude = null,
                Location = null,
                RegionId = null,
                StreetId = null,
                CreatedOnUTC = DateTime.UtcNow,
                UpdatedOnUTC = DateTime.UtcNow,
            };

            await _context.Users.AddAsync(user);
            await _context.SaveChangesAsync();
        }

        /// <summary>
        /// Reverse-geocodes the supplied coordinates via the geocoding service,
        /// then fuzzy-matches the returned suburb/neighbourhood against the
        /// regions table and the road against the streets table, and updates
        /// the user record.
        /// </summary>
        public async Task UpdateLocationAsync(string userId, UpdateLocationRequest request)
        {
            var id = ParseUserId(userId);
            var user = await _context.Users
                .FirstOrDefaultAsync(u => u.UserId == id)
                ?? throw new ArgumentException("User does not exist");

            // ── 1. Reverse-geocode ─────────────────────────────────────────────
            var address = await _geocoder.ReverseGeocodeAsync(
                request.Latitude, request.Longitude);

            // ── 2. Fuzzy-match region (required) and street (optional) ─────────
            Region? region = null;
            if (!string.IsNullOrWhiteSpace(address.RegionName))
                region = await _context.FuzzyMatchRegionAsync(address.RegionName);

            Street? street = null;
            if (!string.IsNullOrWhiteSpace(address.StreetName))
                street = await _context.FuzzyMatchStreetAsync(address.StreetName);

            // ── 3. Persist ─────────────────────────────────────────────────────
            var geometryFactory = NtsGeometryServices.Instance
                .CreateGeometryFactory(srid: 4326);

            user.Latitude = request.Latitude;
            user.Longitude = request.Longitude;
            user.Location = geometryFactory.CreatePoint(
                new Coordinate(request.Longitude, request.Latitude));
            user.RegionId = region?.Id;          // null if no match found
            user.StreetId = street?.Id;
            user.UpdatedOnUTC = DateTime.UtcNow;

            await _context.SaveChangesAsync();
        }

        /// <summary>
        /// Deletes the user's account and every row keyed to it (GDPR Art. 17 /
        /// Google Play account deletion). Notification preferences cascade via
        /// their FK and bus-line subscriptions live on the user row itself;
        /// device tokens have no FK to Users, so they are removed explicitly.
        /// </summary>
        public async Task DeleteAccountAsync(string userId)
        {
            var id = ParseUserId(userId);
            var user = await _context.Users
                .FirstOrDefaultAsync(u => u.UserId == id)
                ?? throw new ArgumentException("User does not exist");

            _context.DeviceTokens.RemoveRange(
                _context.DeviceTokens.Where(t => t.UserId == id));
            _context.Users.Remove(user);
            await _context.SaveChangesAsync();
        }

        private static Guid ParseUserId(string userId) =>
            Guid.TryParse(userId, out var id)
                ? id
                : throw new ArgumentException("User does not exist");

        // ── JWT ────────────────────────────────────────────────────────────────
        private string GenerateJwtToken(User user)
        {
            var key = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(_jwtSettings.Key));

            var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

            var claims = new[]
            {
                new Claim(ClaimTypes.NameIdentifier, user.UserId.ToString()),
                new Claim(ClaimTypes.Email, user.Email),
            };

            var token = new JwtSecurityToken(
                issuer: _jwtSettings.Issuer,
                audience: _jwtSettings.Audience,
                claims: claims,
                expires: DateTime.UtcNow.AddMinutes(_jwtSettings.ExpireMinutes),
                signingCredentials: creds);

            return new JwtSecurityTokenHandler().WriteToken(token);
        }
    }
}
