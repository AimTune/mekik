using Ilmek;

namespace Mekik.Converger.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// <see cref="ConvergerTransport"/> against a fake hub: the handshake, the virtual-connection
/// mapping, what is and is not answered, reconnects, eviction and the limits. Mirror of
/// <c>ts/packages/converger/test/converger.test.ts</c>.
/// </summary>
public class ConvergerTransportTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    /// <summary>Replies with what it saw: the text, the user, the verified claims and the client meta.</summary>
    private static readonly CompiledGraph Echo = Graph.Create("echo")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("n", (State s, IContext ctx) => Update.Of("reply", Json.Canonicalize(D(
            ("text", s.Get<string>("input")),
            ("user", (ctx.Meta.GetValueOrDefault("mekik") as Frame)?.GetValueOrDefault("userId")),
            ("auth", ctx.Meta.GetValueOrDefault("auth")),
            ("client", ctx.Meta.GetValueOrDefault("client"))))))
        .Edge(Graph.Start, "n")
        .Edge("n", Graph.End)
        .Compile();

    private sealed class Gate
    {
        private TaskCompletionSource _current = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task Wait() { lock (this) return _current.Task; }
        public void Release()
        {
            lock (this)
            {
                _current.TrySetResult();
                _current = new(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }
    }

    private static CompiledGraph Gated(Gate gate) => Graph.Create("gated")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("n", async (State s, IContext _) =>
        {
            await gate.Wait();
            return Update.Of("reply", $"done: {s.Get<string>("input")}");
        })
        .Edge(Graph.Start, "n")
        .Edge("n", Graph.End)
        .Compile();

    private static MekikOptions Options(CompiledGraph graph) => new MekikOptions
    {
        Graph = graph,
        Reply = s => s.GetValueOrDefault("reply") as string,
        Context = (conv, _) => D(("userId", conv.UserId)),
    }.WithExternalTranscript();

    private static ConvergerOptions Opts(FakeHub hub) => new()
    {
        Url = hub.Url,
        Token = "tok-1",
        ReconnectMin = TimeSpan.FromMilliseconds(10),
        ReconnectMax = TimeSpan.FromMilliseconds(40),
    };

    private static List<Frame> Replies(FakeHub hub, string conv) =>
        hub.FramesOf(conv).Where(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot").ToList();

    private static Frame ReplyJson(Frame reply) => (Frame)Json.Parse((string)((Frame)reply["data"]!)["text"]!)!;

    private static List<string?> RunStatuses(FakeHub hub, string conv) =>
        hub.FramesOf(conv).Where(f => f["type"] as string == "run").Select(f => ((Frame)f["data"]!)["status"] as string).ToList();

    // ── handshake ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task One_bare_hello_with_the_bearer_token_then_ready_on_the_channel_welcome()
    {
        await using var hub = await FakeHub.StartAsync();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub) with { Group = "faq" });
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(t.Connected);
        var (hello, bearer) = Assert.Single(hub.Hellos);
        Assert.Equal("""{"group":"faq","protocol":"converger/1","type":"hello"}""", Json.Canonicalize(hello));
        Assert.Equal("tok-1", bearer);
    }

    [Fact]
    public void An_app_without_the_external_transcript_profile_is_refused_up_front()
    {
        Assert.Throws<ArgumentException>(() => ConvergerTransport.Connect(new MekikApp(new MekikOptions { Graph = Echo }), new ConvergerOptions { Url = "ws://127.0.0.1:1", Token = "x" }));
        Assert.Throws<ArgumentException>(() => ConvergerTransport.Connect(new MekikApp(Options(Echo)), new ConvergerOptions { Url = "ws://127.0.0.1:1" }));
    }

    [Fact]
    public async Task A_fixed_token_refused_with_4401_stops_the_transport_instead_of_retrying()
    {
        await using var hub = await FakeHub.StartAsync();
        hub.RefuseWith = 4401;
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub));
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => t.Ready.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Contains("4401", ex.Message);
        await Task.Delay(100);
        Assert.Equal(1, hub.HelloCount);
    }

    [Fact]
    public async Task A_token_provider_is_asked_on_connect()
    {
        await using var hub = await FakeHub.StartAsync();
        var calls = 0;
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub) with
        {
            Token = null,
            TokenProvider = _ => Task.FromResult($"minted-{Interlocked.Increment(ref calls)}"),
        });
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("minted-1", hub.Hellos[0].Bearer);
    }

    // ── virtual connections ───────────────────────────────────────────────────

    [Fact]
    public async Task Each_conversation_gets_its_own_virtual_connection_and_frames_go_back_in_its_envelope()
    {
        await using var hub = await FakeHub.StartAsync();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub));
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "one");
        await hub.UserTurnAsync("conv-b", "two", D(("sender", D(("id", "bob"), ("role", "user")))));
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1 && Replies(hub, "conv-b").Count == 1, "both replies");

        Assert.Equal(2, t.Conversations);
        Assert.Equal("""{"auth":{"role":"user","userId":"alice"},"client":null,"text":"one","user":"alice"}""", Json.Canonicalize(ReplyJson(Replies(hub, "conv-a")[0])));
        Assert.Equal("""{"auth":{"role":"user","userId":"bob"},"client":null,"text":"two","user":"bob"}""", Json.Canonicalize(ReplyJson(Replies(hub, "conv-b")[0])));
        Assert.Equal(["run", "text", "run"], hub.FramesOf("conv-a").Select(f => f["type"] as string).ToList());
        Assert.DoesNotContain(hub.FramesOf("conv-a").Concat(hub.FramesOf("conv-b")),
            f => f["type"] as string == "welcome" || f.GetValueOrDefault("from") as string == "user");
    }

    [Fact]
    public async Task The_bots_own_frames_receipts_and_typing_are_not_turns_and_a_replayed_seq_is_not_run_twice()
    {
        await using var hub = await FakeHub.StartAsync();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub));
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.ForwardAsync("conv-a", D(("type", "text"), ("id", "x"), ("seq", 1L), ("from", "bot"), ("data", D(("text", "agent says"))), ("timestamp", 1L)));
        await hub.ForwardAsync("conv-a", D(("type", "tool_call"), ("seq", 2L), ("data", D(("id", "t"), ("name", "n"), ("status", "running")))));
        await hub.ForwardAsync("conv-a", D(("type", "typing"), ("isTyping", true), ("from", "user")));
        await hub.ForwardAsync("conv-a", D(("type", "event"), ("id", "e"), ("seq", 3L), ("from", "user"), ("data", D(("name", "reaction"), ("text", "alice reacted"))), ("timestamp", 1L)));
        await hub.ForwardAsync("conv-a", D(("type", "deliveryStatus"), ("data", D(("seq", 1L), ("status", "read")))));
        var turn = D(("type", "text"), ("id", "u"), ("seq", 4L), ("from", "user"), ("sender", D(("id", "alice"))), ("data", D(("text", "hi"))), ("timestamp", 1L));
        await hub.ForwardAsync("conv-a", turn);
        await hub.ForwardAsync("conv-a", turn); // the same seq again (a replay overlapping live delivery)

        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1, "one reply");
        await Task.Delay(50);
        var reply = Assert.Single(Replies(hub, "conv-a"));
        Assert.Equal("hi", ReplyJson(reply)["text"]);
    }

    [Fact]
    public async Task A_rich_user_message_with_text_is_a_turn_and_the_meta_allowlist_picks_from_metadata_and_meta()
    {
        await using var hub = await FakeHub.StartAsync();
        var app = new MekikApp(Options(Echo) with { AcceptClientMeta = m => m });
        await using var t = ConvergerTransport.Connect(app, Opts(hub) with { Meta = ["channel", "locale"] });
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "Track", D(
            ("type", "buttons"),
            ("metadata", D(("channel", "whatsapp"), ("secret", "no"))),
            ("meta", D(("locale", "tr-TR"), ("channel", "wa-main")))));
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1, "the reply");

        var seen = ReplyJson(Replies(hub, "conv-a")[0]);
        Assert.Equal("Track", seen["text"]);
        Assert.Equal("""{"auth":{"role":"user","userId":"alice"},"channel":"wa-main","locale":"tr-TR"}""", Json.Canonicalize(seen["client"]));
    }

    [Fact]
    public async Task Forwarded_frames_reach_the_engine_unchanged_and_abort_stops_a_running_turn()
    {
        await using var hub = await FakeHub.StartAsync();
        var gate = new Gate();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Gated(gate))), Opts(hub));
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "slow");
        await FakeHub.WaitForAsync(() => RunStatuses(hub, "conv-a").Count == 1, "run started");
        await hub.ForwardAsync("conv-a", D(("type", "abort")));
        // The abort must not queue behind the running turn: it lands while the node is
        // still parked on the gate, so the run ends aborted once the node returns.
        await Task.Delay(50);
        gate.Release();
        await FakeHub.WaitForAsync(() => RunStatuses(hub, "conv-a").Contains("aborted"), "run aborted");
        Assert.Empty(Replies(hub, "conv-a"));
    }

    [Fact]
    public async Task The_greeting_goes_to_a_fresh_conversation_never_to_one_first_seen_through_a_forwarded_frame()
    {
        await using var hub = await FakeHub.StartAsync();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo) with { Greeting = _ => "Hello!" }), Opts(hub));
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-new", "hi");
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-new").Count == 2, "greeting and reply");
        Assert.Equal("Hello!", ((Frame)Replies(hub, "conv-new")[0]["data"]!)["text"]);

        await hub.ForwardAsync("conv-old", D(("type", "resume"), ("answers", D(("x#0", true)))));
        await FakeHub.WaitForAsync(() => hub.FramesOf("conv-old").Any(f => f["type"] as string == "error"), "not_interrupted");
        Assert.Empty(Replies(hub, "conv-old"));
    }

    [Fact]
    public async Task An_idle_conversation_is_disconnected_after_IdleTimeout_and_reconnected_by_its_next_turn()
    {
        await using var hub = await FakeHub.StartAsync();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub) with { IdleTimeout = TimeSpan.FromMilliseconds(30) });
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "one");
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1, "first reply");
        await FakeHub.WaitForAsync(() => t.Conversations == 0, "eviction");
        await hub.UserTurnAsync("conv-a", "two");
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 2, "second reply");
        Assert.Equal("two", ReplyJson(Replies(hub, "conv-a")[1])["text"]);
    }

    [Fact]
    public async Task MaxConcurrentTurns_queues_turns_across_conversations()
    {
        await using var hub = await FakeHub.StartAsync();
        var gate = new Gate();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Gated(gate))), Opts(hub) with { MaxConcurrentTurns = 1 });
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "a");
        await FakeHub.WaitForAsync(() => RunStatuses(hub, "conv-a").Count == 1, "a started");
        await hub.UserTurnAsync("conv-b", "b");
        await Task.Delay(50);
        Assert.Empty(hub.FramesOf("conv-b"));
        gate.Release();
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1, "a done");
        await FakeHub.WaitForAsync(() => RunStatuses(hub, "conv-b").Count == 1, "b started");
        gate.Release();
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-b").Count == 1, "b done");
    }

    // ── reconnect ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Re_hello_carries_each_watermark_and_persistent_frames_made_while_down_are_flushed()
    {
        await using var hub = await FakeHub.StartAsync();
        var gate = new Gate();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Gated(gate))), Opts(hub));
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "first");
        await FakeHub.WaitForAsync(() => RunStatuses(hub, "conv-a").Count == 1, "run started");
        hub.Drop();
        await FakeHub.WaitForAsync(() => !t.Connected, "the drop noticed");
        gate.Release(); // the reply and run{finished} are produced while the socket is down
        await FakeHub.WaitForAsync(() => hub.HelloCount == 2, "the re-hello");
        Assert.Equal("""{"protocol":"converger/1","type":"hello","watermarks":{"conv-a":1}}""", Json.Canonicalize(hub.Hellos[1].Frame));

        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1, "the buffered reply");
        Assert.Equal("done: first", ((Frame)Replies(hub, "conv-a")[0]["data"]!)["text"]);
        Assert.Equal(["started"], RunStatuses(hub, "conv-a")); // run{finished} was live-only
    }

    [Fact]
    public async Task An_ack_moves_the_conversations_watermark()
    {
        await using var hub = await FakeHub.StartAsync();
        await using var t = ConvergerTransport.Connect(new MekikApp(Options(Echo)), Opts(hub));
        await t.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        await hub.UserTurnAsync("conv-a", "one"); // seq 1; the reply is stored (and acked) as seq 2
        await FakeHub.WaitForAsync(() => Replies(hub, "conv-a").Count == 1, "the reply");
        await Task.Delay(50);
        hub.Drop();
        await FakeHub.WaitForAsync(() => hub.HelloCount == 2, "the re-hello");
        Assert.Equal("""{"conv-a":2}""", Json.Canonicalize(hub.Hellos[1].Frame["watermarks"]));
    }
}
