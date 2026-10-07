using Ilmek;
using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// The engine lifecycle, end to end: a real <see cref="ConversationEngine"/> over
/// in-memory <see cref="FakeConn"/>s driving real ilmek graphs. Mirror of the
/// behavioural scenario suite in ts/packages/core/test/scenarios.test.ts —
/// handshake, inbound validation, a turn, the greeting, watermark replay, interrupts,
/// the turn lock, abort, auth and multi-tab fan-out — plus the edge cases around each.
/// Every assertion is on frames in and out of the engine.
/// </summary>
public class EngineScenariosTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    private static async Task<(MekikApp App, FakeConn Conn)> Connected(MekikApp app, HelloInfo? hello = null)
    {
        var c = new FakeConn();
        await app.ConnectAsync(c, hello is null ? null : new ConnectParams { Hello = hello });
        return (app, c);
    }

    private static HelloInfo Rejoin(FakeConn c, long? watermark = null) => new()
    {
        ConversationId = (string)c.Welcome()["conversationId"]!,
        UserId = (string)c.Welcome()["userId"]!,
        Watermark = watermark,
    };

    // ── handshake (§1) ────────────────────────────────────────────────────────

    [Fact]
    public async Task Anonymous_connect_mints_identity_and_announces_the_protocol()
    {
        var (_, c) = await Connected(Graphs.App(Graphs.Greeter));

        var w = c.Welcome();
        Assert.Equal("mekik/1", w["protocol"]);
        Assert.StartsWith("user-", (string)w["userId"]!);
        Assert.StartsWith("conv-", (string)w["conversationId"]!);
        Assert.Equal(c.Id, w["connectionId"]);
        Assert.Equal(0L, w["watermark"]);
        Assert.Empty((IEnumerable<object?>)w["pending"]!);
        Assert.Equal(["welcome"], c.Types());
    }

    [Fact]
    public async Task Two_anonymous_connects_get_distinct_identities()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app);

        Assert.NotEqual(a.Welcome()["userId"], b.Welcome()["userId"]);
        Assert.NotEqual(a.Welcome()["conversationId"], b.Welcome()["conversationId"]);
    }

    [Fact]
    public async Task An_asserted_userId_without_a_conversation_is_kept_and_gets_a_fresh_conversation()
    {
        var (_, c) = await Connected(Graphs.App(Graphs.Greeter), new HelloInfo { UserId = "ada" });

        Assert.Equal("ada", c.Welcome()["userId"]);
        Assert.StartsWith("conv-", (string)c.Welcome()["conversationId"]!);
    }

    [Fact]
    public async Task A_conversation_owned_by_another_user_is_not_adopted_and_its_transcript_does_not_replay()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, alice) = await Connected(app, new HelloInfo { UserId = "alice" });
        await app.ReceiveAsync(alice, In.Text("secret"));
        var victim = (string)alice.Welcome()["conversationId"]!;

        var (_, mallory) = await Connected(app, new HelloInfo { UserId = "mallory", ConversationId = victim, Watermark = 0 });

        var w = mallory.Welcome();
        Assert.NotEqual(victim, w["conversationId"]);
        Assert.Equal("mallory", w["userId"]);
        Assert.Equal(0L, w["watermark"]); // the substitute is fresh
        Assert.Equal(["welcome"], mallory.Types()); // nothing of alice's replays
        // ...and alice's tab sees nothing of mallory.
        Assert.DoesNotContain(alice.Sent, f => f.Type() == "welcome" && !ReferenceEquals(f, alice.Sent[0]));
    }

    [Fact]
    public async Task An_asserted_conversation_that_does_not_exist_is_replaced_and_the_watermark_resets()
    {
        var app = Graphs.App(Graphs.Greeter);

        var (_, c) = await Connected(app, new HelloInfo { UserId = "ada", ConversationId = "conv-ghost", Watermark = 99 });

        var w = c.Welcome();
        Assert.NotEqual("conv-ghost", w["conversationId"]);
        Assert.Equal(0L, w["watermark"]);
        Assert.Equal(["welcome"], c.Types());
        // The substitute is a real, owned conversation: the user can rejoin it.
        var (_, again) = await Connected(app, Rejoin(c));
        Assert.Equal(w["conversationId"], again.Welcome()["conversationId"]);
    }

    [Fact]
    public async Task An_owned_conversation_is_adopted_with_its_server_watermark()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        await app.ReceiveAsync(a, In.Text("Ada"));

        var (_, b) = await Connected(app, Rejoin(a, watermark: 4));

        Assert.Equal(a.Welcome()["conversationId"], b.Welcome()["conversationId"]);
        Assert.Equal(a.Welcome()["userId"], b.Welcome()["userId"]);
        Assert.Equal(4L, b.Welcome()["watermark"]);
        Assert.Equal(["welcome"], b.Types()); // already caught up
    }

    // ── inbound validation (§3.1) ─────────────────────────────────────────────

    public static IEnumerable<object?[]> MalformedFrames() =>
    [
        ["not json at all {"],
        ["[1,2]"],
        ["42"],
        ["\"just a string\""],
        ["null"],
        ["{\"data\":{\"text\":\"no type\"}}"],
        ["{\"type\":42}"],
        ["{\"type\":\"welcome\"}"],
        ["{\"type\":\"run\",\"data\":{\"status\":\"started\"}}"],
        ["{\"type\":\"text\"}"],
        ["{\"type\":\"text\",\"data\":{}}"],
        ["{\"type\":\"text\",\"data\":{\"text\":7}}"],
        ["{\"type\":\"text\",\"data\":\"hi\"}"],
        ["{\"type\":\"resume\"}"],
        ["{\"type\":\"resume\",\"answers\":[1]}"],
        ["{\"type\":\"resume\",\"answers\":\"yes\"}"],
        ["{\"type\":\"genui_event\",\"eventType\":\"x\"}"],
        ["{\"type\":\"genui_event\",\"streamId\":\"s\"}"],
        ["{\"type\":\"genui_event\",\"streamId\":\"s\",\"eventType\":\"x\",\"scope\":\"everywhere\"}"],
        ["{\"type\":\"genui_event\",\"streamId\":\"s\",\"eventType\":\"x\",\"scope\":1}"],
        ["{\"type\":\"client_tools\"}"],
        ["{\"type\":\"client_tools\",\"tools\":{\"name\":\"x\"}}"],
        ["{\"type\":\"client_skills\",\"skills\":\"x\"}"],
        ["{\"type\":\"client_skills\"}"],
    ];

    [Theory]
    [MemberData(nameof(MalformedFrames))]
    public async Task A_malformed_frame_draws_bad_request_and_the_connection_stays_usable(string raw)
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));

        await app.ReceiveAsync(c, raw);

        var error = Assert.Single(c.Sent, f => f.Type() == "error");
        Assert.Equal("bad_request", error.Code());
        Assert.False(string.IsNullOrEmpty(error.Data()["message"] as string));
        Assert.Empty(c.RunStatuses()); // nothing ran

        await app.ReceiveAsync(c, In.Text("still here"));
        Assert.Equal(["echo:still here"], c.BotTexts());
        Assert.Equal(["started", "finished"], c.RunStatuses());
    }

    [Fact]
    public async Task A_non_dictionary_object_is_a_bad_request()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));

        await app.ReceiveAsync(c, null);
        await app.ReceiveAsync(c, 42);
        await app.ReceiveAsync(c, new List<object?> { "text" });

        Assert.Equal(["bad_request", "bad_request", "bad_request"], c.ErrorCodes());
    }

    [Fact]
    public async Task A_frame_before_connect_draws_no_session()
    {
        var app = Graphs.App(Graphs.Echo);
        var c = new FakeConn();

        await app.ReceiveAsync(c, In.Text("hi"));
        await app.ReceiveAsync(c, In.Abort());

        Assert.Equal(["no_session", "no_session"], c.ErrorCodes());
        Assert.DoesNotContain(c.Sent, f => f.Type() == "welcome");
    }

    [Fact]
    public async Task A_malformed_frame_before_connect_is_a_bad_request_not_no_session()
    {
        var app = Graphs.App(Graphs.Echo);
        var c = new FakeConn();

        await app.ReceiveAsync(c, "{oops");

        Assert.Equal(["bad_request"], c.ErrorCodes());
    }

    [Fact]
    public async Task A_frame_after_disconnect_draws_no_session()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));
        app.Disconnect(c);

        await app.ReceiveAsync(c, In.Text("anyone?"));

        Assert.Equal(["no_session"], c.ErrorCodes());
        Assert.Empty(c.RunStatuses());
    }

    [Fact]
    public async Task A_re_hello_mid_session_is_ignored()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));
        var conversation = c.Welcome()["conversationId"];
        var before = c.Sent.Count;

        await app.ReceiveAsync(c, D(("type", "hello"), ("userId", "someone-else"), ("conversationId", "conv-other")));

        Assert.Equal(before, c.Sent.Count); // no second welcome, no error
        await app.ReceiveAsync(c, In.Text("x"));
        var history = await app.History.AfterAsync((string)conversation!, 0);
        Assert.Contains(history, f => f.Type() == "text" && f.Text() == "echo:x");
    }

    [Fact]
    public async Task A_json_string_frame_is_parsed_like_an_object_frame()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));

        await app.ReceiveAsync(c, "{\"type\":\"text\",\"data\":{\"text\":\"wire\"}}");

        Assert.Equal(["echo:wire"], c.BotTexts());
    }

    // ── a basic turn (§4, §5) ─────────────────────────────────────────────────

    [Fact]
    public async Task A_turn_streams_run_started_genui_reply_and_run_finished_without_echoing_the_sender()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Greeter));

        await app.ReceiveAsync(c, In.Text("Ada"));

        Assert.Equal(["welcome", "run", "genui", "genui", "text", "run"], c.Types());
        Assert.Equal(["started", "finished"], c.RunStatuses());
        var genui = c.Sent.Where(f => f.Type() == "genui").ToList();
        Assert.Equal("ui", ((Frame)genui[0]["chunk"]!)["type"]);
        Assert.Equal(false, genui[0]["done"]);
        Assert.Equal("stream_done", ((Frame)genui[1]["chunk"]!)["name"]);
        Assert.Equal(true, genui[1]["done"]);
        Assert.Equal(genui[0]["streamId"], genui[1]["streamId"]);
        Assert.Equal(["Hi, Ada!"], c.BotTexts());
        Assert.Empty(c.UserTexts());
    }

    [Fact]
    public async Task Persistent_seq_is_monotonic_and_gap_free_across_turns()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Greeter));
        var conversation = (string)c.Welcome()["conversationId"]!;

        await app.ReceiveAsync(c, In.Text("Ada"));
        await app.ReceiveAsync(c, In.Text("Bob"));

        var transcript = await app.History.AfterAsync(conversation, 0);
        Assert.Equal([1L, 2, 3, 4, 5, 6, 7, 8], transcript.Seqs());
        Assert.Equal(["text", "genui", "genui", "text", "text", "genui", "genui", "text"], transcript.Select(f => f.Type()));
        // The sender saw all but its own two un-echoed turns.
        Assert.Equal([2L, 3, 4, 6, 7, 8], c.Sent.Seqs());
        Assert.Equal(8L, await app.History.CurrentSeqAsync(conversation));
    }

    [Fact]
    public async Task Each_turn_opens_its_own_genui_stream()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Greeter));

        await app.ReceiveAsync(c, In.Text("Ada"));
        await app.ReceiveAsync(c, In.Text("Bob"));

        var streams = c.Sent.Where(f => f.Type() == "genui").Select(f => f["streamId"]).Distinct().ToList();
        Assert.Equal(2, streams.Count);
    }

    [Fact]
    public async Task The_user_text_is_recorded_with_the_text_envelope()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Now = () => 1_750_000_000_000 });
        var (_, c) = await Connected(app);

        await app.ReceiveAsync(c, In.Text("hello"));

        var user = (await app.History.AfterAsync((string)c.Welcome()["conversationId"]!, 0)).First();
        Assert.Equal("text", user.Type());
        Assert.Equal("user", user["from"]);
        Assert.Equal("hello", user.Text());
        Assert.Equal(1L, user.Seq());
        Assert.Equal(1_750_000_000_000L, user["timestamp"]);
        Assert.StartsWith("msg-", user.Id());
    }

    [Fact]
    public async Task Another_tab_receives_the_user_text_the_sender_does_not()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));

        await app.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal(["Ada"], b.UserTexts());
        Assert.Equal(["Hi, Ada!"], b.BotTexts());
        Assert.Empty(a.UserTexts());
        Assert.Equal(["Hi, Ada!"], a.BotTexts());
        // Both tabs saw the run's transient frames too.
        Assert.Equal(["started", "finished"], b.RunStatuses());
    }

    [Fact]
    public async Task Without_a_reply_selector_a_run_emits_no_bot_text()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Reply = null });
        var (_, c) = await Connected(app);

        await app.ReceiveAsync(c, In.Text("x"));

        Assert.Equal(["started", "finished"], c.RunStatuses());
        Assert.Empty(c.BotTexts());
        Assert.DoesNotContain(c.Sent, f => f.Type() == "genui"); // no stream was opened, so none is closed
    }

    [Fact]
    public async Task An_empty_reply_emits_no_bot_text()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Reply = _ => "" });
        var (_, c) = await Connected(app);

        await app.ReceiveAsync(c, In.Text("x"));

        Assert.Empty(c.BotTexts());
        Assert.Equal(["started", "finished"], c.RunStatuses());
    }

    [Fact]
    public async Task The_input_mapper_sees_the_whole_text_frame()
    {
        IReadOnlyDictionary<string, object?>? seen = null;
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with
        {
            Input = f => { seen = f; return D(("input", "mapped")); },
        });
        var (_, c) = await Connected(app);

        await app.ReceiveAsync(c, In.Text("raw", D(("locale", "tr"))));

        Assert.Equal(["echo:mapped"], c.BotTexts());
        Assert.NotNull(seen);
        Assert.Equal("text", seen!.Type());
        Assert.Equal("tr", ((Frame)seen["meta"]!)["locale"]);
    }

    // ── graph context (§6) ────────────────────────────────────────────────────

    [Fact]
    public async Task Client_meta_is_dropped_unless_the_app_allowlists_it()
    {
        var app = Graphs.App(Graphs.MetaProbe);
        var (_, c) = await Connected(app);

        await app.ReceiveAsync(c, In.Text("x", D(("role", "admin"))));

        Assert.Equal(["{\"keys\":[]}"], c.BotTexts());
    }

    [Fact]
    public async Task AcceptClientMeta_places_its_result_at_meta_client_and_context_at_meta_mekik()
    {
        (string, string)? conv = null;
        (string, IReadOnlyDictionary<string, object?>?)? turn = null;
        var app = new MekikApp(Graphs.Options(Graphs.MetaProbe) with
        {
            AcceptClientMeta = m => m.ContainsKey("locale") ? D(("locale", m["locale"])) : null,
            Context = (c, t) => { conv = c; turn = t; return D(("plan", "pro")); },
        });
        var (_, c) = await Connected(app, new HelloInfo { UserId = "ada" });

        await app.ReceiveAsync(c, In.Text("hi", D(("locale", "tr"), ("role", "admin"))));

        Assert.Equal(["{\"client\":{\"locale\":\"tr\"},\"keys\":[\"client\",\"mekik\"],\"mekik\":{\"plan\":\"pro\"}}"], c.BotTexts());
        Assert.Equal(("ada", "hi"), (conv!.Value.Item2, turn!.Value.Item1));
        Assert.Equal(c.Welcome()["conversationId"], conv.Value.Item1);
        Assert.Equal("admin", turn.Value.Item2!["role"]); // the raw client meta reaches Context
    }

    [Fact]
    public async Task An_allowlist_that_returns_null_adds_no_client_key()
    {
        var app = new MekikApp(Graphs.Options(Graphs.MetaProbe) with { AcceptClientMeta = _ => null });
        var (_, c) = await Connected(app);

        await app.ReceiveAsync(c, In.Text("x", D(("role", "admin"))));

        Assert.Equal(["{\"keys\":[]}"], c.BotTexts());
    }

    // ── the greeting (§1) ─────────────────────────────────────────────────────

    [Fact]
    public async Task A_string_greeting_is_one_persistent_bot_text_sent_once()
    {
        (string, string)? greetedFor = null;
        var app = new MekikApp(Graphs.Options(Graphs.Greeter) with
        {
            Greeting = conv => { greetedFor = conv; return "Hi!"; },
        });
        var (_, c) = await Connected(app);

        Assert.Equal(["welcome", "text"], c.Types());
        var greeting = c.Sent[1];
        Assert.Equal("bot", greeting["from"]);
        Assert.Equal("Hi!", greeting.Text());
        Assert.Equal(1L, greeting.Seq());
        Assert.Equal((c.Welcome()["conversationId"], c.Welcome()["userId"]), (greetedFor!.Value.Item1, greetedFor.Value.Item2));

        // A reconnect from zero replays it rather than greeting twice...
        var (_, again) = await Connected(app, Rejoin(c, watermark: 0));
        Assert.Equal(["welcome", "text"], again.Types());
        Assert.Equal(1L, again.Sent[1].Seq());
        // ...and a caught-up reconnect gets no greeting at all.
        var (_, caughtUp) = await Connected(app, Rejoin(c, watermark: 1));
        Assert.Equal(["welcome"], caughtUp.Types());
    }

    [Fact]
    public async Task A_greeting_with_rich_specs_is_sent_in_order_each_its_own_persistent_frame()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Greeter) with
        {
            Greeting = conv => new object[]
            {
                $"Hi {conv.UserId}!",
                D(("type", "card"), ("id", "hero"), ("data", D(("title", "Welcome")))),
                D(("type", "buttons"), ("data", D(("text", "What next?")))),
            },
        });
        var (_, c) = await Connected(app, new HelloInfo { UserId = "ada" });

        Assert.Equal(["welcome", "text", "card", "buttons"], c.Types());
        Assert.Equal("Hi ada!", c.Sent[1].Text());
        Assert.Equal("hero", c.Sent[2].Id());
        Assert.StartsWith("msg-", c.Sent[3].Id());
        Assert.All(c.Sent.Skip(1), f => Assert.Equal("bot", f["from"]));
        var transcript = await app.History.AfterAsync((string)c.Welcome()["conversationId"]!, 0);
        Assert.Equal([1L, 2, 3], transcript.Seqs());
        // A turn after the greeting continues the same seq space.
        await app.ReceiveAsync(c, In.Text("go"));
        Assert.Equal(5L, c.Sent.Seqs().First(s => s > 3)); // user text took seq 4
    }

    [Fact]
    public async Task An_empty_or_null_greeting_greets_nothing()
    {
        var empty = new MekikApp(Graphs.Options(Graphs.Greeter) with { Greeting = _ => "" });
        var (_, a) = await Connected(empty);
        Assert.Equal(["welcome"], a.Types());

        var none = new MekikApp(Graphs.Options(Graphs.Greeter) with { Greeting = _ => null });
        var (_, b) = await Connected(none);
        Assert.Equal(["welcome"], b.Types());

        var emptyList = new MekikApp(Graphs.Options(Graphs.Greeter) with { Greeting = _ => new object[] { "", "" } });
        var (_, c) = await Connected(emptyList);
        Assert.Equal(["welcome"], c.Types());
    }

    [Fact]
    public async Task A_reserved_or_untyped_greeting_spec_is_dropped_and_the_rest_still_greet()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Greeter) with
        {
            Greeting = _ => new object?[]
            {
                D(("type", "run"), ("data", D(("status", "started")))),
                D(("type", "interrupt"), ("data", D())),
                D(("data", D(("text", "no type")))),
                D(("type", 7L), ("data", D())),
                42,
                null,
                "still here",
            },
        });
        var (_, c) = await Connected(app);

        Assert.Equal(["welcome", "text"], c.Types());
        Assert.Equal("still here", c.Sent[1].Text());
        Assert.Equal(1L, c.Sent[1].Seq()); // dropped specs consumed no seq
    }

    [Fact]
    public async Task A_greeting_spec_typed_text_is_the_allowed_overlap()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Greeter) with
        {
            Greeting = _ => D(("type", "text"), ("data", D(("text", "rich text"), ("urls", new List<object?> { "https://x" })))),
        });
        var (_, c) = await Connected(app);

        Assert.Equal(["welcome", "text"], c.Types());
        Assert.Equal("rich text", c.Sent[1].Text());
    }

    [Fact]
    public async Task A_greeting_reaches_every_tab_already_on_the_conversation_only_once()
    {
        var calls = 0;
        var app = new MekikApp(Graphs.Options(Graphs.Greeter) with { Greeting = _ => { calls++; return "Hi!"; } });
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a, watermark: 1));

        Assert.Equal(1, calls);
        Assert.Equal(["Hi!"], a.BotTexts());
        Assert.Empty(b.BotTexts());
    }

    // ── watermark replay (§2) ─────────────────────────────────────────────────

    private static async Task<(MekikApp App, FakeConn First)> FourFrameConversation()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        await app.ReceiveAsync(a, In.Text("Ada")); // seqs 1..4: user text, ui, stream_done, reply
        return (app, a);
    }

    [Fact]
    public async Task Reconnect_with_a_watermark_replays_exactly_the_persistent_tail()
    {
        var (app, a) = await FourFrameConversation();

        var (_, b) = await Connected(app, Rejoin(a, watermark: 2));

        Assert.Equal(["welcome", "genui", "text"], b.Types());
        Assert.Equal([3L, 4], b.Sent.Seqs());
        Assert.Equal(4L, b.Welcome()["watermark"]);
    }

    [Fact]
    public async Task Watermark_zero_or_absent_replays_the_whole_transcript_including_the_user_turn()
    {
        var (app, a) = await FourFrameConversation();

        var (_, zero) = await Connected(app, Rejoin(a, watermark: 0));
        var (_, absent) = await Connected(app, Rejoin(a, watermark: null));

        Assert.Equal([1L, 2, 3, 4], zero.Sent.Seqs());
        Assert.Equal([1L, 2, 3, 4], absent.Sent.Seqs());
        Assert.Equal(["Ada"], zero.UserTexts()); // replay is complete — the user's own turn too
    }

    [Fact]
    public async Task A_watermark_equal_to_the_current_seq_replays_nothing()
    {
        var (app, a) = await FourFrameConversation();

        var (_, b) = await Connected(app, Rejoin(a, watermark: 4));

        Assert.Equal(["welcome"], b.Types());
    }

    [Fact]
    public async Task A_watermark_beyond_the_server_replays_nothing_and_welcome_carries_the_server_watermark()
    {
        var (app, a) = await FourFrameConversation();

        var (_, b) = await Connected(app, Rejoin(a, watermark: 99));

        Assert.Equal(["welcome"], b.Types());
        Assert.Equal(4L, b.Welcome()["watermark"]);
        // The next turn continues from the server's seq, not the client's.
        await app.ReceiveAsync(b, In.Text("Bob"));
        Assert.Equal([6L, 7, 8], b.Sent.Seqs());
    }

    [Fact]
    public async Task Transient_frames_are_never_recorded_or_replayed()
    {
        var app = Graphs.App(Graphs.Fragile);
        var (_, a) = await Connected(app);
        await app.ReceiveAsync(a, In.Text("ok"));
        await app.ReceiveAsync(a, In.Text("boom"));
        await app.ReceiveAsync(a, "{garbage");

        var (_, b) = await Connected(app, Rejoin(a, watermark: 0));

        var replayed = b.Sent.Skip(1).ToList();
        Assert.NotEmpty(replayed);
        Assert.All(replayed, f => Assert.True(Protocol.IsPersistent(f), f.Type()));
        Assert.DoesNotContain(b.Sent, f => f.Type() is "run" or "error");
        Assert.Single(b.Sent, f => f.Type() == "welcome");
    }

    [Fact]
    public async Task A_tab_joining_mid_run_gets_the_tail_so_far_then_live_frames_without_duplicates()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate, emitFirst: true));
        var (_, a) = await Connected(app);

        var running = app.ReceiveAsync(a, In.Text("one"));
        await gate.WaitEnteredAsync();
        await a.WaitForAsync(f => f.Type() == "genui"); // seq 2 is recorded

        var (_, b) = await Connected(app, Rejoin(a, watermark: 0));
        Assert.Equal(["welcome", "text", "genui"], b.Types()); // the tail so far: user text + chunk
        gate.Release.SetResult();
        await running;

        Assert.Equal([1L, 2, 3, 4], b.Sent.Seqs());
        Assert.Equal("finished", b.RunStatuses().Last());
    }

    /// <summary>A history store whose replay read can be held open, to land live frames inside a connect.</summary>
    private sealed class SlowReplayHistory : IHistoryStore
    {
        private readonly InMemoryHistoryStore _inner = new();
        public Gate? HoldReplay { get; set; }

        public Task RecordAsync(string conversationId, Frame frame) => _inner.RecordAsync(conversationId, frame);
        public Task<long> CurrentSeqAsync(string conversationId) => _inner.CurrentSeqAsync(conversationId);

        public async Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, long watermark)
        {
            if (HoldReplay is { } hold)
            {
                hold.Entered.TrySetResult();
                await hold.Release.Task.ConfigureAwait(false);
            }
            return await _inner.AfterAsync(conversationId, watermark).ConfigureAwait(false);
        }
    }

    [Fact]
    public async Task Live_frames_that_land_during_a_slow_replay_are_delivered_once_and_in_seq_order()
    {
        var run = new Gate();
        var history = new SlowReplayHistory();
        var app = new MekikApp(Graphs.Options(Graphs.Gated(run, emitFirst: true)) with { History = history });
        var (_, a) = await Connected(app);
        var running = app.ReceiveAsync(a, In.Text("one"));
        await run.WaitEnteredAsync();
        await a.WaitForAsync(f => f.Type() == "genui");

        // B registers, gets its welcome, then stalls reading the transcript...
        history.HoldReplay = new Gate();
        var b = new FakeConn();
        var joining = app.ConnectAsync(b, new ConnectParams { Hello = Rejoin(a, watermark: 0) });
        await history.HoldReplay.WaitEnteredAsync();
        // ...while the run finishes and its last frames are recorded and fanned out.
        run.Release.SetResult();
        await running;
        history.HoldReplay.Release.SetResult();
        await joining;

        Assert.Equal("welcome", b.Sent[0].Type()); // §2: welcome, then replay, then live
        Assert.Equal([1L, 2, 3, 4], b.Sent.Seqs()); // each persistent frame exactly once, in order
        Assert.Equal("finished", b.RunStatuses().Last());
    }

    // ── a single approval round-trip (§4.4, §5) ───────────────────────────────

    private static async Task<(MekikApp App, FakeConn Conn, string InterruptId)> Parked()
    {
        var app = Graphs.App(Graphs.Approval);
        var (_, c) = await Connected(app);
        await app.ReceiveAsync(c, In.Text("refund"));
        return (app, c, c.Sent.First(f => f.Type() == "interrupt").Id()!);
    }

    [Fact]
    public async Task Interrupt_then_a_new_turn_is_refused_then_resume_resolves_and_finishes()
    {
        var (app, c, interruptId) = await Parked();

        Assert.Equal(["started", "interrupted"], c.RunStatuses());
        var intr = c.Sent.First(f => f.Type() == "interrupt");
        Assert.Equal("approval-form", ((Frame)intr.Data()["ui"]!)["component"]);
        Assert.Equal("approve refund?", ((Frame)intr.Data()["payload"]!)["title"]);
        Assert.False(((Frame)intr.Data()["payload"]!).ContainsKey("$mekik"));

        var before = c.Sent.Count;
        await app.ReceiveAsync(c, In.Text("another"));
        var refused = Assert.Single(c.Sent.Skip(before));
        Assert.Equal("interrupted", refused.Code());

        await app.ReceiveAsync(c, In.Resume((interruptId, D(("approved", true)))));

        var resolved = c.Sent.Single(f => f.Type() == "interrupt_resolved");
        Assert.Equal(interruptId, resolved.Id());
        Assert.Equal(true, ((Frame)resolved.Data()["answer"]!)["approved"]);
        Assert.Equal(["approved"], c.BotTexts());
        Assert.Equal(["started", "interrupted", "started", "finished"], c.RunStatuses());
        // The refused turn left no trace in the transcript.
        var transcript = await app.History.AfterAsync((string)c.Welcome()["conversationId"]!, 0);
        Assert.DoesNotContain(transcript, f => f.Text() == "another");
        Assert.Equal(Enumerable.Range(1, transcript.Count).Select(i => (long)i), transcript.Seqs());
    }

    [Fact]
    public async Task Interrupt_resolved_precedes_the_resumed_runs_frames()
    {
        var (app, c, id) = await Parked();
        var before = c.Sent.Count;

        await app.ReceiveAsync(c, In.Resume((id, D(("approved", false)))));

        var after = c.Sent.Skip(before).Select(f => f.Type()).ToList();
        Assert.Equal(["interrupt_resolved", "run", "text", "run"], after);
        Assert.Equal(["rejected"], c.BotTexts());
    }

    [Fact]
    public async Task Resume_with_no_open_interrupt_is_not_interrupted()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));

        await app.ReceiveAsync(c, In.Resume(("anything", true)));

        Assert.Equal(["not_interrupted"], c.ErrorCodes());
        Assert.Empty(c.RunStatuses());
    }

    [Fact]
    public async Task Resume_naming_only_an_unknown_id_is_incomplete_and_the_pause_stands()
    {
        var (app, c, id) = await Parked();

        await app.ReceiveAsync(c, In.Resume(("no-such-interrupt", true)));

        var error = c.Sent.Last();
        Assert.Equal("incomplete_resume", error.Code());
        Assert.Contains(id, (string)error.Data()["message"]!);
        Assert.Equal(["started", "interrupted"], c.RunStatuses());
        Assert.DoesNotContain(c.Sent, f => f.Type() == "interrupt_resolved");
        // The pause is still answerable.
        await app.ReceiveAsync(c, In.Resume((id, D(("approved", true)))));
        Assert.Equal(["approved"], c.BotTexts());
    }

    [Fact]
    public async Task Resume_with_empty_answers_is_incomplete()
    {
        var (app, c, _) = await Parked();

        await app.ReceiveAsync(c, In.Resume());

        Assert.Equal(["incomplete_resume"], c.ErrorCodes());
    }

    [Fact]
    public async Task A_second_resume_of_the_same_interrupt_is_not_interrupted()
    {
        var (app, c, id) = await Parked();
        await app.ReceiveAsync(c, In.Resume((id, D(("approved", true)))));

        await app.ReceiveAsync(c, In.Resume((id, D(("approved", false)))));

        Assert.Equal(["not_interrupted"], c.ErrorCodes());
        Assert.Equal(["approved"], c.BotTexts()); // the first answer stands
        Assert.Single(c.Sent, f => f.Type() == "interrupt_resolved");
    }

    [Fact]
    public async Task After_a_resume_finishes_a_new_text_turn_runs()
    {
        var (app, c, id) = await Parked();
        await app.ReceiveAsync(c, In.Resume((id, D(("approved", true)))));

        await app.ReceiveAsync(c, In.Text("second"));

        var interrupts = c.Sent.Where(f => f.Type() == "interrupt").ToList();
        Assert.Equal(2, interrupts.Count);
        Assert.True(interrupts[1].Seq() > interrupts[0].Seq());
        Assert.Equal(["started", "interrupted", "started", "finished", "started", "interrupted"], c.RunStatuses());
        // The new pause is answerable like the first.
        await app.ReceiveAsync(c, In.Resume((interrupts[1].Id()!, D(("approved", false)))));
        Assert.Equal(["approved", "rejected"], c.BotTexts());
    }

    [Fact]
    public async Task Welcome_pending_re_announces_an_open_interrupt_with_its_ui_on_reconnect()
    {
        var (app, a, id) = await Parked();

        var (_, b) = await Connected(app, Rejoin(a, watermark: 99));

        var pending = ((IEnumerable<object?>)b.Welcome()["pending"]!).Cast<Frame>().ToList();
        var view = Assert.Single(pending);
        Assert.Equal(id, view["id"]);
        var data = (Frame)view["data"]!;
        Assert.Equal("approval-form", ((Frame)data["ui"]!)["component"]);
        Assert.Equal("approve refund?", ((Frame)data["payload"]!)["title"]);
        Assert.False(view.ContainsKey("seq")); // a view, not a frame
    }

    [Fact]
    public async Task An_interrupt_answered_from_the_other_tab_resolves_on_both_tabs()
    {
        var (app, a, id) = await Parked();
        var (_, b) = await Connected(app, Rejoin(a, watermark: 99));

        await app.ReceiveAsync(b, In.Resume((id, D(("approved", true)))));

        Assert.Equal(id, a.Sent.Single(f => f.Type() == "interrupt_resolved").Id());
        Assert.Equal(id, b.Sent.Single(f => f.Type() == "interrupt_resolved").Id());
        Assert.Equal(["approved"], a.BotTexts());
        Assert.Equal(["approved"], b.BotTexts());
        // And the pause is gone for a third tab.
        var (_, c) = await Connected(app, Rejoin(a, watermark: 99));
        Assert.Empty((IEnumerable<object?>)c.Welcome()["pending"]!);
    }

    // ── concurrent interrupts routed by id (§4.4) ─────────────────────────────

    [Fact]
    public async Task Concurrent_interrupts_get_distinct_ids_a_partial_resume_is_refused_and_a_full_one_finishes()
    {
        var app = Graphs.App(Graphs.Batch);
        var (_, c) = await Connected(app);
        await app.ReceiveAsync(c, In.Text("go"));

        var ids = c.Sent.Where(f => f.Type() == "interrupt").Select(f => f.Id()!).ToList();
        Assert.Equal(2, ids.Count);
        Assert.Equal(2, ids.Distinct().Count());
        Assert.Equal(["started", "interrupted"], c.RunStatuses());

        await app.ReceiveAsync(c, In.Resume((ids[0], true)));
        Assert.Equal("incomplete_resume", c.Sent.Last().Code());
        Assert.Contains(ids[1], (string)c.Sent.Last().Data()["message"]!);
        Assert.DoesNotContain(c.Sent, f => f.Type() == "interrupt_resolved");

        await app.ReceiveAsync(c, In.Resume((ids[0], true), (ids[1], true)));

        var resolved = c.Sent.Where(f => f.Type() == "interrupt_resolved").Select(f => f.Id()).OrderBy(x => x).ToList();
        Assert.Equal(ids.OrderBy(x => x), resolved);
        Assert.Equal("finished", c.RunStatuses().Last());
    }

    [Fact]
    public async Task Concurrent_pending_views_carry_their_action_chips()
    {
        var app = Graphs.App(Graphs.Batch);
        var (_, a) = await Connected(app);
        await app.ReceiveAsync(a, In.Text("go"));

        var (_, b) = await Connected(app, Rejoin(a, watermark: 99));

        var pending = ((IEnumerable<object?>)b.Welcome()["pending"]!).Cast<Frame>().ToList();
        Assert.Equal(2, pending.Count);
        Assert.All(pending, p =>
        {
            var action = (Frame)((IEnumerable<object?>)((Frame)p["data"]!)["actions"]!).Single()!;
            Assert.Equal("ok", action["label"]);
            Assert.Equal(true, action["value"]);
        });
        var titles = pending.Select(p => ((Frame)((Frame)p["data"]!)["payload"]!)["title"]).OrderBy(t => t).ToList();
        Assert.Equal(["charge A", "charge B"], titles);
    }

    // ── the turn lock and abort (§5) ──────────────────────────────────────────

    [Fact]
    public async Task A_second_text_while_a_run_is_in_flight_gets_busy_only_on_the_sender()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate));
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));

        var running = app.ReceiveAsync(a, In.Text("one"));
        await gate.WaitEnteredAsync();
        await app.ReceiveAsync(a, In.Text("two"));

        Assert.Equal(["busy"], a.ErrorCodes());
        Assert.Empty(b.ErrorCodes());
        gate.Release.SetResult();
        await running;
        Assert.Equal(["done:one"], a.BotTexts());
        var transcript = await app.History.AfterAsync((string)a.Welcome()["conversationId"]!, 0);
        Assert.DoesNotContain(transcript, f => f.Text() == "two"); // the refused turn was dropped
    }

    [Fact]
    public async Task A_resume_racing_an_in_flight_turn_gets_busy()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate));
        var (_, c) = await Connected(app);

        var running = app.ReceiveAsync(c, In.Text("one"));
        await gate.WaitEnteredAsync();
        await app.ReceiveAsync(c, In.Resume(("x", true)));

        Assert.Equal(["busy"], c.ErrorCodes()); // the lock is checked before the pause
        gate.Release.SetResult();
        await running;
    }

    [Fact]
    public async Task A_second_tab_cannot_start_a_turn_while_the_first_tabs_run_is_in_flight()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate));
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));

        var running = app.ReceiveAsync(a, In.Text("one"));
        await gate.WaitEnteredAsync();
        await app.ReceiveAsync(b, In.Text("two"));

        Assert.Equal(["busy"], b.ErrorCodes());
        gate.Release.SetResult();
        await running;
    }

    [Fact]
    public async Task Abort_ends_the_in_flight_run_as_aborted()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate));
        var (_, c) = await Connected(app);

        var running = app.ReceiveAsync(c, In.Text("one"));
        await gate.WaitEnteredAsync();
        await app.ReceiveAsync(c, In.Abort());
        gate.Release.SetResult(); // even ungated, the abort already stopped the run
        await running;

        Assert.Equal(["started", "aborted"], c.RunStatuses());
        Assert.Empty(c.BotTexts()); // no reply text on abort
    }

    [Fact]
    public async Task Abort_from_another_tab_stops_the_run()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate));
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));

        var running = app.ReceiveAsync(a, In.Text("one"));
        await gate.WaitEnteredAsync();
        await app.ReceiveAsync(b, In.Abort());
        gate.Release.SetResult();
        await running;

        Assert.Equal("aborted", a.RunStatuses().Last());
        Assert.Equal("aborted", b.RunStatuses().Last());
    }

    [Fact]
    public async Task Abort_when_idle_is_a_no_op()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Echo));
        var before = c.Sent.Count;

        await app.ReceiveAsync(c, In.Abort());

        Assert.Equal(before, c.Sent.Count);
        await app.ReceiveAsync(c, In.Text("x"));
        Assert.Equal(["echo:x"], c.BotTexts());
    }

    [Fact]
    public async Task After_an_abort_a_new_turn_runs()
    {
        var gate = new Gate();
        var app = Graphs.App(Graphs.Gated(gate));
        var (_, c) = await Connected(app);
        var running = app.ReceiveAsync(c, In.Text("one"));
        await gate.WaitEnteredAsync();
        await app.ReceiveAsync(c, In.Abort());
        gate.Release.SetResult();
        await running;

        await app.ReceiveAsync(c, In.Text("two")); // the gate is already open

        Assert.Equal(["started", "aborted", "started", "finished"], c.RunStatuses());
        Assert.Equal(["done:two"], c.BotTexts());
    }

    [Fact]
    public async Task A_graph_error_ends_the_run_with_a_warning_text_and_releases_the_lock()
    {
        var (app, c) = await Connected(Graphs.App(Graphs.Fragile));

        await app.ReceiveAsync(c, In.Text("boom"));

        Assert.Equal(["started", "error"], c.RunStatuses());
        var warning = Assert.Single(c.BotTexts());
        Assert.StartsWith("⚠️ ", warning);
        Assert.Contains("kaboom", warning);

        await app.ReceiveAsync(c, In.Text("fine"));
        Assert.Equal(["started", "error", "started", "finished"], c.RunStatuses());
        Assert.Equal("ok:fine", c.BotTexts().Last());
        // The warning is persistent: it is in the transcript between the two user turns.
        var transcript = await app.History.AfterAsync((string)c.Welcome()["conversationId"]!, 0);
        Assert.Equal(["boom", warning, "fine", "ok:fine"], transcript.Select(f => f.Text()));
    }

    [Fact]
    public async Task A_throwing_input_mapper_still_releases_the_lock()
    {
        var calls = 0;
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with
        {
            Input = f => ++calls == 1 ? throw new InvalidOperationException("bad input") : D(("input", "ok")),
        });
        var (_, c) = await Connected(app);

        await Assert.ThrowsAsync<InvalidOperationException>(() => app.ReceiveAsync(c, In.Text("first")));
        await app.ReceiveAsync(c, In.Text("second"));

        Assert.Equal(["echo:ok"], c.BotTexts());
        Assert.DoesNotContain("busy", c.ErrorCodes());
    }

    // ── auth (§7) ─────────────────────────────────────────────────────────────

    private static MekikApp Authed(CompiledGraph? graph = null) => new(Graphs.Options(graph ?? Graphs.Greeter) with
    {
        Authenticator = new StaticTokenAuthenticator(new Dictionary<string, (string, IReadOnlyDictionary<string, object?>?)>
        {
            ["good-token"] = ("u-42", D(("role", "admin"), ("tenant", "acme"))),
            ["bare-token"] = ("u-7", null),
        }),
    });

    [Fact]
    public async Task A_bad_token_is_rejected_with_unauthorized_and_close_4401_and_no_welcome()
    {
        var app = Authed();
        var c = new FakeConn();

        await app.ConnectAsync(c, new ConnectParams { Hello = new HelloInfo { Token = "nope" } });

        var error = Assert.Single(c.Sent);
        Assert.Equal("unauthorized", error.Code());
        Assert.Equal("invalid token", error.Data()["message"]);
        Assert.Equal(Protocol.AuthCloseCode, c.Closed?.Code);
        Assert.Equal(4401, c.Closed?.Code);
        Assert.Equal("unauthorized", c.Closed?.Reason);
        // The connection never joined a session.
        await app.ReceiveAsync(c, In.Text("hi"));
        Assert.Equal("no_session", c.Sent.Last().Code());
    }

    [Fact]
    public async Task A_missing_token_is_rejected()
    {
        var app = Authed();
        var c = new FakeConn();

        await app.ConnectAsync(c);

        Assert.Equal("unauthorized", Assert.Single(c.Sent).Code());
        Assert.Equal("no token presented", c.Sent[0].Data()["message"]);
        Assert.Equal(4401, c.Closed?.Code);
    }

    [Fact]
    public async Task A_rejection_without_a_reason_still_says_unauthorized()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Authenticator = new VerdictAuthenticator(new AuthVerdict { Ok = false }) });
        var c = new FakeConn();

        await app.ConnectAsync(c);

        Assert.Equal("unauthorized", c.Sent.Single().Data()["message"]);
    }

    [Fact]
    public async Task A_verified_userId_overrides_a_spoofed_asserted_one()
    {
        var (_, c) = await Connected(Authed(), new HelloInfo { Token = "good-token", UserId = "i-am-someone-else" });

        Assert.Equal("u-42", c.Welcome()["userId"]);
        Assert.Null(c.Closed);
    }

    [Fact]
    public async Task A_verified_user_cannot_adopt_the_conversation_its_spoofed_id_owns()
    {
        var app = Authed();
        // "victim" owns a conversation (asserted with no token check would be possible
        // on another app; here we create it through the store directly).
        await app.Conversations.CreateAsync(new ConversationRecord("conv-victim", "victim", 0, new Dictionary<string, object?>()));

        var (_, c) = await Connected(app, new HelloInfo { Token = "good-token", UserId = "victim", ConversationId = "conv-victim" });

        Assert.Equal("u-42", c.Welcome()["userId"]);
        Assert.NotEqual("conv-victim", c.Welcome()["conversationId"]);
    }

    [Fact]
    public async Task An_authenticated_user_rejoins_their_own_conversation()
    {
        var app = Authed();
        var (_, a) = await Connected(app, new HelloInfo { Token = "good-token" });
        await app.ReceiveAsync(a, In.Text("Ada"));

        var (_, b) = await Connected(app, new HelloInfo
        {
            Token = "good-token",
            ConversationId = (string)a.Welcome()["conversationId"]!,
            Watermark = 0,
        });

        Assert.Equal(a.Welcome()["conversationId"], b.Welcome()["conversationId"]);
        Assert.Equal([1L, 2, 3, 4], b.Sent.Seqs());
    }

    [Fact]
    public async Task Verified_claims_land_in_meta_auth()
    {
        var app = Authed(Graphs.MetaProbe);
        var (_, c) = await Connected(app, new HelloInfo { Token = "good-token" });

        await app.ReceiveAsync(c, In.Text("who am i"));

        Assert.Equal(["{\"auth\":{\"role\":\"admin\",\"tenant\":\"acme\"},\"keys\":[\"auth\"]}"], c.BotTexts());
    }

    [Fact]
    public async Task A_verdict_without_claims_adds_no_auth_key()
    {
        var app = Authed(Graphs.MetaProbe);
        var (_, c) = await Connected(app, new HelloInfo { Token = "bare-token" });

        await app.ReceiveAsync(c, In.Text("x"));

        Assert.Equal("u-7", c.Welcome()["userId"]);
        Assert.Equal(["{\"keys\":[]}"], c.BotTexts());
    }

    [Fact]
    public async Task Claims_also_reach_a_resumed_run()
    {
        var probeAfterPause = Graph.Create("probe-after-pause")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("n", async (State _, IContext ctx) =>
            {
                await Shuttle.Approve<object?>(ctx, D(("title", "ok?")));
                return Update.Of("reply", Json.Canonicalize(Shuttle.AuthClaims(ctx)));
            })
            .Edge(Graph.Start, "n")
            .Edge("n", Graph.End)
            .Compile();
        var app = Authed(probeAfterPause);
        var (_, c) = await Connected(app, new HelloInfo { Token = "good-token" });
        await app.ReceiveAsync(c, In.Text("x"));

        await app.ReceiveAsync(c, In.Resume((c.Sent.First(f => f.Type() == "interrupt").Id()!, true)));

        Assert.Equal(["{\"role\":\"admin\",\"tenant\":\"acme\"}"], c.BotTexts());
    }

    [Fact]
    public async Task The_transport_credential_is_preferred_over_the_hello_token()
    {
        var app = Authed();
        var good = new FakeConn();
        await app.ConnectAsync(good, new ConnectParams
        {
            Hello = new HelloInfo { Token = "nope" },
            Credential = new Credential { Token = "good-token" },
        });
        Assert.Equal("u-42", good.Welcome()["userId"]);

        var bad = new FakeConn();
        await app.ConnectAsync(bad, new ConnectParams
        {
            Hello = new HelloInfo { Token = "good-token" },
            Credential = new Credential { Token = "nope" },
        });
        Assert.Equal("unauthorized", bad.Sent.Single().Code());
    }

    private sealed class VerdictAuthenticator(AuthVerdict verdict) : IAuthenticator
    {
        public List<Credential> Seen { get; } = new();
        public ValueTask<AuthVerdict> AuthenticateAsync(Credential credential)
        {
            Seen.Add(credential);
            return ValueTask.FromResult(verdict);
        }
    }

    [Fact]
    public async Task A_custom_authenticator_sees_the_full_credential_and_the_hello_token_by_default()
    {
        var auth = new VerdictAuthenticator(new AuthVerdict { Ok = true, UserId = "u-1" });
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Authenticator = auth });

        await app.ConnectAsync(new FakeConn(), new ConnectParams { Hello = new HelloInfo { Token = "t-hello" } });
        await app.ConnectAsync(new FakeConn(), new ConnectParams
        {
            Credential = new Credential
            {
                Headers = new Dictionary<string, string?> { ["Authorization"] = "Bearer x" },
                Query = new Dictionary<string, string?> { ["k"] = "v" },
            },
        });

        Assert.Equal("t-hello", auth.Seen[0].Token);
        Assert.Equal("Bearer x", auth.Seen[1].Headers!["Authorization"]);
        Assert.Equal("v", auth.Seen[1].Query!["k"]);
    }

    [Fact]
    public async Task An_authenticator_that_verifies_no_userId_falls_back_to_the_asserted_one()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with
        {
            Authenticator = new VerdictAuthenticator(new AuthVerdict { Ok = true }),
        });

        var (_, c) = await Connected(app, new HelloInfo { UserId = "ada" });

        Assert.Equal("ada", c.Welcome()["userId"]);
    }

    // ── multi-tab fan-out (§1) ────────────────────────────────────────────────

    [Fact]
    public async Task Two_tabs_receive_the_same_bot_frames_with_the_same_seqs()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));

        await app.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal([2L, 3, 4], a.Sent.Seqs());
        Assert.Equal([1L, 2, 3, 4], b.Sent.Seqs());
    }

    [Fact]
    public async Task A_disconnected_tab_stops_receiving_while_the_other_keeps_receiving_and_seq_continues()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));
        await app.ReceiveAsync(a, In.Text("one"));
        var bBefore = b.Sent.Count;

        app.Disconnect(b);
        await app.ReceiveAsync(a, In.Text("two"));

        Assert.Equal(bBefore, b.Sent.Count);
        Assert.Equal([2L, 3, 4, 6, 7, 8], a.Sent.Seqs());
    }

    [Fact]
    public async Task A_tab_that_reconnects_replays_what_it_missed_while_away()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app, Rejoin(a));
        await app.ReceiveAsync(a, In.Text("one"));
        var bWatermark = b.Sent.Seqs().Max();
        app.Disconnect(b);
        await app.ReceiveAsync(a, In.Text("two"));

        var (_, back) = await Connected(app, Rejoin(a, watermark: bWatermark));

        Assert.Equal([5L, 6, 7, 8], back.Sent.Seqs());
        Assert.Equal(["two"], back.UserTexts());
    }

    [Fact]
    public async Task The_last_tab_leaving_keeps_the_seq_counter()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        await app.ReceiveAsync(a, In.Text("one"));
        app.Disconnect(a);

        var (_, back) = await Connected(app, Rejoin(a, watermark: 4));
        await app.ReceiveAsync(back, In.Text("two"));

        Assert.Equal(4L, back.Welcome()["watermark"]);
        Assert.Equal([6L, 7, 8], back.Sent.Seqs());
    }

    [Fact]
    public async Task Disconnecting_a_connection_that_never_connected_is_harmless()
    {
        var app = Graphs.App(Graphs.Echo);
        var stranger = new FakeConn();

        app.Disconnect(stranger);
        app.Disconnect(stranger);

        var (_, c) = await Connected(app);
        await app.ReceiveAsync(c, In.Text("x"));
        Assert.Equal(["echo:x"], c.BotTexts());
    }

    [Fact]
    public async Task Conversations_are_isolated_from_each_other()
    {
        var app = Graphs.App(Graphs.Greeter);
        var (_, a) = await Connected(app);
        var (_, b) = await Connected(app);

        await app.ReceiveAsync(a, In.Text("Ada"));

        Assert.Equal(["welcome"], b.Types());
        await app.ReceiveAsync(b, In.Text("Bob"));
        Assert.Equal([2L, 3, 4], b.Sent.Seqs()); // b's own seq space starts at 1
    }
}
