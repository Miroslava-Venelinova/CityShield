using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace CityShieldAPI.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class VKController : ControllerBase
    {
        [HttpPost("submit-data")]
        public async Task<IActionResult> SubmitData()
        {
            Console.WriteLine("saf");
            return Ok();
        }
    }
}
