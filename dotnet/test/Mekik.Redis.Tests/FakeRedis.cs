using System.Reflection;
using StackExchange.Redis;

namespace Mekik.Redis.Tests;

/// <summary>
/// A minimal in-process Redis for the calls mekik makes — <c>SET NX PX</c>, the two
/// token-checked Lua scripts, Pub/Sub — behind StackExchange.Redis's own interfaces,
/// built with <see cref="DispatchProxy"/> so only the members actually used need
/// implementing. Any other member throws, so a new Redis call in the library shows
/// up as a failing test rather than a silent no-op.
/// </summary>
internal sealed class FakeRedis
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (string Value, TimeSpan? Ttl)> _keys = new();
    private readonly Dictionary<string, List<Action<RedisChannel, RedisValue>>> _subs = new();

    public List<string> Scripts { get; } = new();
    public List<(string Channel, string Payload)> Published { get; } = new();
    /// <summary>Completes on the next PEXPIRE script — a heartbeat observed without sleeping.</summary>
    public TaskCompletionSource Renewed { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public IConnectionMultiplexer Multiplexer { get; }

    public FakeRedis()
    {
        var db = Proxy<IDatabase>.Create(DatabaseCall);
        var sub = Proxy<ISubscriber>.Create(SubscriberCall);
        Multiplexer = Proxy<IConnectionMultiplexer>.Create((m, _) => m.Name switch
        {
            "GetDatabase" => db,
            "GetSubscriber" => sub,
            _ => throw new NotSupportedException($"FakeRedis: IConnectionMultiplexer.{m.Name}"),
        });
    }

    public string? Get(string key)
    {
        lock (_gate) return _keys.TryGetValue(key, out var v) ? v.Value : null;
    }

    public TimeSpan? TtlOf(string key)
    {
        lock (_gate) return _keys.TryGetValue(key, out var v) ? v.Ttl : null;
    }

    /// <summary>The key's TTL lapsed (or someone deleted it).</summary>
    public void Expire(string key)
    {
        lock (_gate) _keys.Remove(key);
    }

    public void Set(string key, string value)
    {
        lock (_gate) _keys[key] = (value, null);
    }

    public int Subscribers(string channel)
    {
        lock (_gate) return _subs.GetValueOrDefault(channel)?.Count ?? 0;
    }

    /// <summary>Deliver a raw payload as if another process published it.</summary>
    public void Inject(string channel, RedisValue payload)
    {
        List<Action<RedisChannel, RedisValue>> handlers;
        lock (_gate) handlers = _subs.GetValueOrDefault(channel)?.ToList() ?? [];
        foreach (var h in handlers) h(RedisChannel.Literal(channel), payload);
    }

    private object? DatabaseCall(MethodInfo m, object?[]? args)
    {
        args ??= [];
        switch (m.Name)
        {
            case "StringSetAsync":
            {
                var key = (string)args.OfType<RedisKey>().First()!;
                var value = (string)args.OfType<RedisValue>().First()!;
                var ttl = args.OfType<TimeSpan>().Cast<TimeSpan?>().FirstOrDefault();
                var when = args.OfType<When>().FirstOrDefault();
                lock (_gate)
                {
                    if (when == When.NotExists && _keys.ContainsKey(key)) return Task.FromResult(false);
                    _keys[key] = (value, ttl);
                }
                return Task.FromResult(true);
            }
            case "ScriptEvaluateAsync":
            {
                var script = (string)args[0]!;
                var keys = (RedisKey[])args[1]!;
                var values = (RedisValue[])args[2]!;
                var key = (string)keys[0]!;
                var token = (string)values[0]!;
                long result;
                lock (_gate)
                {
                    Scripts.Add(script.Contains("pexpire") ? "renew" : "release");
                    var owned = _keys.TryGetValue(key, out var cur) && cur.Value == token;
                    if (!owned) result = 0;
                    else if (script.Contains("pexpire"))
                    {
                        _keys[key] = (cur.Value, TimeSpan.FromMilliseconds((long)values[1]));
                        result = 1;
                    }
                    else
                    {
                        _keys.Remove(key);
                        result = 1;
                    }
                }
                if (script.Contains("pexpire")) Renewed.TrySetResult();
                return Task.FromResult(RedisResult.Create((RedisValue)result));
            }
            default:
                throw new NotSupportedException($"FakeRedis: IDatabase.{m.Name}");
        }
    }

    private object? SubscriberCall(MethodInfo m, object?[]? args)
    {
        args ??= [];
        switch (m.Name)
        {
            case "PublishAsync":
            {
                var channel = args[0]!.ToString()!;
                var payload = (RedisValue)args[1]!;
                lock (_gate) Published.Add((channel, payload.ToString()));
                Inject(channel, payload);
                return Task.FromResult(1L);
            }
            case "SubscribeAsync" when args.Length >= 2 && args[1] is Action<RedisChannel, RedisValue> handler:
            {
                var channel = args[0]!.ToString()!;
                lock (_gate)
                {
                    if (!_subs.TryGetValue(channel, out var list)) _subs[channel] = list = new();
                    list.Add(handler);
                }
                return Task.CompletedTask;
            }
            case "UnsubscribeAsync":
            {
                var channel = args[0]!.ToString()!;
                var handler = args.Length >= 2 ? args[1] as Action<RedisChannel, RedisValue> : null;
                lock (_gate)
                {
                    if (_subs.TryGetValue(channel, out var list))
                    {
                        if (handler is null) list.Clear();
                        else list.Remove(handler);
                    }
                }
                return Task.CompletedTask;
            }
            default:
                throw new NotSupportedException($"FakeRedis: ISubscriber.{m.Name}");
        }
    }
}

/// <summary>A <see cref="DispatchProxy"/> that forwards every call to a delegate.</summary>
public class Proxy<T> : DispatchProxy where T : class
{
    private Func<MethodInfo, object?[]?, object?> _handler = (m, _) => throw new NotSupportedException(m.Name);

    internal static T Create(Func<MethodInfo, object?[]?, object?> handler)
    {
        var proxy = Create<T, Proxy<T>>();
        ((Proxy<T>)(object)proxy)._handler = handler;
        return proxy;
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => _handler(targetMethod!, args);
}
