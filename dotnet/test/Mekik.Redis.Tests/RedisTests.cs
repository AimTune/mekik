using System.Net.Sockets;
using Ilmek;
using Mekik;
using StackExchange.Redis;

namespace Mekik.Redis.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

internal static class Kit
{
    public static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    internal sealed class Conn : IConnection
    {
        private static int _n;
        private readonly object _gate = new();
        private readonly List<Frame> _sent = new();
        public string Id { get; } = $"c-{Interlocked.Increment(ref _n)}";
        public List<Frame> Sent { get { lock (_gate) return _sent.ToList(); } }
        public void Send(Frame frame)
        {
            _ = Json.Serialize(frame);
            lock (_gate) _sent.Add(frame);
        }
        public void Close(int? code = null, string? reason = null) { }
        public Frame Welcome => (Frame)Sent.First(f => f["type"] as string == "welcome")["data"]!;
        public List<string?> Codes => Sent.Where(f => f["type"] as string == "error").Select(f => ((Frame)f["data"]!)["code"] as string).ToList();
    }

    public static Dictionary<string, object?> Text(string t) => D(("type", "text"), ("data", D(("text", t))));

    public static readonly CompiledGraph Echo = Graph.Create("echo")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("echo", (State s, IContext _) => Update.Of("reply", $"echo:{s.Get<string>("input")}"))
        .Edge(Graph.Start, "echo")
        .Edge("echo", Graph.End)
        .Compile();

    public static CompiledGraph Gated(TaskCompletionSource entered, Task release) => Graph.Create("gated")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("wait", async (State s, IContext _) =>
        {
            entered.TrySetResult();
            await release;
            return Update.Of("reply", "done");
        })
        .Edge(Graph.Start, "wait")
        .Edge("wait", Graph.End)
        .Compile();
}

/// <summary><see cref="RedisTurnLock"/> against an in-process Redis: SET NX PX, token-checked renew/release, heartbeat.</summary>
public class RedisTurnLockTests
{
    [Fact]
    public async Task Acquire_sets_the_prefixed_key_with_the_ttl_and_a_second_acquire_is_refused()
    {
        var redis = new FakeRedis();
        var turnLock = new RedisTurnLock(redis.Multiplexer, new RedisTurnLockOptions { Ttl = TimeSpan.FromSeconds(9) });

        await using var lease = await turnLock.AcquireAsync("conv-1");
        var second = await turnLock.AcquireAsync("conv-1");

        Assert.NotNull(lease);
        Assert.Null(second);
        Assert.NotNull(redis.Get("mekik:lock:conv-1"));
        Assert.Equal(TimeSpan.FromSeconds(9), redis.TtlOf("mekik:lock:conv-1"));
        Assert.NotNull(await turnLock.AcquireAsync("conv-2")); // per conversation
    }

    [Fact]
    public async Task The_key_prefix_is_configurable()
    {
        var redis = new FakeRedis();
        var turnLock = new RedisTurnLock(redis.Multiplexer, new RedisTurnLockOptions { KeyPrefix = "app2" });

        await using var lease = await turnLock.AcquireAsync("c");

        Assert.NotNull(redis.Get("app2:lock:c"));
        Assert.Null(redis.Get("mekik:lock:c"));
    }

    [Fact]
    public async Task Disposing_releases_once_and_frees_the_turn()
    {
        var redis = new FakeRedis();
        var turnLock = new RedisTurnLock(redis.Multiplexer);
        var lease = await turnLock.AcquireAsync("c");

        await lease!.DisposeAsync();
        await lease.DisposeAsync();

        Assert.Null(redis.Get("mekik:lock:c"));
        Assert.Equal(["release"], redis.Scripts);
        Assert.NotNull(await turnLock.AcquireAsync("c"));
    }

    [Fact]
    public async Task A_stale_lease_cannot_release_the_next_owners_lock()
    {
        var redis = new FakeRedis();
        var turnLock = new RedisTurnLock(redis.Multiplexer);
        var stale = await turnLock.AcquireAsync("c");
        redis.Expire("mekik:lock:c"); // the TTL lapsed while the old owner stalled
        await using var current = await turnLock.AcquireAsync("c");

        await stale!.DisposeAsync();

        Assert.NotNull(redis.Get("mekik:lock:c"));
        Assert.Null(await turnLock.AcquireAsync("c")); // still held by the current owner
    }

    [Fact]
    public async Task Renew_extends_a_held_lease_and_reports_a_lost_one()
    {
        var redis = new FakeRedis();
        var lost = new List<string>();
        var turnLock = new RedisTurnLock(redis.Multiplexer, new RedisTurnLockOptions
        {
            Ttl = TimeSpan.FromSeconds(30),
            Heartbeat = TimeSpan.FromHours(1), // no automatic ticks in this test
            OnLost = lost.Add,
        });
        var lease = await turnLock.AcquireAsync("c");

        await lease!.RenewAsync();
        Assert.Empty(lost);
        Assert.Equal(TimeSpan.FromSeconds(30), redis.TtlOf("mekik:lock:c"));

        redis.Set("mekik:lock:c", "someone-else"); // stolen
        await lease.RenewAsync();
        Assert.Equal(["c"], lost);

        await lease.DisposeAsync();
        await lease.RenewAsync(); // after release a failed renew is expected, not a loss
        Assert.Single(lost);
    }

    [Fact]
    public async Task A_held_lease_heartbeats_on_its_own()
    {
        var redis = new FakeRedis();
        var turnLock = new RedisTurnLock(redis.Multiplexer, new RedisTurnLockOptions { Heartbeat = TimeSpan.FromMilliseconds(20) });

        await using var lease = await turnLock.AcquireAsync("c");

        await redis.Renewed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("renew", redis.Scripts);
    }

    [Fact]
    public async Task A_lease_held_by_another_node_answers_busy_and_nothing_runs()
    {
        var redis = new FakeRedis();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var history = new InMemoryHistoryStore();
        var conversations = new InMemoryConversationStore();
        var checkpointer = new InMemoryCheckpointer();
        MekikApp Node() => new(new MekikOptions
        {
            Graph = Kit.Gated(entered, release.Task),
            Checkpointer = checkpointer,
            History = history,
            Conversations = conversations,
            Reply = s => s.GetValueOrDefault("reply") as string,
            TurnLock = new RedisTurnLock(redis.Multiplexer),
        });
        var (nodeA, nodeB) = (Node(), Node());
        var a = new Kit.Conn();
        await nodeA.ConnectAsync(a);
        var b = new Kit.Conn();
        await nodeB.ConnectAsync(b, new ConnectParams { Hello = new HelloInfo { UserId = (string)a.Welcome["userId"]!, ConversationId = (string)a.Welcome["conversationId"]! } });

        var running = nodeA.ReceiveAsync(a, Kit.Text("one"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await nodeB.ReceiveAsync(b, Kit.Text("two"));
        release.SetResult();
        await running;

        Assert.Equal(["busy"], b.Codes);
        Assert.Null(redis.Get($"mekik:lock:{a.Welcome["conversationId"]}")); // released after the run
        await nodeB.ReceiveAsync(b, Kit.Text("three")); // and now node B may take the turn
        Assert.Equal(["busy"], b.Codes);
    }
}

/// <summary><see cref="RedisBackplane"/> against an in-process Pub/Sub.</summary>
public class RedisBackplaneTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => Kit.D(kv);

    [Fact]
    public async Task A_published_frame_reaches_a_subscriber_in_the_engines_own_shape()
    {
        var redis = new FakeRedis();
        var bp = new RedisBackplane(redis.Multiplexer);
        var received = new List<BackplaneMessage>();
        await using var sub = await bp.SubscribeAsync("conv-1", received.Add);
        var frame = D(("type", "text"), ("seq", 3L), ("from", "bot"), ("data", D(("text", "hi 🎉"), ("n", 2.5))), ("timestamp", 1L));

        await bp.PublishAsync("conv-1", new BackplaneMessage("node-a", frame));

        var msg = Assert.Single(received);
        Assert.Equal("node-a", msg.OriginId);
        Assert.Equal(Json.Canonicalize(frame), Json.Canonicalize(msg.Frame));
        // Plain CLR values, like a locally produced frame — not JsonElement.
        Assert.Equal("text", msg.Frame["type"]);
        Assert.Equal(3L, msg.Frame["seq"]);
        Assert.Equal("hi 🎉", ((Frame)msg.Frame["data"]!)["text"]);
        Assert.Equal("mekik:bp:conv-1", redis.Published.Single().Channel);
    }

    [Fact]
    public async Task Channels_are_per_conversation_and_prefixed()
    {
        var redis = new FakeRedis();
        var bp = new RedisBackplane(redis.Multiplexer, new RedisBackplaneOptions { KeyPrefix = "app2" });
        var received = 0;
        await using var sub = await bp.SubscribeAsync("a", _ => received++);

        await bp.PublishAsync("b", new BackplaneMessage("n", D(("type", "run"))));

        Assert.Equal(0, received);
        Assert.Equal(1, redis.Subscribers("app2:bp:a"));
        Assert.Equal("app2:bp:b", redis.Published.Single().Channel);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("null")]
    [InlineData("[1,2]")]
    [InlineData("{\"OriginId\":\"node-x\"}")]
    [InlineData("{\"Frame\":{\"type\":\"text\"}}")]
    public async Task Garbage_on_the_channel_is_ignored(string payload)
    {
        var redis = new FakeRedis();
        var bp = new RedisBackplane(redis.Multiplexer);
        var received = 0;
        await using var sub = await bp.SubscribeAsync("c", _ => received++);

        redis.Inject("mekik:bp:c", payload);

        Assert.Equal(0, received);
    }

    [Fact]
    public async Task Disposing_the_subscription_unsubscribes_once()
    {
        var redis = new FakeRedis();
        var bp = new RedisBackplane(redis.Multiplexer);
        var received = 0;
        var sub = await bp.SubscribeAsync("c", _ => received++);
        var other = await bp.SubscribeAsync("c", _ => { });

        await sub.DisposeAsync();
        await sub.DisposeAsync();
        await bp.PublishAsync("c", new BackplaneMessage("n", D(("type", "run"))));

        Assert.Equal(0, received);
        Assert.Equal(1, redis.Subscribers("mekik:bp:c")); // only this handler was removed
        await other.DisposeAsync();
    }

    [Fact]
    public async Task Two_engines_over_the_backplane_share_a_conversations_frames_once_each()
    {
        var redis = new FakeRedis();
        var history = new InMemoryHistoryStore();
        var conversations = new InMemoryConversationStore();
        MekikApp Node() => new(new MekikOptions
        {
            Graph = Kit.Echo,
            Checkpointer = new InMemoryCheckpointer(),
            History = history,
            Conversations = conversations,
            Reply = s => s.GetValueOrDefault("reply") as string,
            Backplane = new RedisBackplane(redis.Multiplexer),
        });
        var (nodeA, nodeB) = (Node(), Node());
        var a = new Kit.Conn();
        await nodeA.ConnectAsync(a);
        var b = new Kit.Conn();
        await nodeB.ConnectAsync(b, new ConnectParams { Hello = new HelloInfo { UserId = (string)a.Welcome["userId"]!, ConversationId = (string)a.Welcome["conversationId"]! } });

        await nodeA.ReceiveAsync(a, Kit.Text("hi"));

        Assert.Equal(["welcome", "text", "run", "text", "run"], b.Sent.Select(f => f["type"] as string));
        Assert.Equal([1L, 2L], b.Sent.Select(f => f.GetValueOrDefault("seq")).OfType<long>());
        Assert.Equal(["welcome", "run", "text", "run"], a.Sent.Select(f => f["type"] as string)); // no self-echo
    }
}

/// <summary>Skips unless a Redis answers on localhost:6379 (or MEKIK_REDIS).</summary>
public sealed class RedisFactAttribute : FactAttribute
{
    public static readonly string Endpoint = Environment.GetEnvironmentVariable("MEKIK_REDIS") ?? "localhost:6379";

    private static readonly Lazy<bool> Reachable = new(() =>
    {
        try
        {
            var parts = Endpoint.Split(':');
            using var tcp = new TcpClient();
            return tcp.ConnectAsync(parts[0], parts.Length > 1 ? int.Parse(parts[1]) : 6379).Wait(TimeSpan.FromMilliseconds(500));
        }
        catch { return false; }
    });

    public RedisFactAttribute()
    {
        if (!Reachable.Value) Skip = $"no Redis at {Endpoint}";
    }
}

/// <summary>The same contracts against a real Redis, when one is reachable.</summary>
public class LiveRedisTests
{
    [RedisFact]
    public async Task Lock_and_backplane_work_against_a_real_redis()
    {
        await using var redis = await ConnectionMultiplexer.ConnectAsync(RedisFactAttribute.Endpoint);
        var prefix = $"mekik-test-{Guid.NewGuid():N}";
        var turnLock = new RedisTurnLock(redis, new RedisTurnLockOptions { KeyPrefix = prefix, Ttl = TimeSpan.FromSeconds(5) });

        var lease = await turnLock.AcquireAsync("c");
        Assert.NotNull(lease);
        Assert.Null(await turnLock.AcquireAsync("c"));
        await lease!.RenewAsync();
        await lease.DisposeAsync();
        await using (var again = await turnLock.AcquireAsync("c")) Assert.NotNull(again);

        var bp = new RedisBackplane(redis, new RedisBackplaneOptions { KeyPrefix = prefix });
        var got = new TaskCompletionSource<BackplaneMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var sub = await bp.SubscribeAsync("c", m => got.TrySetResult(m));
        await bp.PublishAsync("c", new BackplaneMessage("n", Kit.D(("type", "text"), ("seq", 1L))));
        var msg = await got.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1L, msg.Frame["seq"]);
    }
}
