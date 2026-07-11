using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace CityShieldAPI.Filters;

/// <summary>
/// Requires the X-Api-Key header to match Ingest:ApiKey (env: Ingest__ApiKey)
/// on the endpoint it decorates. Attached to the action itself — unlike a
/// path-matched middleware, a route rename or a new ingest endpoint can never
/// silently detach the check. When no key is configured the endpoint stays
/// open (local dev); production refuses to start without one (see Program.cs).
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class RequireIngestApiKeyAttribute : Attribute, IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext context)
    {
        var expected = context.HttpContext.RequestServices
            .GetRequiredService<IConfiguration>()["Ingest:ApiKey"];
        if (string.IsNullOrEmpty(expected)) return;

        var provided = context.HttpContext.Request.Headers["X-Api-Key"].FirstOrDefault();
        if (provided != expected)
        {
            context.Result = new UnauthorizedObjectResult(
                new { error = "Invalid or missing API key." });
        }
    }
}
