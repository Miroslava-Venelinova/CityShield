using CityShielAPI.Core.Contracts;
using CityShieldAPI.Common;
using CityShieldAPI.Data;
using CityShieldAPI.Data.Models;
using CityShieldAPI.DTOs;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using System;
using System.Collections.Generic;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace CityShieldAPI.Core
{
    public class AuthService : IAuthService
    {
        private readonly ApplicationDbContext _context;
        private readonly JwtSettings _jwtSettings;
        public AuthService(ApplicationDbContext context,
            IOptions<JwtSettings> jwtOptions)
        {
            _context = context;
            _jwtSettings = jwtOptions.Value;
        }

        public async Task<UserDTO> GetUserDataAsync(string userId)
        {
            var user = await _context.Users.Where(x => x.UserId.ToString() == userId)
                .FirstOrDefaultAsync();

            if (user == null)
                throw new ArgumentException("User does not exist");

            return new UserDTO()
            {
                Email = user.Email,
                PasswordHash = user.PasswordHash,
                Latitude = user.Latitude,
                Longitude = user.Longitude,
                CreatedOnUTC = user.CreatedOnUTC,
                UpdatedOnUTC = user.UpdatedOnUTC
            };
        }

        public async Task<string?> LoginAsync(LoginRequest request)
        {
            var user = await _context.Users
                .FirstOrDefaultAsync(u => u.Email == request.Email);

            if (user == null)
                return null;

            if (!BCrypt.Net.BCrypt.Verify(request.Password, user.PasswordHash))
                return null;

            return GenerateJwtToken(user);
        }

        public async Task RegisterAsync(RegisterRequest request)
        {
            if (await _context.Users.Where(x => x.Email == request.Email).AnyAsync())
                throw new Exception("An account with this email already exists");

            User user = new User()
            {
                Email = request.Email,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password),
                Latitude = request.Latitude,
                Longitude = request.Longitude,
                CreatedOnUTC = DateTime.UtcNow,
                UpdatedOnUTC = DateTime.UtcNow,
            };

            await _context.Users.AddAsync(user);
            await _context.SaveChangesAsync();
        }

        private string GenerateJwtToken(User user)
        {
            var key = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(_jwtSettings.Key)
            );

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
                signingCredentials: creds
            );

            return new JwtSecurityTokenHandler().WriteToken(token);
        }
    }
}
