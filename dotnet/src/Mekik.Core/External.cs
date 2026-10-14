namespace Mekik;

// A wire frame — mekik models frames as dictionaries for byte-exact parity (PROTOCOL.md §9).
using Frame = System.Collections.Generic.IReadOnlyDictionary<string, object?>;

// The external-transcript deployment profile (PROTOCOL.md "Running behind a hub"),
// mirror of the TypeScript external.ts. When a hub such as Converger owns the
// transcript and the seq space, mekik stops being either: it keeps no frames,
// replays nothing, trusts the hub's identity and does not echo the user's own turn.
// The wire mekik produces is unchanged — the engine still stamps `seq`, but the hub
// renumbers it on persistence, so the value is a hint. All opt-in:
//
//   var app = new MekikApp(new MekikOptions { Graph = graph }.WithExternalTranscript());
//   await using var hub = ConvergerTransport.Connect(app, new ConvergerOptions { Url = ..., Secret = ... });

/// <summary>
/// The shared notebook between a hub transport and the profile's ports: the transport
/// records what the hub said about a conversation before it connects the conversation's
/// virtual connection; the stores read it back.
/// </summary>
public sealed class ExternalTranscript
{
    private readonly Dictionary<string, (string? UserId, long Seq)> _byId = new();
    private readonly object _lock = new();

    /// <summary>Record what the hub said: the owner (the first one sticks) and the seq to continue from.</summary>
    public void Observe(string conversationId, string? userId = null, long? seq = null)
    {
        lock (_lock)
        {
            var prev = _byId.TryGetValue(conversationId, out var p) ? p : ((string?)null, 0L);
            _byId[conversationId] = (prev.Item1 ?? userId, seq ?? prev.Item2);
        }
    }

    /// <summary>The user the hub reported for the conversation, if any.</summary>
    public string? Owner(string conversationId)
    {
        lock (_lock) return _byId.TryGetValue(conversationId, out var f) ? f.UserId : null;
    }

    /// <summary>The seq to continue from (0 when the hub said nothing).</summary>
    public long Seq(string conversationId)
    {
        lock (_lock) return _byId.TryGetValue(conversationId, out var f) ? f.Seq : 0;
    }

    /// <summary>Drop a conversation the transport stopped serving (idle eviction).</summary>
    public void Forget(string conversationId)
    {
        lock (_lock) _byId.Remove(conversationId);
    }

    /// <summary>How many conversations are being served.</summary>
    public int Count
    {
        get { lock (_lock) return _byId.Count; }
    }
}

/// <summary>
/// The transcript port when the hub is the transcript: <c>RecordAsync</c> keeps nothing,
/// <c>AfterAsync</c> replays nothing (the hub replays its own transcript to its clients),
/// and <c>CurrentSeqAsync</c> seeds the engine's counter from what the hub reported.
/// </summary>
public sealed class ExternalTranscriptHistoryStore(ExternalTranscript? transcript = null) : IHistoryStore
{
    public ExternalTranscript Transcript { get; } = transcript ?? new ExternalTranscript();

    public Task RecordAsync(string conversationId, Frame frame) => Task.CompletedTask;

    public Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, long watermark) =>
        Task.FromResult<IReadOnlyList<Frame>>([]);

    public Task<long> CurrentSeqAsync(string conversationId) => Task.FromResult(Transcript.Seq(conversationId));
}

/// <summary>
/// The conversation registry when the hub owns conversations: <c>GetAsync</c> answers from
/// what the transport observed (the hub already checked access), <c>CreateAsync</c> is a
/// no-op — a hub transport never asks the engine to mint a conversation.
/// </summary>
public sealed class HubConversationStore(ExternalTranscript transcript) : IConversationStore
{
    public ExternalTranscript Transcript { get; } = transcript;

    public Task<ConversationRecord?> GetAsync(string conversationId) =>
        Task.FromResult(Transcript.Owner(conversationId) is { } userId
            ? new ConversationRecord(conversationId, userId, 0, new Dictionary<string, object?>())
            : null);

    public Task CreateAsync(ConversationRecord record) => Task.CompletedTask;
}

/// <summary>
/// Trusts the identity the hub verified at its edge, which the hub transport puts at
/// <c>credential.Meta["auth"]</c> (<c>{ userId, role?, name? }</c>). The whole object becomes
/// the claims (<c>ctx.Meta["auth"]</c>). Anti-spoofing is the hub's job; this only works with
/// a transport that synthesises the hello itself, never with <c>MapMekik</c>.
/// </summary>
public sealed class HubAuthenticator : IAuthenticator
{
    public ValueTask<AuthVerdict> AuthenticateAsync(Credential credential)
    {
        if (credential.Meta?.GetValueOrDefault("auth") is IReadOnlyDictionary<string, object?> auth &&
            auth.GetValueOrDefault("userId") is string { Length: > 0 } userId)
        {
            return ValueTask.FromResult(new AuthVerdict
            {
                Ok = true,
                UserId = userId,
                Claims = auth.ToDictionary(kv => kv.Key, kv => kv.Value),
            });
        }
        return ValueTask.FromResult(new AuthVerdict { Ok = false, Reason = "no hub-verified identity" });
    }
}

/// <summary>The external-transcript profile in one call.</summary>
public static class ExternalTranscriptProfile
{
    /// <summary>
    /// The options with the profile's ports set and the user-turn echo off. A hub transport
    /// finds the shared <see cref="ExternalTranscript"/> through
    /// <c>((ExternalTranscriptHistoryStore)app.History).Transcript</c>.
    /// </summary>
    public static MekikOptions WithExternalTranscript(this MekikOptions options, ExternalTranscript? transcript = null)
    {
        var shared = transcript ?? new ExternalTranscript();
        return options with
        {
            History = new ExternalTranscriptHistoryStore(shared),
            Conversations = new HubConversationStore(shared),
            Authenticator = new HubAuthenticator(),
            EchoUserTurns = false,
        };
    }
}
