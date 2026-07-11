using CityShieldAPI.Core.Contracts;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CityShieldAPI.Core;

/// <summary>
/// Runs IFcmTokenService.CleanupStaleTokensAsync once a day so device tokens
/// unseen for 60+ days don't accumulate forever. Resolves the scoped token
/// service per run (a hosted service is a singleton and can't inject it directly).
/// </summary>
public class StaleTokenCleanupService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<StaleTokenCleanupService> _logger;

    public StaleTokenCleanupService(
        IServiceScopeFactory scopeFactory,
        ILogger<StaleTokenCleanupService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var tokens = scope.ServiceProvider.GetRequiredService<IFcmTokenService>();
                await tokens.CleanupStaleTokensAsync();
            }
            catch (Exception ex)
            {
                // Cleanup is best-effort; never let it kill the host.
                _logger.LogError(ex, "Stale FCM token cleanup failed.");
            }

            try
            {
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
