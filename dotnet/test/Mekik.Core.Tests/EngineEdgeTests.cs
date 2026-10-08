using Ilmek;
using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// Engine edges that the happy-path scenarios do not reach: <c>hello.meta</c> as client
/// context (§6), a tab that sends and closes at once, a turn lease that fails to
/// release, and the horizontal-scale ports (docs/SCALING.md) — a refusing
/// <see cref="ITurnLock"/> and a backplane carrying frames between two engines.
/// Parity with the TypeScript engine edge suite.
/// </summary>
public class EngineEdgeTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    private static HelloInfo Rejoin(FakeConn c, long? watermark = null) => new()
    {
        ConversationId = (string)c.Welcome()["conversationId"]!,
        UserId = (string)c.Welcome()["userId"]!,
        Watermark = watermark,
    };

    private static async Task<FakeConn> Connect(MekikApp app, HelloInfo? hello = null)
    {
        var c = new FakeConn();
        await app.ConnectAsync(c, hello is null ? null : new ConnectParams { Hello = hello });
        return c;
    }

    // ── hello.meta is client context (§6) ─────────────────────────────────────

    private static MekikApp ClientMetaApp(CompiledGraph graph) => new(Graphs.Options(graph) with
    {
        AcceptClientMeta = m => m.Where(kv => kv.Key is "locale" or "page").ToDictionary(kv => kv.Key, kv => kv.Value),
    });

    [Fact]
    public async Task Hello_meta_reaches_meta_client_through_the_allowlist()
    {
        var app = ClientMetaApp(Graphs.MetaProbe);
        var c = await Connect(app, new HelloInfo { Meta = D(("locale", "tr"), ("role", "admin")) });

        await app.ReceiveAsync(c, In.Text("x"));

        Assert.Equal(["{\"client\":{\"locale\":\"tr\"},\"keys\":[\"client\"]}"], c.BotTexts());
    }

    [Fact]
    public async Task Frame_meta_is_laid_over_hello_meta_per_key()
    {
        var app = ClientMetaApp(Graphs.MetaProbe);
        var c = await Connect(app, new HelloInfo { Meta = D(("locale", "tr"), ("page", "/home")) });

        await app.ReceiveAsync(c, In.Text("x", D(("page", "/checkout"))));

        Assert.Equal(["{\"client\":{\"locale\":\"tr\",\"page\":\"/checkout\"},\"keys\":[\"client\"]}"], c.BotTexts());
    }

    [Fact]
    public async Task Hello_meta_is_dropped_without_an_allowlist()
    {
        var app = Graphs.App(Graphs.MetaProbe);
        var c = await Connect(app, new HelloInfo { Meta = D(("locale", "tr")) });

        await app.ReceiveAsync(c, In.Text("x"));

        Assert.Equal(["{\"keys\":[]}"], c.BotTexts());
    }

    [Fact]
    public async Task Hello_meta_is_per_connection_and_never_leaks_to_another_tab()
    {
        var app = ClientMetaApp(Graphs.MetaProbe);
        var a = await Connect(app, new HelloInfo { Meta = D(("locale", "tr")) });
        var b = await Connect(app, Rejoin(a) with { Meta = null });

        await app.ReceiveAsync(b, In.Text("from b"));

        Assert.Equal(["{\"keys\":[]}"], b.BotTexts());
    }

    [Fact]
    public async Task A_resumed_run_sees_hello_meta_alone()
    {
        var pauseThenProbe = Graph.Create("pause-probe")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("n", async (State _, IContext ctx) =>
            {
                await Shuttle.Approve<object?>(ctx, D(("title", "ok?")));
                return Update.Of("reply", Json.Canonicalize(ctx.Meta.GetValueOrDefault("client")));
            })
            .Edge(Graph.Start, "n")
            .Edge("n", Graph.End)
            .Compile();
        var app = ClientMetaApp(pauseThenProbe);
        var c = await Connect(app, new HelloInfo { Meta = D(("locale", "tr")) });
        await app.ReceiveAsync(c, In.Text("x", D(("page", "/turn-only"))));

        await app.ReceiveAsync(c, In.Resume((c.Sent.First(f => f.Type() == "interrupt").Id()!, true)));

        Assert.Equal(["{\"locale\":\"tr\"}"], c.BotTexts());
    }

    // ── a tab that sends and leaves at once ───────────────────────────────────

    /// <summary>A turn lock whose acquisition the test holds open.</summary>
    private sealed class HeldLock : ITurnLock
    {
        public Gate? Hold { get; set; }
        public ITurnLease? Next { get; set; }

        public async Task<ITurnLease?> AcquireAsync(string conversationId, CancellationToken cancellationToken = default)
        {
            if (Hold is { } hold)
            {
                hold.Entered.TrySetResult();
                await hold.Release.Task.ConfigureAwait(false);
            }
            return Next ?? new NoopLease();
        }
    }

    private sealed class NoopLease : ITurnLease
    {
        public Task RenewAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    [Fact]
    public async Task A_turn_sent_by_a_tab_that_disconnects_while_the_lease_is_pending_still_runs_for_the_conversation()
    {
        var turnLock = new HeldLock { Hold = new Gate() };
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { TurnLock = turnLock });
        var a = await Connect(app);
        var b = await Connect(app, Rejoin(a));

        var sending = app.ReceiveAsync(a, In.Text("bye"));
        await turnLock.Hold.WaitEnteredAsync();
        app.Disconnect(a);
        turnLock.Hold.Release.SetResult();
        await sending;

        Assert.Equal(["bye"], b.UserTexts());
        Assert.Equal(["echo:bye"], b.BotTexts());
        Assert.Equal(["started", "finished"], b.RunStatuses());
    }

    // ── a lease that fails to release ─────────────────────────────────────────

    private sealed class ThrowingLease : ITurnLease
    {
        public Task RenewAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public ValueTask DisposeAsync() => throw new InvalidOperationException("redis blip");
    }

    [Fact]
    public async Task A_lease_that_fails_to_release_does_not_wedge_the_conversation()
    {
        var turnLock = new HeldLock { Next = new ThrowingLease() };
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { TurnLock = turnLock });
        var c = await Connect(app);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => app.ReceiveAsync(c, In.Text("one")));
        Assert.Equal("redis blip", ex.Message);
        turnLock.Next = null;

        await app.ReceiveAsync(c, In.Text("two"));

        Assert.DoesNotContain("busy", c.ErrorCodes());
        Assert.Equal(["echo:one", "echo:two"], c.BotTexts());
    }

    // ── the distributed turn lock (docs/SCALING.md) ───────────────────────────

    private sealed class CountingLock(bool grant) : ITurnLock
    {
        public int Acquired;
        public int Released;

        public Task<ITurnLease?> AcquireAsync(string conversationId, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref Acquired);
            return Task.FromResult<ITurnLease?>(grant ? new Lease(this) : null);
        }

        private sealed class Lease(CountingLock owner) : ITurnLease
        {
            public Task RenewAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
            public ValueTask DisposeAsync()
            {
                Interlocked.Increment(ref owner.Released);
                return ValueTask.CompletedTask;
            }
        }
    }

    [Fact]
    public async Task A_turn_lock_that_refuses_answers_busy_and_runs_nothing()
    {
        var turnLock = new CountingLock(grant: false);
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { TurnLock = turnLock });
        var c = await Connect(app);

        await app.ReceiveAsync(c, In.Text("one"));
        await app.ReceiveAsync(c, In.Text("two")); // the local lock was released after the refusal

        Assert.Equal(["busy", "busy"], c.ErrorCodes());
        Assert.Empty(c.RunStatuses());
        Assert.Empty(await app.History.AfterAsync((string)c.Welcome()["conversationId"]!, 0));
    }

    [Fact]
    public async Task Every_turn_kind_takes_and_releases_one_lease()
    {
        var turnLock = new CountingLock(grant: true);
        var app = new MekikApp(Graphs.Options(Graphs.Approval) with { TurnLock = turnLock });
        var c = await Connect(app);

        await app.ReceiveAsync(c, In.Text("refund"));
        await app.ReceiveAsync(c, In.Text("refused, but it took the lease to find out"));
        await app.ReceiveAsync(c, In.Resume((c.Sent.First(f => f.Type() == "interrupt").Id()!, D(("approved", true)))));

        Assert.Equal(3, turnLock.Acquired);
        Assert.Equal(3, turnLock.Released);
        Assert.Equal(["approved"], c.BotTexts());
    }

    // ── the backplane (docs/SCALING.md) ───────────────────────────────────────

    /// <summary>An in-process pub/sub shared by several engines — the Redis backplane's shape without Redis.</summary>
    private sealed class InProcessBackplane : IBackplane
    {
        private readonly object _gate = new();
        private readonly Dictionary<string, List<Action<BackplaneMessage>>> _subs = new();
        public List<BackplaneMessage> Published { get; } = new();

        public Task PublishAsync(string conversationId, BackplaneMessage message, CancellationToken cancellationToken = default)
        {
            List<Action<BackplaneMessage>> handlers;
            lock (_gate)
            {
                Published.Add(message);
                handlers = _subs.GetValueOrDefault(conversationId)?.ToList() ?? [];
            }
            foreach (var h in handlers) h(message); // pub/sub delivers to the publisher too
            return Task.CompletedTask;
        }

        public Task<IAsyncDisposable> SubscribeAsync(string conversationId, Action<BackplaneMessage> handler, CancellationToken cancellationToken = default)
        {
            lock (_gate)
            {
                if (!_subs.TryGetValue(conversationId, out var list)) _subs[conversationId] = list = new();
                list.Add(handler);
            }
            return Task.FromResult<IAsyncDisposable>(new Unsub(this, conversationId, handler));
        }

        public int Subscribers(string conversationId)
        {
            lock (_gate) return _subs.GetValueOrDefault(conversationId)?.Count ?? 0;
        }

        private sealed class Unsub(InProcessBackplane bp, string conv, Action<BackplaneMessage> h) : IAsyncDisposable
        {
            public ValueTask DisposeAsync()
            {
                lock (bp._gate) bp._subs[conv].Remove(h);
                return ValueTask.CompletedTask;
            }
        }
    }

    /// <summary>Two nodes sharing the durable ports, the checkpointer and a backplane.</summary>
    private static (MekikApp NodeA, MekikApp NodeB, InProcessBackplane Bus) TwoNodes(CompiledGraph graph)
    {
        var bus = new InProcessBackplane();
        var history = new InMemoryHistoryStore();
        var conversations = new InMemoryConversationStore();
        var checkpointer = new InMemoryCheckpointer();
        MekikApp Node() => new(Graphs.Options(graph) with
        {
            Backplane = bus,
            History = history,
            Conversations = conversations,
            Checkpointer = checkpointer,
        });
        return (Node(), Node(), bus);
    }

    [Fact]
    public async Task Frames_produced_on_one_node_reach_a_tab_on_another_node()
    {
        var (nodeA, nodeB, bus) = TwoNodes(Graphs.Greeter);
        var a = await Connect(nodeA);
        var b = await Connect(nodeB, Rejoin(a));

        await nodeA.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal(["Ada"], b.UserTexts()); // the other tab still sees the user's turn
        Assert.Equal(["Hi, Ada!"], b.BotTexts());
        Assert.Equal(["started", "finished"], b.RunStatuses());
        Assert.Equal([1L, 2, 3, 4], b.Sent.Seqs());
        Assert.Equal(2, bus.Subscribers((string)a.Welcome()["conversationId"]!)); // one per node, not per tab
    }

    [Fact]
    public async Task A_backplane_message_without_a_frame_is_dropped_never_fanned_out()
    {
        var (nodeA, _, bus) = TwoNodes(Graphs.Greeter);
        var a = await Connect(nodeA);
        var before = a.Sent.Count;

        // A custom IBackplane may hand over anything; a null frame must not reach a socket.
        await bus.PublishAsync((string)a.Welcome()["conversationId"]!, new BackplaneMessage("other-node", null!));
        await bus.PublishAsync((string)a.Welcome()["conversationId"]!, null!);

        Assert.Equal(before, a.Sent.Count);
    }

    [Fact]
    public async Task A_node_skips_its_own_frames_echoed_back_by_the_backplane()
    {
        var (nodeA, _, bus) = TwoNodes(Graphs.Greeter);
        var a = await Connect(nodeA);

        await nodeA.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal([2L, 3, 4], a.Sent.Seqs()); // each frame once, despite pub/sub self-delivery
        Assert.Equal(2, a.RunStatuses().Count);
        Assert.Single(bus.Published.Select(m => m.OriginId).Distinct());
    }

    [Fact]
    public async Task The_backplane_carries_every_dispatched_frame_but_persists_only_once()
    {
        var (nodeA, nodeB, bus) = TwoNodes(Graphs.Greeter);
        var a = await Connect(nodeA);
        _ = await Connect(nodeB, Rejoin(a));

        await nodeA.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal(["text", "run", "genui", "genui", "text", "run"], bus.Published.Select(m => m.Frame.Type()));
        var transcript = await nodeA.History.AfterAsync((string)a.Welcome()["conversationId"]!, 0);
        Assert.Equal([1L, 2, 3, 4], transcript.Seqs()); // the receiving node did not re-record
    }

    [Fact]
    public async Task A_greeting_on_one_node_reaches_a_tab_already_waiting_on_another()
    {
        var bus = new InProcessBackplane();
        var conversations = new InMemoryConversationStore();
        var history = new InMemoryHistoryStore();
        await conversations.CreateAsync(new ConversationRecord("conv-shared", "ada", 0, new Dictionary<string, object?>()));
        var quiet = new MekikApp(Graphs.Options(Graphs.Echo) with { Backplane = bus, History = history, Conversations = conversations });
        var greeter = new MekikApp(Graphs.Options(Graphs.Echo) with
        {
            Backplane = bus, History = history, Conversations = conversations, Greeting = _ => "Hi!",
        });

        var waiting = await Connect(quiet, new HelloInfo { UserId = "ada", ConversationId = "conv-shared" });
        _ = await Connect(greeter, new HelloInfo { UserId = "ada", ConversationId = "conv-shared" });

        Assert.Equal(["Hi!"], waiting.BotTexts());
    }

    [Fact]
    public async Task Frames_for_another_conversation_on_the_bus_reach_no_one_here()
    {
        var (nodeA, nodeB, _) = TwoNodes(Graphs.Greeter);
        var a = await Connect(nodeA);
        var stranger = await Connect(nodeB); // a different conversation

        await nodeA.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal(["welcome"], stranger.Types());
    }

    // ── a stream that throws instead of ending ────────────────────────────────

    /// <summary>Loops on itself forever — ilmek stops it with its recursion limit.</summary>
    private static readonly CompiledGraph Spinner = Graph.Create("spinner")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("spin", (State s, IContext _) => Update.Of("reply", "never"))
        .Edge(Graph.Start, "spin")
        .Edge("spin", "spin")
        .Compile();

    [Fact]
    public async Task A_run_whose_stream_throws_still_ends_on_run_error_for_every_tab()
    {
        var app = new MekikApp(Graphs.Options(Spinner) with { RecursionLimit = 3 });
        var a = await Connect(app);
        var b = await Connect(app, Rejoin(a));

        await app.ReceiveAsync(a, In.Text("go"));

        Assert.Equal(["started", "error"], a.RunStatuses());
        Assert.Equal(["started", "error"], b.RunStatuses());
        var warning = Assert.Single(a.BotTexts());
        Assert.StartsWith("⚠️ ", warning);
        Assert.Contains("ecursion", warning);
        var transcript = await app.History.AfterAsync((string)a.Welcome()["conversationId"]!, 0);
        Assert.Equal(["go", warning], transcript.Select(f => f.Text()));
        Assert.Equal([1L, 2], transcript.Seqs());

        await app.ReceiveAsync(a, In.Text("again")); // the lock was released
        Assert.DoesNotContain("busy", a.ErrorCodes());
        Assert.Equal(["started", "error", "started", "error"], a.RunStatuses());
    }

    [Fact]
    public async Task Over_MCP_a_throwing_stream_is_an_isError_result_not_an_rpc_error()
    {
        var mcp = new MekikMcpServer(new MekikApp(Graphs.Options(Spinner) with { RecursionLimit = 3 }),
            new McpServerOptions { Name = "spinner", Description = "Spins." });

        var reply = await mcp.HandleAsync(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "tools/call"),
            ("params", D(("name", "spinner"), ("arguments", D(("message", "go")))))));

        Assert.False(reply!.ContainsKey("error"));
        var result = (Frame)reply["result"]!;
        Assert.Equal(true, result["isError"]);
        Assert.Equal("error", ((Frame)result["structuredContent"]!)["status"]);
    }
}
