using CityShieldAPI.DTOs;
using CityShieldAPI.DTOs.Users;

namespace CityShieldAPI.Core.Contracts
{
    public interface IAuthService
    {
        Task<UserDTO> GetUserDataAsync(string userId);
        Task<string?> LoginAsync(LoginRequest request);
        Task RegisterAsync(RegisterRequest request);
        Task UpdateLocationAsync(string userId, UpdateLocationRequest request);
        Task DeleteAccountAsync(string userId);
    }
}
