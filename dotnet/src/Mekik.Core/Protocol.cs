namespace Mekik;

/// <summary>
/// The mekik/1 wire protocol constants and inbound-frame parsing (PROTOCOL.md
/// §2, §3). Frames on this wire are modelled as
/// <c>Dictionary&lt;string, object?&gt;</c> — the same nested shape
/// <see cref="Json"/> reads and writes — so what the mapper emits and what
/// TypeScript emits are compared as canonical JSON with nothing lost to
/// serializer attributes or casing.
/// </summary>
public static class Protocol
{
    /// <summary>Announced in `welcome.data.protocol`. Major bump = breaking.</summary>
    public const string Version = "mekik/1";

    /// <summary>WS close code for an auth rejection (PROTOCOL.md §7).</summary>
    public const int AuthCloseCode = 4401;

    /// <summary>Server→client frame types that carry `seq`, persist, and replay (PROTOCOL.md §2).</summary>
    public static readonly IReadOnlySet<string> PersistentFrameTypes =
        new HashSet<string> { "text", "tool_call", "genui", "interrupt", "interrupt_resolved" };

    /// <summary>
    /// Frame types the protocol itself owns, in either direction. A rich message
    /// frame (PROTOCOL.md §4.5) may use any type EXCEPT these — <c>"text"</c> is the
    /// one deliberate overlap (a text message frame IS the text frame). <c>"typing"</c>
    /// is reserved defensively: chativa's shared frame parser claims it.
    /// </summary>
    public static readonly IReadOnlySet<string> ReservedFrameTypes = new HashSet<string>
    {
        "hello", "welcome", "text", "resume", "genui_event", "abort",
        "tool_call", "genui", "genui_components", "interrupt", "interrupt_resolved", "run", "error", "typing",
    };

    private static readonly IReadOnlySet<string> IncomingTypes =
        new HashSet<string> { "hello", "text", "resume", "genui_event", "abort" };

    /// <summary>
    /// True for a rich message frame (PROTOCOL.md §4.5): the text envelope under a
    /// non-reserved type. Only the mapper mints these, so the shape check guards
    /// against misclassifying, not validity. Mirror of TS <c>isMessageFrame</c>.
    /// </summary>
    public static bool IsMessageFrame(IReadOnlyDictionary<string, object?> frame) =>
        frame.GetValueOrDefault("type") is string type &&
        !ReservedFrameTypes.Contains(type) &&
        frame.GetValueOrDefault("id") is string &&
        frame.GetValueOrDefault("seq") is long or int or double;

    public static bool IsPersistent(IReadOnlyDictionary<string, object?> frame) =>
        (frame.TryGetValue("type", out var t) && t is string s && PersistentFrameTypes.Contains(s)) ||
        IsMessageFrame(frame);

    /// <summary>
    /// Parse one client→server message (a JSON string or an already-parsed object)
    /// into a validated frame dictionary. Throws <see cref="ProtocolException"/>
    /// with code <c>bad_request</c> on anything malformed — the engine turns that
    /// into an <c>error</c> frame and keeps the connection open (PROTOCOL.md §3.1).
    /// </summary>
    public static IReadOnlyDictionary<string, object?> ParseIncoming(object? raw)
    {
        object? value = raw;
        if (raw is string str)
        {
            try { value = Json.Parse(str); }
            catch { throw new ProtocolException("bad_request", "frame is not valid JSON"); }
        }

        if (value is not IReadOnlyDictionary<string, object?> frame)
            throw new ProtocolException("bad_request", "frame must be a JSON object");

        if (frame.GetValueOrDefault("type") is not string type || !IncomingTypes.Contains(type))
            throw new ProtocolException("bad_request", $"unknown or missing frame type {frame.GetValueOrDefault("type")}");

        switch (type)
        {
            case "text":
                if (frame.GetValueOrDefault("data") is not IReadOnlyDictionary<string, object?> data
                    || data.GetValueOrDefault("text") is not string)
                    throw new ProtocolException("bad_request", "text frame requires data.text: string");
                break;
            case "resume":
                if (frame.GetValueOrDefault("answers") is not IReadOnlyDictionary<string, object?>)
                    throw new ProtocolException("bad_request", "resume frame requires answers: object");
                break;
            case "genui_event":
                if (frame.GetValueOrDefault("streamId") is not string || frame.GetValueOrDefault("eventType") is not string)
                    throw new ProtocolException("bad_request", "genui_event requires streamId and eventType strings");
                if (frame.GetValueOrDefault("scope") is { } scope && scope is not ("component" or "graph"))
                    throw new ProtocolException("bad_request", "genui_event scope must be \"component\" or \"graph\"");
                break;
        }

        return frame;
    }
}

/// <summary>A malformed inbound frame; <see cref="Code"/> becomes the `error` frame's code.</summary>
public sealed class ProtocolException : Exception
{
    public string Code { get; }
    public ProtocolException(string code, string message) : base(message) => Code = code;
}
