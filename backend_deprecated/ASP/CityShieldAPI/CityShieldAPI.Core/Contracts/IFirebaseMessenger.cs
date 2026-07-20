namespace CityShieldAPI.Core.Contracts;

/// <summary>Outcome of sending one FCM message to one device token.</summary>
/// <param name="IsSuccess">Whether FCM accepted the message.</param>
/// <param name="IsTokenInvalid">True when the failure means the token is
/// permanently dead (unregistered/invalid) and should be deleted.</param>
public record FcmSendOutcome(bool IsSuccess, bool IsTokenInvalid);

/// <summary>
/// Abstraction over the static FirebaseMessaging.DefaultInstance so services
/// that send notifications can be unit-tested without a live Firebase app.
/// </summary>
public interface IFirebaseMessenger
{
    /// <summary>Send one notification to a batch of device tokens.
    /// Returns one outcome per token, in the same order.</summary>
    Task<IReadOnlyList<FcmSendOutcome>> SendMulticastAsync(
        IReadOnlyList<string> tokens, string title, string body,
        Dictionary<string, string>? data = null);
}
