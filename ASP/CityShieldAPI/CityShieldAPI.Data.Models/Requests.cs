namespace FcmDemo.Models;

public record RegisterTokenRequest(string Token, string? Platform, string? DeviceName);
public record UnregisterTokenRequest(string Token);
