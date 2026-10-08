using System.Text.Json;

namespace Mekik;

/// <summary>
/// The backplane wire envelope (PROTOCOL.md §5.1), .NET mirror of <c>@mekik/redis</c>'s
/// <c>encodeBackplaneMessage</c> / <c>decodeBackplaneMessage</c>. One shape for both
/// languages — canonical JSON of <c>{"frame", "originId"}</c>, camelCase — so TypeScript
/// and .NET nodes can share one Redis channel.
/// </summary>
public static class BackplaneEnvelope
{
    /// <summary>
    /// Encode <paramref name="message"/> as the canonical camelCase envelope — the exact
    /// bytes the TypeScript backplane writes.
    /// </summary>
    /// <example>
    /// <code>
    /// var payload = BackplaneEnvelope.Encode(new BackplaneMessage("node-a", frame));
    /// // {"frame":{…},"originId":"node-a"}
    /// </code>
    /// </example>
    public static string Encode(BackplaneMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);
        return Json.Serialize(new Dictionary<string, object?>
        {
            ["originId"] = message.OriginId,
            ["frame"] = message.Frame,
        });
    }

    /// <summary>
    /// Decode a payload read off a backplane channel, or <c>null</c> when it is not a
    /// well-formed envelope — a non-empty string <c>originId</c> and a <c>frame</c> object
    /// with a string <c>type</c>. A malformed payload is dropped, never fanned out.
    /// Reads <c>originId</c>/<c>frame</c> and, for one release (rolling upgrades from
    /// <c>Mekik.Redis</c> 0.9, which wrote PascalCase), <c>OriginId</c>/<c>Frame</c>;
    /// camelCase wins when both are present. Frame values come back as the plain
    /// <see cref="Json.Parse"/> shape (long seq, string type, …), like a locally produced frame.
    /// </summary>
    public static BackplaneMessage? Decode(string? payload)
    {
        if (string.IsNullOrEmpty(payload)) return null;
        try
        {
            using var doc = JsonDocument.Parse(payload);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!TryGet(root, "originId", "OriginId", out var origin) || origin.ValueKind != JsonValueKind.String)
                return null;
            var originId = origin.GetString();
            if (string.IsNullOrEmpty(originId)) return null;
            if (!TryGet(root, "frame", "Frame", out var frameEl) || frameEl.ValueKind != JsonValueKind.Object)
                return null;
            if (!frameEl.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
                return null;
            return new BackplaneMessage(originId, (Dictionary<string, object?>)Json.FromElement(frameEl)!);
        }
        catch (Exception e) when (e is JsonException or ArgumentException)
        {
            // Not JSON, or an object with duplicate keys: not a well-formed envelope.
            return null;
        }
    }

    private static bool TryGet(JsonElement obj, string camel, string pascal, out JsonElement value) =>
        obj.TryGetProperty(camel, out value) || obj.TryGetProperty(pascal, out value);
}
