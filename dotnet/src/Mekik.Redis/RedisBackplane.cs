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
/// engine skips its own by <c>OriginId</c>. Payloads use the cross-language
/// <see cref="BackplaneEnvelope"/>, so .NET and TypeScript nodes can share a channel.
/// </summary>
public sealed class RedisBackplane : IBackplane
{
    private readonly ISubscriber _sub;
    private readonly RedisBackplaneOptions _opts;

    public RedisBackplane(IConnectionMultiplexer redis, RedisBackplaneOptions? options = null)
    {
        _sub = redis.GetSubscriber();
        _opts = options ?? new RedisBackplaneOptions();
    }

    private RedisChannel Channel(string conversationId) =>
        RedisChannel.Literal($"{_opts.KeyPrefix}:bp:{conversationId}");

    /// <summary>Broadcast an already-recorded frame to every other node on this conversation.</summary>
    public async Task PublishAsync(
        string conversationId, BackplaneMessage message, CancellationToken cancellationToken = default)
    {
        await _sub.PublishAsync(Channel(conversationId), BackplaneEnvelope.Encode(message)).ConfigureAwait(false);
    }

    /// <summary>
    /// Subscribe this node to a conversation's frames. Dispose the returned
    /// <see cref="IAsyncDisposable"/> to remove this handler and its Redis subscription.
    /// </summary>
    public async Task<IAsyncDisposable> SubscribeAsync(
        string conversationId, Action<BackplaneMessage> handler, CancellationToken cancellationToken = default)
    {
        var channel = Channel(conversationId);

        void OnMessage(RedisChannel _, RedisValue value)
        {
            if (value.IsNullOrEmpty) return;
            // Not a well-formed envelope: drop it, never fan it out.
            if (BackplaneEnvelope.Decode(value.ToString()) is { } message) handler(message);
        }

        await _sub.SubscribeAsync(channel, OnMessage).ConfigureAwait(false);
        return new Subscription(_sub, channel, OnMessage);
    }

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
