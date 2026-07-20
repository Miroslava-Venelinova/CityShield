using CityShieldAPI.Core.Contracts;
using FirebaseAdmin.Messaging;

namespace CityShieldAPI.Core;

/// <summary>
/// Production IFirebaseMessenger backed by FirebaseMessaging.DefaultInstance.
/// Requires FirebaseApp.Create(...) to have run at startup.
/// </summary>
public class FirebaseMessenger : IFirebaseMessenger
{
    public async Task<IReadOnlyList<FcmSendOutcome>> SendMulticastAsync(
        IReadOnlyList<string> tokens, string title, string body,
        Dictionary<string, string>? data = null)
    {
        var message = new MulticastMessage
        {
            Tokens = tokens,
            Notification = new Notification { Title = title, Body = body },
            Data = data
        };

        var response = await FirebaseMessaging.DefaultInstance
            .SendEachForMulticastAsync(message);

        return response.Responses
            .Select(r => new FcmSendOutcome(r.IsSuccess, IsTokenInvalid(r.Exception)))
            .ToList();
    }

    // Only codes that definitively mean "this token is dead". InvalidArgument
    // is deliberately NOT here: FCM also returns it for message-level problems
    // (e.g. oversized payload), which would fail the whole batch and get every
    // token in it wrongly deleted.
    private static bool IsTokenInvalid(FirebaseMessagingException? ex) =>
         ex?.MessagingErrorCode is
             MessagingErrorCode.Unregistered or
             MessagingErrorCode.SenderIdMismatch;
}
