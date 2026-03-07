using CityShielAPI.Core.Contracts;
using CityShieldAPI.DTOs;
using Microsoft.AspNetCore.Mvc;

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
            catch (Exception ex)
            {
                return Unauthorized(ex.Message);
            }

            return Ok("User Succesfully registered");
        }
    }
}
