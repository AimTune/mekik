using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// Client tools (PROTOCOL.md §11): declaration and the opt-in policy, the
/// per-turn snapshot with tag filtering, and both invocation modes — the
/// durable interrupt round-trip and the fire-and-forget event chunk. Mirror of
/// ts/packages/core/test/client-tools.test.ts.
/// </summary>
public class ClientToolsTests
{
    private sealed class FakeConn(string id) : IConnection
    {
        public string Id => id;
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame) => _sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    // ── graphs ────────────────────────────────────────────────────────────────

    /// <summary>Replies with the tool names (and tags) this turn sees — the snapshot, observed.</summary>
    private static readonly CompiledGraph Introspector = Graph.Create("introspector")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("look", (State s, IContext ctx) =>
        {
            var input = s.Get<string>("input");
            var tags = string.IsNullOrEmpty(input) ? null : input.Split(',');
            var defs = Shuttle.ClientTools(ctx, tags);
            var names = defs.Select(d => d.Tags is { Count: > 0 } ? $"{d.Name}[{string.Join(",", d.Tags)}]" : d.Name);
            return Update.Of("reply", $"tools:{string.Join("|", names)}");
        })
        .Edge(Graph.Start, "look")
        .Edge("look", Graph.End)
        .Compile();

    /// <summary>Calls one client tool round-trip and replies with its result.</summary>
    private static readonly CompiledGraph Caller = Graph.Create("caller")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("call", async (State s, IContext ctx) =>
        {
            var res = await Shuttle.CallClientToolAsync<IReadOnlyDictionary<string, object?>>(
                ctx, "pick_date", new Dictionary<string, object?> { ["min"] = s.Get<string>("input") });
            return Update.Of("reply", $"picked {res!.GetValueOrDefault("date")}");
        })
        .Edge(Graph.Start, "call")
        .Edge("call", Graph.End)
        .Compile();

    private static int _lookups;

    /// <summary>A journaled side effect before the client tool call — the exactly-once check.</summary>
    private static readonly CompiledGraph Gated = Graph.Create("gated")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("call", async (State s, IContext ctx) =>
        {
            var order = await Shuttle.Tool(ctx, "get_order",
                new Dictionary<string, object?> { ["id"] = s.Get<string>("input") },
                () => { _lookups++; return s.Get<string>("input"); });
            var res = await Shuttle.CallClientToolAsync<string>(
                ctx, "confirm_address", new Dictionary<string, object?> { ["orderId"] = order });
            return Update.Of("reply", res!);
        })
        .Edge(Graph.Start, "call")
        .Edge("call", Graph.End)
        .Compile();

    /// <summary>Fires a notify tool and finishes without pausing.</summary>
    private static readonly CompiledGraph Notifier = Graph.Create("notifier")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("show", async (State _, IContext ctx) =>
        {
            var res = await Shuttle.CallClientToolAsync<object?>(
                ctx, "show_confetti", new Dictionary<string, object?> { ["level"] = 3L });
            return Update.Of("reply", res is null ? "fired" : "unexpected");
        })
        .Edge(Graph.Start, "show")
        .Edge("show", Graph.End)
        .Compile();

    // ── harness ───────────────────────────────────────────────────────────────

    private static Dictionary<string, object?> Def(string name, string? mode = null, IReadOnlyList<string>? tags = null)
    {
        var d = new Dictionary<string, object?> { ["name"] = name };
        if (mode is not null) d["mode"] = mode;
        if (tags is not null) d["tags"] = tags.Cast<object?>().ToList();
        return d;
    }

    private static List<object?> PickDate() =>
    [
        new Dictionary<string, object?>
        {
            ["name"] = "pick_date",
            ["description"] = "Open the date picker",
            ["parameters"] = new Dictionary<string, object?> { ["type"] = "object" },
        },
    ];

    private static MekikApp App(CompiledGraph graph, ClientToolsPolicy? policy) =>
        new(new MekikOptions
        {
            Graph = graph,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            ClientTools = policy,
        });

    private static Dictionary<string, object?> TextFrame(string text) => new()
    {
        ["type"] = "text",
        ["data"] = new Dictionary<string, object?> { ["text"] = text },
    };

    private static Dictionary<string, object?> ResumeFrame(string id, object? answer) => new()
    {
        ["type"] = "resume",
        ["answers"] = new Dictionary<string, object?> { [id] = answer },
    };

    private static string? LastBot(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "text" && (string?)f.GetValueOrDefault("from") == "bot")
        .Select(f => ((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") as string)
        .LastOrDefault();

    private static List<string?> RunStatuses(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "run")
        .Select(f => ((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("status") as string)
        .ToList();

    private static List<IReadOnlyDictionary<string, object?>> ToolCalls(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "tool_call")
        .Select(f => (IReadOnlyDictionary<string, object?>)f["data"]!)
        .ToList();

    private static IReadOnlyDictionary<string, object?> FirstInterrupt(FakeConn c) =>
        c.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt");

    // ── declaration & policy (§11.1) ──────────────────────────────────────────

    [Fact]
    public async Task Declarations_are_ignored_entirely_unless_the_app_opts_in()
    {
        var app = App(Introspector, policy: null);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = PickDate() } });
        await app.ReceiveAsync(conn, TextFrame(""));

        Assert.Equal("tools:", LastBot(conn));
    }

    [Fact]
    public async Task Hello_tools_reach_the_snapshot_when_the_app_opts_in()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        var tools = PickDate();
        tools.Add(Def("show_map"));
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = tools } });
        await app.ReceiveAsync(conn, TextFrame(""));

        Assert.Equal("tools:pick_date|show_map", LastBot(conn));
    }

    [Fact]
    public async Task Malformed_declarations_are_sanitized_and_duplicate_names_last_win()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        var tools = new List<object?>
        {
            new Dictionary<string, object?> { ["name"] = "" },
            new Dictionary<string, object?> { ["nope"] = true },
            "junk",
            new Dictionary<string, object?> { ["name"] = "a", ["mode"] = "weird", ["tags"] = new List<object?> { "x", 5L } },
            new Dictionary<string, object?> { ["name"] = "a", ["description"] = "the keeper" },
        };
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = tools } });
        await app.ReceiveAsync(conn, TextFrame(""));

        // The second "a" (no tags) won; the invalid mode and non-string tag never survive.
        Assert.Equal("tools:a", LastBot(conn));
    }

    [Fact]
    public async Task The_policy_function_is_the_allowlist()
    {
        var app = App(Introspector, (tools, _) => tools.Where(t => t.Name == "pick_date").ToList());
        var conn = new FakeConn("c-1");
        var tools = PickDate();
        tools.Add(Def("evil_tool"));
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = tools } });
        await app.ReceiveAsync(conn, TextFrame(""));

        Assert.Equal("tools:pick_date", LastBot(conn));
    }

    [Fact]
    public async Task A_client_tools_frame_replaces_the_set_and_empty_withdraws_it()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = PickDate() } });

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "client_tools",
            ["tools"] = new List<object?> { Def("show_map") },
        });
        await app.ReceiveAsync(conn, TextFrame(""));
        Assert.Equal("tools:show_map", LastBot(conn));

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "client_tools",
            ["tools"] = new List<object?>(),
        });
        await app.ReceiveAsync(conn, TextFrame(""));
        Assert.Equal("tools:", LastBot(conn));
    }

    [Fact]
    public async Task A_client_tools_frame_without_a_tools_array_is_a_bad_request()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, new Dictionary<string, object?> { ["type"] = "client_tools" });

        var error = conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "error");
        Assert.Equal("bad_request", ((IReadOnlyDictionary<string, object?>)error["data"]!)["code"]);
    }

    [Fact]
    public async Task Multi_tab_snapshots_the_union_and_the_latest_declaration_of_a_name_wins()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var c1 = new FakeConn("c-1");
        await app.ConnectAsync(c1, new ConnectParams
        {
            Hello = new HelloInfo { UserId = "u1", Tools = [Def("a"), Def("b")] },
        });
        var welcome = (IReadOnlyDictionary<string, object?>)c1.Sent[0]["data"]!;
        var convId = (string)welcome["conversationId"]!;

        var c2 = new FakeConn("c-2");
        await app.ConnectAsync(c2, new ConnectParams
        {
            Hello = new HelloInfo { UserId = "u1", ConversationId = convId, Tools = [Def("a", tags: ["v2"]), Def("c")] },
        });

        await app.ReceiveAsync(c1, TextFrame(""));
        // Union of both tabs, deduped by name: "a" keeps its first position but
        // carries tab 2's (later) definition — the [v2] tag proves which one won.
        Assert.Equal("tools:a[v2]|b|c", LastBot(c2));
    }

    // ── tag filtering (§11.2) ─────────────────────────────────────────────────

    [Fact]
    public async Task A_tag_query_returns_untagged_tools_plus_the_intersecting_ones()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams
        {
            Hello = new HelloInfo { Tools = [Def("general"), Def("map", tags: ["geo"]), Def("pay", tags: ["billing"])] },
        });
        await app.ReceiveAsync(conn, TextFrame("geo"));

        Assert.Equal("tools:general|map[geo]", LastBot(conn));
    }

    [Fact]
    public async Task A_query_no_tagged_tool_matches_still_returns_the_untagged_ones()
    {
        var app = App(Introspector, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams
        {
            Hello = new HelloInfo { Tools = [Def("general"), Def("map", tags: ["geo"])] },
        });
        await app.ReceiveAsync(conn, TextFrame("nothing"));

        Assert.Equal("tools:general", LastBot(conn));
    }

    // ── the round-trip call (§11.3) ───────────────────────────────────────────

    [Fact]
    public async Task CallClientTool_parks_the_run_on_an_interrupt_carrying_data_tool()
    {
        var app = App(Caller, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = PickDate() } });
        await app.ReceiveAsync(conn, TextFrame("2026-08-01"));

        Assert.Equal(["started", "interrupted"], RunStatuses(conn));

        var data = (IReadOnlyDictionary<string, object?>)FirstInterrupt(conn)["data"]!;
        var tool = (IReadOnlyDictionary<string, object?>)data["tool"]!;
        Assert.Equal("pick_date", tool["name"]);
        Assert.Equal("2026-08-01", ((IReadOnlyDictionary<string, object?>)tool["params"]!)["min"]);
        Assert.False(data.ContainsKey("event"));
        Assert.False(data.ContainsKey("actions"));
        Assert.Empty((IReadOnlyDictionary<string, object?>)data["payload"]!);

        var running = ToolCalls(conn).Last();
        Assert.Equal("pick_date", running["name"]);
        Assert.Equal("running", running["status"]);
    }

    [Fact]
    public async Task A_resume_with_ok_true_resolves_the_call()
    {
        var app = App(Caller, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = PickDate() } });
        await app.ReceiveAsync(conn, TextFrame("2026-08-01"));
        var id = (string)FirstInterrupt(conn)["id"]!;

        await app.ReceiveAsync(conn, ResumeFrame(id, new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["result"] = new Dictionary<string, object?> { ["date"] = "2026-08-15" },
        }));

        Assert.Equal(["started", "interrupted", "started", "finished"], RunStatuses(conn));
        Assert.Contains(conn.Sent, f => (string?)f.GetValueOrDefault("type") == "interrupt_resolved");

        var calls = ToolCalls(conn);
        var completed = calls.Last();
        Assert.Equal("completed", completed["status"]);
        Assert.Equal("2026-08-15", ((IReadOnlyDictionary<string, object?>)completed["result"]!)["date"]);
        // The re-emitted running trace upserts: same id on every trace for this call.
        Assert.Single(calls.Select(t => t["id"]).Distinct());
        Assert.Equal("picked 2026-08-15", LastBot(conn));
    }

    [Fact]
    public async Task A_resume_with_ok_false_makes_the_call_throw()
    {
        var app = App(Caller, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = PickDate() } });
        await app.ReceiveAsync(conn, TextFrame("x"));
        var id = (string)FirstInterrupt(conn)["id"]!;

        await app.ReceiveAsync(conn, ResumeFrame(id, new Dictionary<string, object?>
        {
            ["ok"] = false,
            ["error"] = "user closed the picker",
        }));

        Assert.Equal(["started", "interrupted", "started", "error"], RunStatuses(conn));
        var errored = ToolCalls(conn).First(t => (string?)t.GetValueOrDefault("status") == "error");
        Assert.Equal("user closed the picker", errored["error"]);
    }

    [Fact]
    public async Task A_bare_answer_without_the_envelope_is_taken_as_the_result()
    {
        var app = App(Caller, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = PickDate() } });
        await app.ReceiveAsync(conn, TextFrame("x"));
        var id = (string)FirstInterrupt(conn)["id"]!;

        await app.ReceiveAsync(conn, ResumeFrame(id, new Dictionary<string, object?> { ["date"] = "1999-12-31" }));

        Assert.Equal("picked 1999-12-31", LastBot(conn));
    }

    [Fact]
    public async Task Welcome_pending_re_announces_an_open_tool_call_with_data_tool()
    {
        var app = App(Caller, ClientTools.AcceptAll);
        var c1 = new FakeConn("c-1");
        await app.ConnectAsync(c1, new ConnectParams { Hello = new HelloInfo { UserId = "u1", Tools = PickDate() } });
        var convId = (string)((IReadOnlyDictionary<string, object?>)c1.Sent[0]["data"]!)["conversationId"]!;
        await app.ReceiveAsync(c1, TextFrame("x"));

        var c2 = new FakeConn("c-2");
        await app.ConnectAsync(c2, new ConnectParams { Hello = new HelloInfo { UserId = "u1", ConversationId = convId } });

        var pending = (List<object?>)((IReadOnlyDictionary<string, object?>)c2.Sent[0]["data"]!)["pending"]!;
        var view = (IReadOnlyDictionary<string, object?>)pending.Single()!;
        var data = (IReadOnlyDictionary<string, object?>)view["data"]!;
        var tool = (IReadOnlyDictionary<string, object?>)data["tool"]!;
        Assert.Equal("pick_date", tool["name"]);
        Assert.Equal("x", ((IReadOnlyDictionary<string, object?>)tool["params"]!)["min"]);
    }

    [Fact]
    public async Task A_journaled_side_effect_before_the_call_runs_exactly_once()
    {
        _lookups = 0;
        var app = App(Gated, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = [Def("confirm_address")] } });
        await app.ReceiveAsync(conn, TextFrame("ORD-1"));
        var id = (string)FirstInterrupt(conn)["id"]!;

        await app.ReceiveAsync(conn, ResumeFrame(id, new Dictionary<string, object?> { ["ok"] = true, ["result"] = "confirmed" }));

        Assert.Equal(1, _lookups);
        Assert.Equal(["started", "interrupted", "started", "finished"], RunStatuses(conn));
        Assert.Equal("confirmed", LastBot(conn));
        // Two distinct tools, each with one stable id across the replay.
        Assert.Equal(2, ToolCalls(conn).Select(t => t["id"]).Distinct().Count());
    }

    // ── the notify mode (§11.3) ───────────────────────────────────────────────

    [Fact]
    public async Task A_notify_tool_streams_a_client_tool_event_chunk_and_never_parks()
    {
        var app = App(Notifier, ClientTools.AcceptAll);
        var conn = new FakeConn("c-1");
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = [Def("show_confetti", mode: "notify")] } });
        await app.ReceiveAsync(conn, TextFrame(""));

        Assert.Equal(["started", "finished"], RunStatuses(conn));
        Assert.DoesNotContain(conn.Sent, f => (string?)f.GetValueOrDefault("type") == "interrupt");

        var chunk = conn.Sent
            .Where(f => (string?)f.GetValueOrDefault("type") == "genui")
            .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
            .Single(ch => (string?)ch.GetValueOrDefault("name") == Protocol.ClientToolEvent);
        var payload = (IReadOnlyDictionary<string, object?>)chunk["payload"]!;
        Assert.Equal("show_confetti", payload["name"]);
        Assert.Equal(3L, ((IReadOnlyDictionary<string, object?>)payload["params"]!)["level"]);

        var calls = ToolCalls(conn);
        Assert.Equal(["running", "completed"], calls.Select(t => (string?)t["status"]).ToList());
        Assert.Equal(calls[0]["id"], calls[1]["id"]);
        // The chunk is keyed by the trace id, so a replay pass upserts it.
        Assert.Equal(calls[0]["id"], chunk["id"]);

        Assert.Equal("fired", LastBot(conn));
    }
}
