namespace CityShieldAPI.DTOs.Preferences
{
    public class NotificationPreferenceDTO
    {
        public required string Category { get; set; }
        public required string Label { get; set; }
        public bool IsEnabled { get; set; }
    }

    public class SetPreferenceRequest
    {
        public bool IsEnabled { get; set; }
    }

    /// <summary>
    /// Bus-line filter for "vt" (transport) alerts. An empty Selected list
    /// means no filter — the user receives alerts for every line.
    /// </summary>
    public class BusLineSubscriptionDTO
    {
        public required List<string> Available { get; set; }
        public required List<string> Selected { get; set; }
    }

    public class SetBusLinesRequest
    {
        public required List<string> BusLines { get; set; }
    }
}
