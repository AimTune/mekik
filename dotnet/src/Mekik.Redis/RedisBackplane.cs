using System.Text.Json;

using StackExchange.Redis;

namespace Mekik;

/// <summary>Options for <see cref="RedisBackplane"/>.</summary>
public sealed record RedisBackplaneOptions
{
    /// <summary>Channel prefix, so several apps can share one Redis. Default <c>"mekik"</c>.</summary>
    public string KeyPrefix { get; init; } = "mekik";
}

/// <summary>
/// Cross-node fan-out over Redis Pub/Sub (docs/SCALING.md §The ports), .NET mirror of
/// <c>@mekik/redis</c>'s <c>RedisBackplane</c>. The engine <see cref="PublishAsync"/>es
/// every dispatched frame; every node holding a tab of that conversation
/// <see cref="SubscribeAsync"/>s and re-fans it to its own sockets. Persist-once stays
/// with the producing node — the backplane only moves already-recorded frames, and the
/// engine skips its own by <c>OriginId</c>.
/// </summary>
public sealed class RedisBackplane : IBackplane
{
    // Internal mekik↔mekik payload; the only requirement is that serialize and
    // deserialize agree, which one options instance guarantees. Dictionary keys of the
    // frame itself (type, seq, data, …) round-trip verbatim.
    private static readonly JsonSerializerOptions Json = JsonSerializerOptions.Default;

    private readonly ISubscriber _sub;
    private readonly RedisBackplaneOptions _opts;

    public RedisBackplane(IConnectionMultiplexer redis, RedisBackplaneOptions? options = null)
    {
        _sub = redis.GetSubscriber();
        _opts = options ?? new RedisBackplaneOptions();
    }

    private RedisChannel Channel(string conversationId) =>
        RedisChannel.Literal($"{_opts.KeyPrefix}:bp:{conversationId}");

    public async Task PublishAsync(
        string conversationId, BackplaneMessage message, CancellationToken cancellationToken = default)
    {
        // Serialize the message directly (its OriginId/Frame property names match the
        // Wire DTO we read back). Frame is IReadOnlyDictionary, which STJ handles.
        var payload = JsonSerializer.Serialize(message, Json);
        await _sub.PublishAsync(Channel(conversationId), payload).ConfigureAwait(false);
    }

    public async Task<IAsyncDisposable> SubscribeAsync(
        string conversationId, Action<BackplaneMessage> handler, CancellationToken cancellationToken = default)
    {
        var channel = Channel(conversationId);

        void OnMessage(RedisChannel _, RedisValue value)
        {
            if (value.IsNullOrEmpty) return;
            Wire? wire;
            try { wire = JsonSerializer.Deserialize<Wire>(value.ToString(), Json); }
            catch (JsonException) { return; } // ignore anything that isn't a well-formed message
            if (wire is not null) handler(new BackplaneMessage(wire.OriginId, wire.Frame));
        }

        await _sub.SubscribeAsync(channel, OnMessage).ConfigureAwait(false);
        return new Subscription(_sub, channel, OnMessage);
    }

    /// <summary>Concrete DTO so deserialization never has to construct an interface type.</summary>
    private sealed record Wire(string OriginId, Dictionary<string, object?> Frame);

    private sealed class Subscription : IAsyncDisposable
    {
        private readonly ISubscriber _sub;
        private readonly RedisChannel _channel;
        private readonly Action<RedisChannel, RedisValue> _handler;
        private int _disposed;

        public Subscription(ISubscriber sub, RedisChannel channel, Action<RedisChannel, RedisValue> handler)
        {
            _sub = sub;
            _channel = channel;
            _handler = handler;
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            await _sub.UnsubscribeAsync(_channel, _handler).ConfigureAwait(false);
        }
    }
}
