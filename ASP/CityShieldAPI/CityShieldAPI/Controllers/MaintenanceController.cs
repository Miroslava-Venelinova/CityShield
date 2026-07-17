using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Filters;
using Microsoft.AspNetCore.Mvc;

namespace CityShieldAPI.Controllers
{
    /// <summary>
    /// Machine-to-machine maintenance endpoints, guarded by the ingest API key.
    /// On scale-to-zero platforms the in-process StaleTokenCleanupService timer
    /// never fires reliably, so an external scheduler calls these instead
    /// (TokenCleanup__InProcess=false disables the background service there).
    /// </summary>
    [ApiController]
    [Route("api/maintenance")]
    [RequireIngestApiKey]
    public class MaintenanceController : ControllerBase
    {
        private readonly IFcmTokenService _tokens;

        public MaintenanceController(IFcmTokenService tokens)
        {
            _tokens = tokens;
        }

        /// <summary>Purges device tokens unseen for 60+ days.</summary>
        [HttpPost("cleanup-tokens")]
        public async Task<IActionResult> CleanupTokens()
        {
            await _tokens.CleanupStaleTokensAsync();
            return NoContent();
        }
    }
}
