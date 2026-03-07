using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using CityShieldAPI.DTOs;
namespace CityShielAPI.Core.Contracts
{
    public interface IAuthService
    {
        public Task<string?> LoginAsync(LoginRequest request);
        public Task RegisterAsync(RegisterRequest request);
        public Task<UserDTO> GetUserDataAsync(string userId);
    }
}
