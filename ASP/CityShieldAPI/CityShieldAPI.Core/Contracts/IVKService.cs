using CityShieldAPI.Data.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace CityShieldAPI.Core.Contracts
{
    public interface IVKService
    {
        public Task<List<User>> GetUsersInRangeAsync(JsonElement locations);
        public Task<List<User>> GetUsersInPolygonRangeAsync(JsonElement polygon);
        public Task<List<Guid>> SendUsersNotificationAsync(JsonElement locations);
    }
}
