using CityShieldAPI.Core.Contracts;
using CityShieldAPI.DTOs;
using CityShieldAPI.DTOs.Users;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;

namespace CityShieldAPI.Controllers
{
    [ApiController]
    [Route("api/auth")]
    public class AuthController : ControllerBase
    {
        private readonly IAuthService _authService;

        public AuthController(IAuthService authService)
        {
            _authService = authService;
        }

        [HttpPost("login")]
        public async Task<IActionResult> Login(LoginRequest request)
        {
            var token = await _authService.LoginAsync(request);
            if (token == null)
                return Unauthorized("Invalid email or password");

            return Ok(new { token });
        }

        [HttpPost("register")]
        public async Task<IActionResult> Register(RegisterRequest request)
        {
            try
            {
                await _authService.RegisterAsync(request);
            }
            catch (InvalidOperationException ex)
            {
                return Conflict(ex.Message);
            }

            return Ok("User successfully registered");
        }

        /// <summary>Returns the current user's profile, including HasLocation.</summary>
        [HttpGet("me")]
        [Authorize]
        public async Task<IActionResult> Me()
        {
            var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
            try
            {
                var dto = await _authService.GetUserDataAsync(userId);
                return Ok(dto);
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
        }

        /// <summary>
        /// Accepts GPS coordinates, reverse-geocodes via Nominatim, and updates
        /// the user's RegionId / StreetId / Location in the database.
        /// </summary>
        [HttpPut("location")]
        [Authorize]
        public async Task<IActionResult> UpdateLocation([FromBody] UpdateLocationRequest request)
        {
            var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
            try
            {
                await _authService.UpdateLocationAsync(userId, request);
                return NoContent();
            }
            catch (ArgumentException ex)
            {
                return NotFound(ex.Message);
            }
        }
    }
}
