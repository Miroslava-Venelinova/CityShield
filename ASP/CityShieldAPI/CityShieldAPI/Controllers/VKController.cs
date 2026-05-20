using CityShieldAPI.Core.Contracts;
using CityShieldAPI.Data.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;

namespace CityShieldAPI.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class VKController : ControllerBase
    {
        private readonly IVKService _vkService;
        public VKController(IVKService vKService)
        {
            _vkService = vKService;
        }

        [HttpPost("submit-data")]
        public async Task<IActionResult> SubmitData([FromBody] JsonElement data)
        {
            var id = data.GetProperty("id").GetString();

            var originalMessage = data.GetProperty("original_message");
            var title = originalMessage.GetProperty("title").GetString();
            var content = originalMessage.GetProperty("content").GetString();

            var processedData = data.GetProperty("processed_data");
            var startTime = processedData.GetProperty("start_time").GetString();
            var endTime = processedData.GetProperty("end_time").GetString();

            var locations = processedData.GetProperty("locations");
            var firstLocation = locations[0].GetProperty("location_name").GetString();

            return Ok(await _vkService.SendUsersNotificationAsync(locations));
        }
    }
}
