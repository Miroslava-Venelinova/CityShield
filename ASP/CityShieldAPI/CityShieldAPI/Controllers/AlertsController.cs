using CityShieldAPI.Core;
using CityShieldAPI.Core.Contracts;
using CityShieldAPI.DTOs.Alerts;
using CityShieldAPI.Filters;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;

namespace CityShieldAPI.Controllers
{
    /// <summary>
    /// Alert ingestion (from the Python scraping backend) and retrieval
    /// (for the mobile app's map and feed).
    /// </summary>
    [Route("api/alerts")]
    [ApiController]
    public class AlertsController : ControllerBase
    {
        // Alerts older than this are no longer "active" for the app.
        private static readonly TimeSpan RecentWindow = TimeSpan.FromHours(48);
        private const int RecentLimit = 100;

        private readonly IAlertService _alertService;
        private readonly ILogger<AlertsController> _logger;

        public AlertsController(IAlertService alertService, ILogger<AlertsController> logger)
        {
            _alertService = alertService;
            _logger = logger;
        }

        /// <summary>
        /// Ingestion endpoint. Receives structured alert payloads from any
        /// source (vik, epro, heating, roads, vt, ...), stores the alert with
        /// geocoded coordinates and dispatches notifications to affected users.
        /// </summary>
        [HttpPost("submit-data")]
        [RequireIngestApiKey]
        public async Task<IActionResult> SubmitData([FromBody] SubmitAlertRequest data)
        {
            var title   = data.OriginalMessage.Title is { Length: > 0 } t ? t : "Alert";
            var content = data.OriginalMessage.Content ?? "";

            // Category comes from the scraper payload ("vik", "epro", ...);
            // default to "vik" for older payloads that don't send it.
            var category = data.Category ?? "vik";

            if (!NotificationPreferencesService.KnownCategories.ContainsKey(category))
                return BadRequest(new { error = $"Unknown category: {category}" });

            var startTime = data.ProcessedData.StartTime;
            var endTime   = data.ProcessedData.EndTime;

            var locations = data.ProcessedData.Locations;
            if (locations.ValueKind != JsonValueKind.Array)
                return BadRequest(new { error = "processed_data.locations must be an array." });

            // ── Persist for the map / feed ─────────────────────────────────────
            // Stored BEFORE notifications go out: if the store fails the
            // scraper gets a 500 and can safely re-submit, because no push
            // has been sent yet.
            var alertId = await _alertService.StoreAlertAsync(
                category, title, content, startTime, endTime, locations);

            // ── Dispatch notifications ─────────────────────────────────────────
            // Never fails the request once the alert is stored: a non-2xx here
            // would make the scraper re-submit a message whose pushes already
            // went out, duplicating both the alert and the notifications.
            var notifiedIds = new List<Guid>();
            try
            {
                notifiedIds = await _alertService.SendUsersNotificationAsync(
                    locations, title, content, category, startTime, endTime,
                    data.ProcessedData.CityWide, data.ProcessedData.BusLines);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Notification dispatch failed for alert {AlertId}; the alert is stored.",
                    alertId);
            }

            return Ok(new
            {
                alert_id       = alertId,
                notified_count = notifiedIds.Count,
                user_ids       = notifiedIds,
            });
        }

        /// <summary>
        /// Active alerts for the app's map and feed, newest first, with
        /// per-location coordinates / polygons ready to render.
        /// </summary>
        [HttpGet("recent")]
        [Authorize]
        public async Task<IActionResult> GetRecent()
        {
            var alerts = await _alertService.GetRecentAlertsAsync(RecentWindow, RecentLimit);
            return Ok(alerts);
        }
    }
}
