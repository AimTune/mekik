using StackExchange.Redis;

namespace Mekik;

/// <summary>Options for <see cref="RedisTurnLock"/>.</summary>
public sealed record RedisTurnLockOptions
{
    /// <summary>Key prefix, so several apps can share one Redis. Default <c>"mekik"</c>.</summary>
    public string KeyPrefix { get; init; } = "mekik";

    /// <summary>
    /// Lock TTL — how long it survives without a heartbeat. Must exceed a turn's
    /// worst case; a crashed owner's lock expires after this. Default 30s.
    /// </summary>
    public TimeSpan Ttl { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Heartbeat interval — the held lease self-renews this often. Default <c>Ttl / 3</c>.</summary>
    public TimeSpan? Heartbeat { get; init; }

    /// <summary>Called if a heartbeat finds the lease was lost (TTL lapsed or stolen).</summary>
    public Action<string>? OnLost { get; init; }
}

/// <summary>
/// The distributed turn lock (docs/SCALING.md §The ports), .NET mirror of
/// <c>@mekik/redis</c>'s <c>RedisTurnLock</c>. <see cref="AcquireAsync"/> does a
/// <c>SET key token NX PX ttl</c>; on success it returns a lease that heartbeats its
/// own TTL until disposed, so the engine never has to. <c>null</c> means another node
/// holds the turn — the caller answers <c>busy</c>. Release is a token-checked
/// <c>DEL</c>, so a node can only free a lease it still owns.
/// </summary>
public sealed class RedisTurnLock : ITurnLock
{
    // Token-checked so a node only ever renews or releases a lease it still holds.
    private const string RenewLua =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
    private const string ReleaseLua =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

    private readonly IDatabase _db;
    private readonly RedisTurnLockOptions _opts;
    private readonly TimeSpan _heartbeat;

    public RedisTurnLock(IConnectionMultiplexer redis, RedisTurnLockOptions? options = null)
    {
        _db = redis.GetDatabase();
        _opts = options ?? new RedisTurnLockOptions();
        _heartbeat = _opts.Heartbeat ??
            TimeSpan.FromMilliseconds(Math.Max(1000, _opts.Ttl.TotalMilliseconds / 3));
    }

    private string Key(string conversationId) => $"{_opts.KeyPrefix}:lock:{conversationId}";

    public async Task<ITurnLease?> AcquireAsync(string conversationId, CancellationToken cancellationToken = default)
    {
        var key = Key(conversationId);
        var token = Guid.NewGuid().ToString("N");

        bool ok = await _db.StringSetAsync(key, token, expiry: _opts.Ttl, when: When.NotExists).ConfigureAwait(false);
        if (!ok) return null; // another node owns the turn

        return new RedisTurnLease(_db, key, token, _opts, _heartbeat, conversationId);
    }

    private sealed class RedisTurnLease : ITurnLease
    {
        private readonly IDatabase _db;
        private readonly RedisKey _key;
        private readonly RedisValue _token;
        private readonly RedisTurnLockOptions _opts;
        private readonly string _conversationId;
        private readonly Timer _heartbeat;
        private int _released;

        public RedisTurnLease(
            IDatabase db, string key, string token, RedisTurnLockOptions opts, TimeSpan heartbeat, string conversationId)
        {
            _db = db;
            _key = key;
            _token = token;
            _opts = opts;
            _conversationId = conversationId;
            // The lease keeps itself alive: the engine acquires once and holds through a
            // run that may stream for many seconds, without calling RenewAsync itself.
            _heartbeat = new Timer(_ => _ = TickAsync(), null, heartbeat, heartbeat);
        }

        private async Task TickAsync()
        {
            if (Volatile.Read(ref _released) != 0) return;
            try { await RenewAsync().ConfigureAwait(false); }
            catch { /* transient Redis error; the next tick retries */ }
        }

        public async Task RenewAsync(CancellationToken cancellationToken = default)
        {
            var result = await _db.ScriptEvaluateAsync(
                RenewLua,
                new RedisKey[] { _key },
                new RedisValue[] { _token, (long)_opts.Ttl.TotalMilliseconds }).ConfigureAwait(false);
            // pexpire returns 1 on success; 0 means the key was gone (lease lost).
            if ((long)result == 0 && Volatile.Read(ref _released) == 0)
                _opts.OnLost?.Invoke(_conversationId);
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0) return;
            await _heartbeat.DisposeAsync().ConfigureAwait(false);
            await _db.ScriptEvaluateAsync(
                ReleaseLua,
                new RedisKey[] { _key },
                new RedisValue[] { _token }).ConfigureAwait(false);
        }
    }
}
