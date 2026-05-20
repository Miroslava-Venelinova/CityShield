using System.Security.Claims;
using FcmDemo.Models;
using FcmDemo.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FcmDemo.Controllers;

[ApiController]
[Route("api/tokens")]
[Authorize]
public class TokensController : ControllerBase
{
    private readonly IFcmTokenService _fcm;

    public TokensController(IFcmTokenService fcm) => _fcm = fcm;

    /// <summary>Register or refresh a device token.</summary>
    [HttpPost]
    public async Task<IActionResult> Register([FromBody] RegisterTokenRequest req)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        await _fcm.UpsertTokenAsync(Guid.Parse(userId), req.Token, req.Platform, req.DeviceName);
        return NoContent();
    }

    /// <summary>Remove a device token (call on logout).</summary>
    [HttpDelete]
    public async Task<IActionResult> Unregister([FromBody] UnregisterTokenRequest req)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier)!;
        await _fcm.RemoveTokenAsync(Guid.Parse(userId), req.Token);
        return NoContent();
    }
}
