using System.Text.Json;
using Ilmek;
using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>Inbound parsing and frame classification (PROTOCOL.md §2, §3).</summary>
public class ProtocolTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    [Theory]
    [InlineData("{\"type\":\"hello\"}")]
    [InlineData("{\"type\":\"abort\"}")]
    [InlineData("{\"type\":\"text\",\"data\":{\"text\":\"\"}}")]
    [InlineData("{\"type\":\"resume\",\"answers\":{}}")]
    [InlineData("{\"type\":\"genui_event\",\"streamId\":\"s\",\"eventType\":\"e\",\"scope\":\"component\"}")]
    [InlineData("{\"type\":\"genui_event\",\"streamId\":\"s\",\"eventType\":\"e\",\"scope\":\"graph\"}")]
    [InlineData("{\"type\":\"genui_event\",\"streamId\":\"s\",\"eventType\":\"e\",\"scope\":null}")]
    [InlineData("{\"type\":\"client_tools\",\"tools\":[]}")]
    [InlineData("{\"type\":\"client_skills\",\"skills\":[]}")]
    public void Every_well_formed_client_frame_parses(string json)
    {
        var frame = Protocol.ParseIncoming(json);

        Assert.Equal(((Frame)Json.Parse(json)!)["type"], frame["type"]);
    }

    [Theory]
    [InlineData("{", "frame is not valid JSON")]
    [InlineData("[]", "frame must be a JSON object")]
    [InlineData("{\"type\":\"typing\"}", "unknown or missing frame type typing")]
    [InlineData("{}", "unknown or missing frame type ")]
    [InlineData("{\"type\":\"text\",\"data\":{}}", "text frame requires data.text: string")]
    [InlineData("{\"type\":\"resume\",\"answers\":null}", "resume frame requires answers: object")]
    [InlineData("{\"type\":\"genui_event\",\"streamId\":1,\"eventType\":\"e\"}", "genui_event requires streamId and eventType strings")]
    [InlineData("{\"type\":\"genui_event\",\"streamId\":\"s\",\"eventType\":\"e\",\"scope\":\"both\"}", "genui_event scope must be \"component\" or \"graph\"")]
    [InlineData("{\"type\":\"client_tools\",\"tools\":null}", "client_tools frame requires tools: array")]
    [InlineData("{\"type\":\"client_skills\",\"skills\":{}}", "client_skills frame requires skills: array")]
    public void Malformed_frames_throw_bad_request_with_a_reason(string json, string message)
    {
        var ex = Assert.Throws<ProtocolException>(() => Protocol.ParseIncoming(json));

        Assert.Equal("bad_request", ex.Code);
        Assert.Equal(message, ex.Message);
    }

    [Fact]
    public void An_already_parsed_dictionary_is_validated_the_same_way()
    {
        Assert.Same("text", Protocol.ParseIncoming(D(("type", "text"), ("data", D(("text", "hi")))))["type"]);
        Assert.Throws<ProtocolException>(() => Protocol.ParseIncoming(D(("type", "text"))));
        Assert.Throws<ProtocolException>(() => Protocol.ParseIncoming(null));
        Assert.Throws<ProtocolException>(() => Protocol.ParseIncoming(3.5));
    }

    [Fact]
    public void Server_to_client_types_are_not_accepted_inbound()
    {
        foreach (var type in new[] { "welcome", "run", "error", "interrupt", "interrupt_resolved", "genui", "tool_call", "skill", "skills", "genui_components" })
            Assert.Throws<ProtocolException>(() => Protocol.ParseIncoming(D(("type", type))));
    }

    [Theory]
    [InlineData("text", true)]
    [InlineData("tool_call", true)]
    [InlineData("skill", true)]
    [InlineData("genui", true)]
    [InlineData("interrupt", true)]
    [InlineData("interrupt_resolved", true)]
    [InlineData("welcome", false)]
    [InlineData("run", false)]
    [InlineData("error", false)]
    [InlineData("genui_components", false)]
    [InlineData("skills", false)]
    public void The_closed_persistent_list(string type, bool persistent)
    {
        Assert.Equal(persistent, Protocol.IsPersistent(D(("type", type))));
    }

    [Fact]
    public void A_rich_message_frame_is_persistent_only_with_the_text_envelope()
    {
        Assert.True(Protocol.IsPersistent(D(("type", "card"), ("id", "m-1"), ("seq", 3L))));
        Assert.True(Protocol.IsMessageFrame(D(("type", "card"), ("id", "m-1"), ("seq", 3))));
        Assert.True(Protocol.IsMessageFrame(D(("type", "card"), ("id", "m-1"), ("seq", 3.0))));
        Assert.False(Protocol.IsMessageFrame(D(("type", "card"), ("seq", 3L)))); // no id
        Assert.False(Protocol.IsMessageFrame(D(("type", "card"), ("id", "m-1")))); // no seq
        Assert.False(Protocol.IsMessageFrame(D(("type", "card"), ("id", "m-1"), ("seq", "3"))));
        Assert.False(Protocol.IsMessageFrame(D(("type", "run"), ("id", "m-1"), ("seq", 3L)))); // reserved
        Assert.False(Protocol.IsPersistent(D(("type", 5L))));
        Assert.False(Protocol.IsPersistent(D()));
    }

    [Fact]
    public void The_reserved_set_covers_both_directions_and_typing()
    {
        foreach (var t in new[] { "hello", "abort", "client_tools", "client_skills", "genui_event", "welcome", "run", "error", "typing", "skills", "genui_components" })
            Assert.Contains(t, Protocol.ReservedFrameTypes);
        Assert.DoesNotContain("card", Protocol.ReservedFrameTypes);
        Assert.Equal("mekik/1", Protocol.Version);
        Assert.Equal(4401, Protocol.AuthCloseCode);
        Assert.Equal("client_tool", Protocol.ClientToolEvent);
    }
}

/// <summary>Canonical JSON (PROTOCOL.md §9) — the byte-for-byte parity layer.</summary>
public class JsonTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    [Fact]
    public void Keys_are_sorted_and_whitespace_is_dropped()
    {
        Assert.Equal("{\"a\":1,\"b\":[true,false,null],\"c\":{\"x\":\"y\"}}",
            Json.Canonicalize(D(("c", D(("x", "y"))), ("a", 1), ("b", new List<object?> { true, false, null }))));
    }

    [Fact]
    public void Keys_sort_by_utf16_code_unit_not_culture()
    {
        Assert.Equal("{\"B\":1,\"a\":2,\"İ\":4,\"ı\":3}", Json.Canonicalize(D(("a", 2), ("ı", 3), ("B", 1), ("İ", 4))));
    }

    [Fact]
    public void Integer_like_keys_come_first_in_numeric_order_as_in_javascript()
    {
        // JSON.stringify({b:1, 10:2, 9:3, "01":4}) === '{"9":3,"10":2,"01":4,"b":1}'
        Assert.Equal("{\"9\":3,\"10\":2,\"01\":4,\"b\":1}", Json.Canonicalize(D(("b", 1), ("10", 2), ("9", 3), ("01", 4))));
        // 2^32-1 is not an array index; it sorts as a string.
        Assert.Equal("{\"0\":1,\"4294967295\":2,\"a\":3}", Json.Canonicalize(D(("a", 3), ("4294967295", 2), ("0", 1))));
    }

    [Fact]
    public void Null_values_are_written_not_dropped()
    {
        Assert.Equal("{\"a\":null,\"b\":1}", Json.Canonicalize(D(("b", 1), ("a", null))));
        Assert.Equal("null", Json.Canonicalize(null));
    }

    [Theory]
    [InlineData("\"", "\"\\\"\"")]
    [InlineData("\\", "\"\\\\\"")]
    [InlineData("\b\f\n\r\t", "\"\\b\\f\\n\\r\\t\"")]
    [InlineData("\u0001\u001f", "\"\\u0001\\u001f\"")]
    [InlineData("\u007f", "\"\u007f\"")]
    [InlineData("<a href='x'>&</a>", "\"<a href='x'>&</a>\"")]
    [InlineData("₺ İ 返金", "\"₺ İ 返金\"")]
    [InlineData("🎉", "\"🎉\"")]
    [InlineData("\u2028\u2029", "\"\u2028\u2029\"")]
    public void Strings_are_escaped_exactly_as_JSON_stringify_escapes_them(string input, string expected)
    {
        Assert.Equal(expected, Json.Canonicalize(input));
    }

    [Fact]
    public void Lone_surrogates_are_escaped_and_well_formed_pairs_are_not()
    {
        // Built in code: a lone surrogate does not survive an attribute argument.
        Assert.Equal(@"""a\ud800b""", Json.Canonicalize("a" + (char)0xD800 + "b"));
        Assert.Equal(@"""\udc00""", Json.Canonicalize(((char)0xDC00).ToString()));
        Assert.Equal(@"""\udc00\ud800""", Json.Canonicalize(new string([(char)0xDC00, (char)0xD800])));
    }

    [Theory]
    [InlineData(0.1, "0.1")]
    [InlineData(2.5, "2.5")]
    [InlineData(-7.0, "-7")]
    [InlineData(-0.0, "0")]
    [InlineData(100.0, "100")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(1.5e21, "1.5e+21")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(1.25e-7, "1.25e-7")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(123456.789, "123456.789")]
    [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
    [InlineData(5e-324, "5e-324")]
    [InlineData(-1e-10, "-1e-10")]
    [InlineData(double.NaN, "null")]
    [InlineData(double.PositiveInfinity, "null")]
    [InlineData(double.NegativeInfinity, "null")]
    public void Doubles_use_the_javascript_number_layout(double value, string expected)
    {
        Assert.Equal(expected, Json.Canonicalize(value));
    }

    [Fact]
    public void Integers_print_without_a_fraction()
    {
        Assert.Equal("[7,-3,9007199254740991]", Json.Canonicalize(new List<object?> { 7, -3, 9007199254740991L }));
    }

    [Fact]
    public void A_JsonElement_folds_into_the_plain_shape()
    {
        using var doc = JsonDocument.Parse("{\"z\":[1,2.5,\"x\",true,null],\"a\":{}}");

        Assert.Equal("{\"a\":{},\"z\":[1,2.5,\"x\",true,null]}", Json.Canonicalize(doc.RootElement.Clone()));
    }

    [Fact]
    public void Unsupported_values_throw_a_clear_error()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Json.Canonicalize(D(("price", 9.99m))));
        Assert.Contains("Decimal", ex.Message);
        Assert.Throws<InvalidOperationException>(() => Json.Canonicalize(new object()));
    }

    [Fact]
    public void Parse_produces_dictionaries_lists_longs_doubles_and_primitives()
    {
        var parsed = (Frame)Json.Parse("{\"i\":7,\"d\":2.5,\"big\":1e21,\"s\":\"x\",\"t\":true,\"f\":false,\"n\":null,\"l\":[1,{}]}")!;

        Assert.IsType<long>(parsed["i"]);
        Assert.IsType<double>(parsed["d"]);
        Assert.Equal(1e21, parsed["big"]);
        Assert.Equal("x", parsed["s"]);
        Assert.Equal(true, parsed["t"]);
        Assert.Equal(false, parsed["f"]);
        Assert.True(parsed.ContainsKey("n"));
        Assert.Null(parsed["n"]);
        var list = Assert.IsType<List<object?>>(parsed["l"]);
        Assert.IsType<Dictionary<string, object?>>(list[1]);
    }

    [Fact]
    public void Parse_then_canonicalize_round_trips_canonical_input()
    {
        const string canonical = "{\"a\":[1,2.5,-0.001,\"é🎉\\n\"],\"b\":{\"c\":null}}";

        Assert.Equal(canonical, Json.Canonicalize(Json.Parse(canonical)));
    }

    [Fact]
    public void Parse_rejects_invalid_json()
    {
        Assert.ThrowsAny<JsonException>(() => Json.Parse("{\"a\":"));
    }

    [Fact]
    public void Serialize_is_the_canonical_form()
    {
        var frame = D(("type", "text"), ("seq", 1L));

        Assert.Equal(Json.Canonicalize(frame), Json.Serialize(frame));
    }
}

/// <summary>The ilmek-event → frame mapper (PROTOCOL.md §4), unit by unit.</summary>
public class MapperTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    private sealed class CountingMinter : IIdMinter
    {
        private int _m, _s;
        public string Message() => $"msg-{++_m}";
        public string Stream() => $"stream-{++_s}";
    }

    private static TurnMapper Mapper(Func<IReadOnlyDictionary<string, object?>, string?>? reply = null)
    {
        long seq = 0;
        return new TurnMapper(new TurnMapperDeps { AllocSeq = () => ++seq, Mint = new CountingMinter(), Now = () => 42, Reply = reply });
    }

    private static CustomEvent Genui(IReadOnlyDictionary<string, object?> chunk) => new() { Payload = D(("$mekik", "genui"), ("chunk", chunk)) };
    private static CustomEvent Text(string content, object? id = null) =>
        Genui(id is null ? D(("type", "text"), ("content", content)) : D(("type", "text"), ("content", content), ("id", id)));
    private static CustomEvent Ui(string component, object? id = null) =>
        Genui(id is null ? D(("type", "ui"), ("component", component)) : D(("type", "ui"), ("component", component), ("id", id)));

    private static object? ChunkId(IReadOnlyDictionary<string, object?> frame) => ((Frame)frame["chunk"]!).GetValueOrDefault("id");

    [Fact]
    public void Consecutive_text_chunks_share_one_id_until_a_ui_chunk_closes_the_run()
    {
        var m = Mapper();
        var ids = new[] { Text("a"), Text("b"), Ui("card"), Text("c"), Text("d") }
            .Select(e => ChunkId(m.Map(e).Single()))
            .ToList();

        Assert.Equal([1L, 1L, 2L, 3L, 3L], ids);
    }

    [Fact]
    public void An_event_chunk_also_closes_the_text_run()
    {
        var m = Mapper();
        var ids = new[] { Text("a"), Genui(D(("type", "event"), ("name", "ping"))), Text("b") }
            .Select(e => ChunkId(m.Map(e).Single()))
            .ToList();

        Assert.Equal([1L, 2L, 3L], ids);
    }

    [Fact]
    public void An_explicit_id_is_kept_and_opts_out_of_coalescing()
    {
        var m = Mapper();
        var ids = new[] { Text("a"), Text("b", "mine"), Text("c"), Ui("card", 99L), Ui("card") }
            .Select(e => ChunkId(m.Map(e).Single()))
            .ToList();

        // "mine" closed the run, so "c" opens a new one; an explicit ui id does not consume the counter.
        Assert.Equal([1L, "mine", 2L, 99L, 3L], ids);
    }

    [Fact]
    public void A_mapped_chunk_is_a_copy_the_authors_dictionary_is_untouched()
    {
        var chunk = D(("type", "text"), ("content", "a"));
        var m = Mapper();

        m.Map(Genui(chunk));

        Assert.False(chunk.ContainsKey("id"));
    }

    [Fact]
    public void Tokens_in_either_shape_become_text_chunks_in_one_run()
    {
        var m = Mapper();
        var a = m.Map(new CustomEvent { Payload = new TokenChunk("Hel") }).Single();
        var b = m.Map(new CustomEvent { Payload = D(("type", "token"), ("text", "lo")) }).Single();

        Assert.Equal("Hel", ((Frame)a["chunk"]!)["content"]);
        Assert.Equal("lo", ((Frame)b["chunk"]!)["content"]);
        Assert.Equal(ChunkId(a), ChunkId(b));
        Assert.Equal("stream-1", a["streamId"]);
    }

    [Fact]
    public void A_token_shaped_dictionary_without_string_text_is_dropped()
    {
        Assert.Empty(Mapper().Map(new CustomEvent { Payload = D(("type", "token"), ("text", 5L)) }));
    }

    [Theory]
    [MemberData(nameof(DroppedPayloads))]
    public void Unrecognised_custom_payloads_map_to_nothing(object? payload)
    {
        Assert.Empty(Mapper().Map(new CustomEvent { Payload = payload }));
    }

    public static IEnumerable<object?[]> DroppedPayloads() =>
    [
        [null],
        ["a plain string"],
        [D(("anything", 1L))],
        [D(("$mekik", "genui"))],                                          // no chunk
        [D(("$mekik", "tool"), ("call", "not a dict"))],
        [D(("$mekik", "skill"), ("use", D(("status", "loaded"))))],        // no name
        [D(("$mekik", "message"), ("messageType", "card"))],               // no data
        [D(("$mekik", "message"), ("messageType", "run"), ("data", D()))], // reserved
        [D(("$mekik", "unknown"))],
    ];

    [Fact]
    public void A_message_custom_mints_a_bot_frame_with_the_text_envelope()
    {
        var frame = Mapper().Map(new CustomEvent { Payload = D(("$mekik", "message"), ("messageType", "image"), ("data", D(("src", "x")))) }).Single();

        Assert.Equal("image", frame["type"]);
        Assert.Equal("msg-1", frame["id"]);
        Assert.Equal(1L, frame["seq"]);
        Assert.Equal("bot", frame["from"]);
        Assert.Equal(42L, frame["timestamp"]);
    }

    [Fact]
    public void Node_and_state_events_are_not_surfaced()
    {
        var m = Mapper();

        Assert.Empty(m.Map(new NodeStartEvent { Node = "n", TaskId = "t" }));
    }

    [Fact]
    public void Run_end_aborted_is_a_bare_run_aborted()
    {
        var frames = Mapper(_ => "never").Map(new RunEndEvent { Status = RunStatus.Aborted });

        Assert.Equal("aborted", ((Frame)Assert.Single(frames)["data"]!)["status"]);
    }

    [Fact]
    public void Run_end_error_without_details_says_the_run_failed()
    {
        var frames = Mapper().Map(new RunEndEvent { Status = RunStatus.Error });

        Assert.Equal("⚠️ the run failed", ((Frame)frames[0]["data"]!)["text"]);
        Assert.Equal("error", ((Frame)frames[1]["data"]!)["status"]);
    }

    [Fact]
    public void Run_end_error_lists_every_failing_node()
    {
        var frames = Mapper().Map(new RunEndEvent
        {
            Status = RunStatus.Error,
            Errors = [("a", new InvalidOperationException("x")), ("b", new ArgumentException("y"))],
        });

        Assert.Equal("⚠️ a: x; b: y", ((Frame)frames[0]["data"]!)["text"]);
    }

    [Fact]
    public void Run_end_done_without_a_stream_or_reply_is_just_finished()
    {
        var frames = Mapper(_ => null).Map(new RunEndEvent { Status = RunStatus.Done });

        Assert.Equal("finished", ((Frame)Assert.Single(frames)["data"]!)["status"]);
    }

    [Fact]
    public void The_reply_selector_sees_an_empty_state_when_ilmek_gives_none()
    {
        IReadOnlyDictionary<string, object?>? seen = null;
        Mapper(s => { seen = s; return null; }).Map(new RunEndEvent { Status = RunStatus.Done, FinalState = null });

        Assert.NotNull(seen);
        Assert.Empty(seen!);
    }

    [Fact]
    public void Stream_done_takes_the_next_chunk_id_and_closes_the_stream()
    {
        var m = Mapper(_ => "bye");
        m.Map(Text("a"));
        m.Map(Text("b"));

        var end = m.Map(new RunEndEvent { Status = RunStatus.Done, FinalState = D() });

        Assert.Equal(["genui", "text", "run"], end.Select(f => f["type"]));
        Assert.Equal(true, end[0]["done"]);
        Assert.Equal(2L, ChunkId(end[0]));
    }

    [Fact]
    public void Interrupt_data_unwraps_the_reserved_envelope_and_keeps_only_a_well_formed_tool()
    {
        var p = new Pending("i-1", "t", "n", "k", D(("title", "x"), ("$mekik", D(
            ("ui", D(("component", "f"))),
            ("actions", new List<object?> { D(("label", "ok")) }),
            ("event", "rate"),
            ("tool", D(("name", "pick_date"))),
            ("junk", "dropped")))));

        var data = TurnMapper.InterruptFrameData(p);

        Assert.Equal("{\"actions\":[{\"label\":\"ok\"}],\"event\":\"rate\",\"payload\":{\"title\":\"x\"},\"tool\":{\"name\":\"pick_date\"},\"ui\":{\"component\":\"f\"}}",
            Json.Canonicalize(data));
        Assert.Equal("rate", TurnMapper.AwaitedEvent(p));
    }

    [Fact]
    public void A_nameless_tool_and_a_non_string_event_are_not_surfaced()
    {
        var p = new Pending("i-1", "t", "n", "k", D(("$mekik", D(("tool", D(("params", D()))), ("event", 5L)))));

        Assert.Equal("{\"payload\":{}}", Json.Canonicalize(TurnMapper.InterruptFrameData(p)));
        Assert.Null(TurnMapper.AwaitedEvent(p));
    }

    [Fact]
    public void A_plain_payload_is_wrapped_as_is()
    {
        Assert.Equal("{\"payload\":\"approve?\"}", Json.Canonicalize(TurnMapper.InterruptFrameData(new Pending("i", "t", "n", "k", "approve?"))));
        Assert.Equal("{\"payload\":{\"$mekik\":\"not a bag\"}}",
            Json.Canonicalize(TurnMapper.InterruptFrameData(new Pending("i", "t", "n", "k", D(("$mekik", "not a bag"))))));
        Assert.Null(TurnMapper.AwaitedEvent(new Pending("i", "t", "n", "k", null)));
    }

    [Fact]
    public void EventToFrames_drives_a_whole_list_through_one_mapper()
    {
        long seq = 10;
        var frames = Mekik.Mapper.EventToFrames(
            [new RunStartEvent(), Text("a"), new RunEndEvent { Status = RunStatus.Done, FinalState = D() }],
            new TurnMapperDeps { AllocSeq = () => ++seq, Mint = new CountingMinter(), Now = () => 0 });

        Assert.Equal(["run", "genui", "genui", "run"], frames.Select(f => f["type"]));
        Assert.Equal([11L, 12L], frames.Select(f => f.GetValueOrDefault("seq")).OfType<long>());
    }
}

/// <summary>The in-memory ports and their defaults (PROTOCOL.md §2, docs/SCALING.md).</summary>
public class StoresTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    [Fact]
    public async Task History_ranges_by_seq_per_conversation()
    {
        var h = new InMemoryHistoryStore();
        for (var i = 1; i <= 3; i++) await h.RecordAsync("a", D(("type", "text"), ("seq", (long)i)));
        await h.RecordAsync("b", D(("type", "genui"), ("seq", 1)));

        Assert.Equal([2L, 3], (await h.AfterAsync("a", 1)).Seqs());
        Assert.Empty(await h.AfterAsync("a", 3));
        Assert.Equal(3L, await h.CurrentSeqAsync("a"));
        Assert.Equal(1L, await h.CurrentSeqAsync("b")); // an int seq reads as long
        Assert.Equal(0L, await h.CurrentSeqAsync("nobody"));
        Assert.Empty(await h.AfterAsync("nobody", 0));
    }

    [Fact]
    public async Task History_refuses_a_transient_frame_and_accepts_a_rich_message()
    {
        var h = new InMemoryHistoryStore();

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => h.RecordAsync("a", D(("type", "run"))));
        Assert.Contains("run", ex.Message);
        await h.RecordAsync("a", D(("type", "card"), ("id", "m"), ("seq", 1L)));
        Assert.Single(await h.AfterAsync("a", 0));
    }

    [Fact]
    public async Task Conversations_create_and_get_and_a_create_replaces()
    {
        var c = new InMemoryConversationStore();
        Assert.Null(await c.GetAsync("x"));

        await c.CreateAsync(new ConversationRecord("x", "u1", 1, D()));
        await c.CreateAsync(new ConversationRecord("x", "u2", 2, D()));

        Assert.Equal("u2", (await c.GetAsync("x"))!.UserId);
    }

    [Fact]
    public async Task The_single_node_defaults_always_grant_and_never_deliver()
    {
        await using (var lease = await new LocalTurnLock().AcquireAsync("c"))
        {
            Assert.NotNull(lease);
            await lease!.RenewAsync();
        }
        var delivered = 0;
        var bp = new NoopBackplane();
        await using var sub = await bp.SubscribeAsync("c", _ => delivered++);
        await bp.PublishAsync("c", new BackplaneMessage("n", D(("type", "text"))));

        Assert.Equal(0, delivered);
    }

    [Fact]
    public async Task StaticTokenAuthenticator_maps_tokens_to_identities()
    {
        var auth = new StaticTokenAuthenticator(new Dictionary<string, (string, IReadOnlyDictionary<string, object?>?)>
        {
            ["t"] = ("u", D(("r", "x"))),
        });

        var ok = await auth.AuthenticateAsync(new Credential { Token = "t" });
        Assert.True(ok.Ok);
        Assert.Equal("u", ok.UserId);
        Assert.Equal("x", ok.Claims!["r"]);
        Assert.Equal("invalid token", (await auth.AuthenticateAsync(new Credential { Token = "T" })).Reason);
        Assert.Equal("no token presented", (await auth.AuthenticateAsync(new Credential())).Reason);
    }

    [Fact]
    public void RandomMinter_mints_prefixed_unique_ids()
    {
        var m = new RandomMinter();
        var ids = Enumerable.Range(0, 50).Select(_ => m.Message()).ToHashSet();

        Assert.Equal(50, ids.Count);
        Assert.All(ids, id => Assert.Matches("^msg-[0-9a-f]{12}$", id));
        Assert.Matches("^stream-[0-9a-f]{12}$", m.Stream());
    }

    [Fact]
    public void MekikApp_exposes_its_ports_and_falls_back_to_in_memory_defaults()
    {
        var history = new InMemoryHistoryStore();
        var app = new MekikApp(new MekikOptions { Graph = Graphs.Echo, History = history, RecursionLimit = 5 });

        Assert.Same(history, app.History);
        Assert.IsType<InMemoryConversationStore>(app.Conversations);
        Assert.IsType<InMemoryCheckpointer>(app.Adapter.Checkpointer);
        Assert.Same(Graphs.Echo, app.Adapter.Graph);
    }

    [Fact]
    public async Task The_default_input_maps_text_to_the_input_channel_and_now_is_wall_clock()
    {
        var app = new MekikApp(new MekikOptions { Graph = Graphs.Echo, Reply = s => s.GetValueOrDefault("reply") as string });
        var c = new FakeConn();
        await app.ConnectAsync(c);
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        await app.ReceiveAsync(c, In.Text("hi"));

        var reply = c.Sent.Single(f => f.Type() == "text");
        Assert.Equal("echo:hi", reply.Text());
        Assert.InRange((long)reply["timestamp"]!, before, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }
}

/// <summary>Author-facing helpers (PROTOCOL.md §6) at the edges.</summary>
public class ShuttleEdgeTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    [Fact]
    public void Text_Ui_and_Event_omit_absent_optional_fields()
    {
        var ctx = new RecordingCtx();

        Shuttle.Text(ctx, "hi");
        Shuttle.Ui(ctx, "card");
        Shuttle.Event(ctx, "ping");
        Shuttle.Event(ctx, "pong", D(("n", 1L)), 7L);

        Assert.Equal(
            ["{\"content\":\"hi\",\"type\":\"text\"}", "{\"component\":\"card\",\"type\":\"ui\"}", "{\"name\":\"ping\",\"type\":\"event\"}",
             "{\"id\":7,\"name\":\"pong\",\"payload\":{\"n\":1},\"type\":\"event\"}"],
            ctx.Chunks.Select(c => Json.Canonicalize(c)));
    }

    [Fact]
    public void Mount_mints_replay_stable_ids_from_the_task_and_call_order()
    {
        var first = new RecordingCtx(taskId: "node:1");
        var replay = new RecordingCtx(taskId: "node:1");

        var a = Shuttle.Mount(first, "card");
        var b = Shuttle.Mount(first, "card");
        var a2 = Shuttle.Mount(replay, "card");

        Assert.Equal("node:1:ui:0", a.Id);
        Assert.Equal("node:1:ui:1", b.Id);
        Assert.Equal(a.Id, a2.Id);
        Assert.Equal("task:ui:0", Shuttle.Mount(new RecordingCtx(taskId: ""), "card").Id);
    }

    [Fact]
    public async Task Tool_surfaces_error_and_rethrows_and_running_completed_on_success()
    {
        var ctx = new RecordingCtx();

        var ok = await Shuttle.Tool(ctx, "lookup", D(("q", "x")), (Func<long>)(() => 42L));
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await Shuttle.Tool<long>(ctx, "charge", D(), (Func<long>)(() => throw new InvalidOperationException("declined"))));

        Assert.Equal(42L, ok);
        var calls = ctx.Emitted.Cast<Frame>().Select(e => (Frame)e["call"]!).ToList();
        Assert.Equal(["running", "completed", "running", "error"], calls.Select(c => c["status"]));
        Assert.Equal("declined", calls[3]["error"]);
        Assert.Equal(["task:tool:0", "task:tool:0", "task:tool:1", "task:tool:1"], calls.Select(c => c["id"]));
        Assert.Equal("task:tool:2", Shuttle.NextToolCallId(ctx));
    }

    [Fact]
    public void OnEvent_requires_an_event_name_and_wraps_payload_and_ui()
    {
        var ctx = new RecordingCtx();

        Assert.Throws<ArgumentException>(() => Shuttle.OnEvent<object?>(ctx, ""));
        _ = Shuttle.OnEvent<object?>(ctx, "rate", D(("orderId", "o-1")), D(("component", "stars")));

        var (payload, key) = Assert.Single(ctx.Interrupts);
        Assert.Equal("event:rate", key);
        Assert.Equal("{\"$mekik\":{\"event\":\"rate\",\"ui\":{\"component\":\"stars\"}},\"orderId\":\"o-1\"}", Json.Canonicalize(payload));
    }

    [Fact]
    public void Approve_without_ui_or_actions_interrupts_with_the_bare_payload()
    {
        var ctx = new RecordingCtx();

        _ = Shuttle.Approve<object?>(ctx, D(("title", "ok?")), key: "k");

        Assert.Equal("{\"title\":\"ok?\"}", Json.Canonicalize(ctx.Interrupts[0].Payload));
        Assert.Equal("k", ctx.Interrupts[0].Key);
    }

    [Fact]
    public void Choose_with_a_string_title_builds_the_title_payload_and_label_only_chips()
    {
        var ctx = new RecordingCtx();

        _ = Shuttle.Choose<string>(ctx, "Pick one", ["A", Shuttle.Action("B", 2L)]);

        Assert.Equal("{\"$mekik\":{\"actions\":[{\"label\":\"A\"},{\"label\":\"B\",\"value\":2}]},\"title\":\"Pick one\"}",
            Json.Canonicalize(ctx.Interrupts[0].Payload));
    }

    [Fact]
    public void Message_refuses_reserved_types_but_allows_text_and_carries_an_id()
    {
        var ctx = new RecordingCtx();

        Assert.Throws<ArgumentException>(() => Shuttle.Message(ctx, "interrupt", D()));
        Shuttle.Message(ctx, "text", D(("text", "hi")));
        Shuttle.Message(ctx, "card", D(("title", "x")), id: "c-1");

        Assert.Equal("{\"$mekik\":\"message\",\"data\":{\"title\":\"x\"},\"id\":\"c-1\",\"messageType\":\"card\"}", Json.Canonicalize(ctx.Emitted[1]));
    }

    [Fact]
    public void Claims_helpers_tolerate_missing_and_odd_shapes()
    {
        Assert.Empty(Shuttle.AuthClaims(new RecordingCtx()));
        var claims = D(("roles", new List<object?> { "a", null, "", 3L }), ("one", ""), ("n", 5L));

        Assert.Equal(["a", "3"], Shuttle.ClaimStrings(claims, "roles"));
        Assert.Empty(Shuttle.ClaimStrings(claims, "one"));
        Assert.Empty(Shuttle.ClaimStrings(claims, "n"));
        Assert.Empty(Shuttle.ClaimStrings(claims, "missing"));
    }

    [Fact]
    public void Client_tools_filter_by_mode_and_are_empty_without_a_snapshot()
    {
        Assert.Empty(Shuttle.ClientTools(new RecordingCtx()));
        var ctx = new RecordingCtx(D(("clientTools", new List<ClientToolDefinition>
        {
            new() { Name = "a" },
            new() { Name = "b", Mode = "notify" },
            new() { Name = "c", Mode = "call" },
        })));

        Assert.Equal(["a", "c"], Shuttle.ClientTools(ctx, mode: "call").Select(d => d.Name));
        Assert.Equal(["b"], Shuttle.ClientTools(ctx, mode: "notify").Select(d => d.Name));
    }

    [Fact]
    public async Task CallClientTool_requires_a_name()
    {
        await Assert.ThrowsAsync<ArgumentException>(async () => await Shuttle.CallClientToolAsync<object?>(new RecordingCtx(), ""));
    }

    [Fact]
    public async Task A_failed_client_tool_without_an_error_message_gets_a_default_one()
    {
        var ctx = new FailingToolCtx();

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(async () => await Shuttle.CallClientToolAsync<object?>(ctx, "scan"));

        Assert.Equal("client tool \"scan\" failed", ex.Message);
    }

    private sealed class FailingToolCtx : IContext
    {
        private readonly RecordingCtx _inner = new();
        public CompiledGraph Graph => _inner.Graph;
        public State State => _inner.State;
        public string ThreadId => _inner.ThreadId;
        public string RunId => _inner.RunId;
        public string Node => _inner.Node;
        public string TaskId => _inner.TaskId;
        public int StepIndex => 0;
        public int RecursionLimit => 1;
        public int RemainingSteps => 1;
        public IReadOnlyDictionary<string, object?> Meta => _inner.Meta;
        public IReadOnlyList<KeyValuePair<string, JournalEntry>> Journal => [];
        public CancellationToken CancellationToken => default;
        public ValueTask<T> StepAsync<T>(string key, Func<ValueTask<T>> fn) => fn();
        public ValueTask<T> StepAsync<T>(string key, Func<T> fn) => new(fn());
        public ValueTask<T> InterruptAsync<T>(object? payload = null, string key = "interrupt") =>
            ValueTask.FromResult((T)(object)new Dictionary<string, object?> { ["ok"] = false });
        public void Emit(object? payload) { }
        public void EmitToken(string text, IReadOnlyDictionary<string, object?>? meta = null) { }
    }

    [Fact]
    public async Task StreamText_skips_empty_deltas_and_concatenates_the_rest()
    {
        var ctx = new RecordingCtx();

        var full = await Shuttle.StreamText(ctx, Deltas("He", "", null, "llo"), s => s);

        Assert.Equal("Hello", full);
        Assert.Equal(["He", "llo"], ctx.Chunks.Select(c => c["content"]));
    }

    private static async IAsyncEnumerable<string?> Deltas(params string?[] parts)
    {
        foreach (var p in parts)
        {
            await Task.Yield();
            yield return p;
        }
    }

    [Fact]
    public async Task Skill_helpers_without_a_skill_source()
    {
        var ctx = new RecordingCtx();

        Assert.Empty(Shuttle.Skills(ctx));
        Assert.Equal("", Shuttle.SkillsPrompt(ctx));
        Assert.False(Shuttle.SkillResourcesAvailable(ctx));
        Assert.Throws<ArgumentException>(() => Shuttle.LoadSkill(ctx, ""));
        Assert.Throws<KeyNotFoundException>(() => Shuttle.LoadSkill(ctx, "pdf"));
        await Assert.ThrowsAsync<NotSupportedException>(() => Shuttle.SkillResourceAsync(ctx, "pdf", "a.md"));
    }

    [Fact]
    public void A_skill_source_without_resources_refuses_level_three_by_default()
    {
        ISkillSource src = SkillSources.Inline(new SkillEntry { Name = "pdf", Description = "d", Instructions = "i" });

        Assert.False(src.HasResources);
        Assert.Throws<NotSupportedException>(() => { _ = src.ReadResourceAsync("pdf", "x"); });
        Assert.Null(src.Get("nope"));
    }

    [Theory]
    [InlineData("pdf", true)]
    [InlineData("a-b-c9", true)]
    [InlineData("", false)]
    [InlineData("PDF", false)]
    [InlineData("a--b", false)]
    [InlineData("-a", false)]
    [InlineData("a-", false)]
    [InlineData("a_b", false)]
    public void The_skill_name_rule(string name, bool valid)
    {
        Assert.Equal(valid, Skills.IsValidName(name));
    }

    [Fact]
    public void Skill_names_are_capped_at_64_characters()
    {
        Assert.True(Skills.IsValidName(new string('a', 64)));
        Assert.False(Skills.IsValidName(new string('a', 65)));
    }

    [Fact]
    public void An_empty_catalog_hashes_to_empty()
    {
        Assert.Equal("", Skills.Hash([]));
        Assert.Equal("", Skills.RenderPrompt([]));
    }

    [Fact]
    public void RenderPrompt_escapes_markup_and_can_drop_the_intro()
    {
        var text = Skills.RenderPrompt([new SkillSummary { Name = "x", Description = "<b> & </b>" }], intro: null);

        Assert.Equal("<available_skills>\n  <skill>\n    <name>x</name>\n    <description>&lt;b&gt; &amp; &lt;/b&gt;</description>\n  </skill>\n</available_skills>", text);
    }

    [Fact]
    public void Client_skill_sanitization_drops_bad_entries_and_keeps_first_position_on_redeclare()
    {
        var defs = ClientSkills.Sanitize(new List<object?>
        {
            D(("name", "b"), ("description", "first b"), ("instructions", "1")),
            D(("name", "Bad Name"), ("description", "d"), ("instructions", "i")),
            D(("name", "long"), ("description", new string('x', 1025)), ("instructions", "i")),
            D(("name", "edge"), ("description", " " + new string('x', 1024) + " "), ("instructions", "i")), // trimmed to the cap
            D(("name", "blank"), ("description", "   "), ("instructions", "i")),
            D(("name", "noinstr"), ("description", "d"), ("instructions", 5L)),
            D(("name", "a"), ("description", "a"), ("instructions", ""), ("tags", new List<object?> { "x", "", 3L, "x" })),
            "not an object",
            D(("name", "b"), ("description", "second b"), ("instructions", "2")),
        });

        Assert.Equal(["b", "edge", "a"], defs.Select(d => d.Name));
        Assert.Equal("second b", defs[0].Description);
        Assert.Equal(["x"], defs[2].Tags!);
        Assert.Empty(ClientSkills.Sanitize("not a list"));
        Assert.Empty(ClientSkills.Sanitize(null));
    }

    [Fact]
    public void A_client_skill_named_like_a_server_skill_is_dropped_and_resources_stay_server_only()
    {
        var server = SkillSources.Inline(new SkillEntry { Name = "pdf", Description = "server", Instructions = "s" });
        var turn = new TurnSkillSource(server, ClientSkills.Sanitize(new List<object?>
        {
            D(("name", "pdf"), ("description", "client"), ("instructions", "c")),
            D(("name", "ui"), ("description", "client ui"), ("instructions", "u")),
        }));

        Assert.Equal([("pdf", "server"), ("ui", "client")], turn.List().Select(s => (s.Name, s.Source!)));
        Assert.Equal("s", turn.Get("pdf")!.Instructions);
        Assert.Equal(SkillOrigin.Client, turn.Get("ui")!.Source);
        Assert.Null(turn.Get("nope"));
        Assert.False(turn.HasResources);
        Assert.Throws<NotSupportedException>(() => { _ = turn.ReadResourceAsync("pdf", "x"); });
        Assert.Empty(new TurnSkillSource(null).List());
    }

    [Fact]
    public void Client_tool_sanitization_keeps_known_typed_fields_only()
    {
        var defs = ClientTools.Sanitize(new List<object?>
        {
            D(("name", "t"), ("description", 5L), ("parameters", "x"), ("tags", "x"), ("mode", "stream")),
            D(("name", "")),
            D(("description", "nameless")),
        });

        var t = Assert.Single(defs);
        Assert.Null(t.Description);
        Assert.Null(t.Parameters);
        Assert.Null(t.Tags);
        Assert.Null(t.Mode);
        Assert.Empty(ClientTools.Sanitize("[]"));
        Assert.Same(defs, ClientTools.AcceptAll(defs, ("c", "u")));
    }
}

/// <summary>The typed GenUI and message catalogs compile to the exact chunk / frame shapes.</summary>
public class CatalogEmitterTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    [Fact]
    public void Every_GenUI_emitter_names_its_registry_component_and_omits_null_props()
    {
        var ctx = new RecordingCtx();

        GenUI.Text(ctx, "hi");
        GenUI.Form(ctx, [GenUI.Field("email", "Email", "email", required: true)], title: "Sign up");
        GenUI.Alert(ctx, "careful", variant: "warning");
        GenUI.QuickReplies(ctx, [GenUI.QuickReply("Yes", "y")]);
        GenUI.List(ctx, [GenUI.Item("one", secondary: "1")], ordered: true);
        GenUI.Rating(ctx, maxStars: 5, readOnly: true, value: 4.5);
        GenUI.DatePicker(ctx, label: "When", min: "2026-01-01");
        GenUI.Chart(ctx, type: "bar", labels: ["a"], datasets: [GenUI.Dataset([1.5], label: "s")]);
        GenUI.ImageGallery(ctx, [GenUI.Image("x.png", alt: "x")], columns: 2, id: "g");

        Assert.Equal(
        [
            "{\"component\":\"genui-text\",\"props\":{\"content\":\"hi\"},\"type\":\"ui\"}",
            "{\"component\":\"genui-form\",\"props\":{\"fields\":[{\"label\":\"Email\",\"name\":\"email\",\"required\":true,\"type\":\"email\"}],\"title\":\"Sign up\"},\"type\":\"ui\"}",
            "{\"component\":\"genui-alert\",\"props\":{\"message\":\"careful\",\"variant\":\"warning\"},\"type\":\"ui\"}",
            "{\"component\":\"genui-quick-replies\",\"props\":{\"items\":[{\"label\":\"Yes\",\"value\":\"y\"}]},\"type\":\"ui\"}",
            "{\"component\":\"genui-list\",\"props\":{\"items\":[{\"secondary\":\"1\",\"text\":\"one\"}],\"ordered\":true},\"type\":\"ui\"}",
            "{\"component\":\"genui-rating\",\"props\":{\"maxStars\":5,\"readonly\":true,\"value\":4.5},\"type\":\"ui\"}",
            "{\"component\":\"genui-date-picker\",\"props\":{\"label\":\"When\",\"min\":\"2026-01-01\"},\"type\":\"ui\"}",
            "{\"component\":\"genui-chart\",\"props\":{\"datasets\":[{\"data\":[1.5],\"label\":\"s\"}],\"labels\":[\"a\"],\"type\":\"bar\"},\"type\":\"ui\"}",
            "{\"component\":\"genui-image-gallery\",\"id\":\"g\",\"props\":{\"columns\":2,\"images\":[{\"alt\":\"x\",\"src\":\"x.png\"}]},\"type\":\"ui\"}",
        ], ctx.Chunks.Select(c => Json.Canonicalize(c)));
    }

    [Fact]
    public void Ref_without_props_is_just_the_component()
    {
        Assert.Equal("{\"component\":\"x\"}", Json.Canonicalize(GenUI.Ref("x")));
    }

    [Fact]
    public void Every_message_emitter_matches_its_spec()
    {
        var ctx = new RecordingCtx();

        Messages.Text(ctx, "hi", urls: ["https://x"], previewVariant: "compact");
        Messages.Image(ctx, "a.png", alt: "a");
        Messages.Card(ctx, "T", subtitle: "s", buttons: [Messages.Button("Go", "/go")], id: "c-1");
        Messages.Buttons(ctx, [Messages.Button("A")], text: "pick", persistent: true);
        Messages.QuickReply(ctx, "pick", [Messages.Button("A")], keepActions: false);
        Messages.File(ctx, "https://x/f.pdf", "f.pdf", size: 1024, mimeType: "application/pdf");
        Messages.Video(ctx, "v.mp4", poster: "p.png");
        Messages.Carousel(ctx, [Messages.CarouselCard("one", image: "1.png")]);

        var emitted = ctx.Emitted.Cast<Frame>().ToList();
        Assert.Equal(["text", "image", "card", "buttons", "quick-reply", "file", "video", "carousel"], emitted.Select(e => e["messageType"]));
        Assert.All(emitted, e => Assert.Equal("message", e["$mekik"]));
        Assert.Equal("c-1", emitted[2]["id"]);
        Assert.Equal("{\"mimeType\":\"application/pdf\",\"name\":\"f.pdf\",\"size\":1024,\"url\":\"https://x/f.pdf\"}", Json.Canonicalize(emitted[5]["data"]));
        Assert.Equal("{\"cards\":[{\"image\":\"1.png\",\"title\":\"one\"}]}", Json.Canonicalize(emitted[7]["data"]));
        Assert.Equal("{\"keepActions\":false,\"text\":\"pick\",\"actions\":[{\"label\":\"A\"}]}".Length, Json.Canonicalize(emitted[4]["data"]).Length);
    }

    [Fact]
    public void A_GenUiComponent_with_only_the_required_members_emits_and_specs_minimally()
    {
        var ctx = new RecordingCtx();
        var component = new Minimal();

        component.Emit(ctx, D(("n", 1L)), id: "m-1");

        Assert.Equal("{\"component\":\"minimal\",\"id\":\"m-1\",\"props\":{\"n\":1},\"type\":\"ui\"}", Json.Canonicalize(ctx.Chunks.Single()));
        var spec = component.ToSpec();
        Assert.Null(spec.Css);
        Assert.Null(spec.Props);
        Assert.Null(spec.Version);
        Assert.Null(spec.Tag);
        Assert.Throws<ArgumentException>(() => new ComponentCatalog([new ComponentSpec { Name = "", Template = "x" }]));
        Assert.True(new ComponentCatalog().IsEmpty);
    }

    private sealed class Minimal : GenUiComponent
    {
        public override string Name => "minimal";
        public override string Template => "<i>{{n}}</i>";
    }
}
