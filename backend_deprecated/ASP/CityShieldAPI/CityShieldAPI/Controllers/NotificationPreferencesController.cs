using CityShieldAPI.Core.Contracts;
using CityShieldAPI.DTOs.Preferences;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;

namespace CityShieldAPI.Controllers
{
    [ApiController]
    [Route("api/preferences")]
    [Authorize]
    public class NotificationPreferencesController : ControllerBase
    {
        private readonly INotificationPreferencesService _preferences;

        public NotificationPreferencesController(INotificationPreferencesService preferences)
        {
            _preferences = preferences;
        }

        /// <summary>Returns preference state for all known categories.</summary>
        [HttpGet]
        public async Task<IActionResult> GetAll()
        {
            var userId = GetUserId();
            var prefs = await _preferences.GetPreferencesAsync(userId);
            return Ok(prefs);
        }

        /// <summary>The user's bus-line filter for transport alerts plus the selectable catalog.</summary>
        [HttpGet("bus-lines")]
        public async Task<IActionResult> GetBusLines()
        {
            var subscription = await _preferences.GetBusLineSubscriptionAsync(GetUserId());
            return Ok(subscription);
        }

        /// <summary>Replaces the user's bus-line filter (empty list = all lines).</summary>
        [HttpPut("bus-lines")]
        public async Task<IActionResult> SetBusLines([FromBody] SetBusLinesRequest request)
        {
            try
            {
                await _preferences.SetBusLineSubscriptionAsync(GetUserId(), request.BusLines);
                return NoContent();
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
        }

        /// <summary>Enable or disable a single category.</summary>
        [HttpPut("{category}")]
        public async Task<IActionResult> Set(string category, [FromBody] SetPreferenceRequest request)
        {
            var userId = GetUserId();
            try
            {
                await _preferences.SetPreferenceAsync(userId, category, request.IsEnabled);
                return NoContent();
            }
            catch (ArgumentException ex)
            {
                return BadRequest(ex.Message);
            }
        }

        private Guid GetUserId() =>
            Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    }
}
