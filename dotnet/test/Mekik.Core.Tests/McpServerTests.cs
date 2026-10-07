using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// mekik as an MCP server (PROTOCOL.md §13). The JSON-RPC surface is pinned by
/// conformance/mcp/rpc.json (shared with TypeScript); the turn mapping is driven
/// through a real app here. Mirror of ts/packages/core/test/mcp.test.ts.
/// </summary>
public class McpServerTests
{
    private static readonly string RpcFixture = Path.Combine(AppContext.BaseDirectory, "mcp", "rpc.json");

    /// <summary>Answers, using a traced tool and a skill; asks for approval when the input says so.</summary>
    private static readonly CompiledGraph Desk = Graph.Create("desk")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("agent", async (State s, IContext ctx) =>
        {
            var input = s.Get<string>("input");
            if (input == "boom") throw new InvalidOperationException("kaboom");
            var order = await Shuttle.Tool(ctx, "get_order", new Dictionary<string, object?> { ["id"] = "ORD-42" },
                () => new Dictionary<string, object?> { ["id"] = "ORD-42", ["total"] = 249.9 });
            Shuttle.LoadSkill(ctx, "brand-voice");
            Shuttle.Text(ctx, "Looking");
            Shuttle.Text(ctx, " it up…");
            if (input.StartsWith("refund"))
            {
                var ok = await Shuttle.Choose<object?>(ctx, new Dictionary<string, object?> { ["title"] = FormattableString.Invariant($"Refund {order["total"]}?") },
                    [Shuttle.Action("Approve", new Dictionary<string, object?> { ["approved"] = true }), Shuttle.Action("Cancel")]);
                var approved = ok is IReadOnlyDictionary<string, object?> d && d.GetValueOrDefault("approved") is true;
                return Update.Of("reply", approved ? "Refunded." : "Cancelled.");
            }
            return Update.Of("reply", FormattableString.Invariant($"Order {order["id"]} totals {order["total"]}."));
        })
        .Edge(Graph.Start, "agent")
        .Edge("agent", Graph.End)
        .Compile();

    private static MekikApp App() => new(new MekikOptions
    {
        Graph = Desk,
        Checkpointer = new InMemoryCheckpointer(),
        Reply = s => s.GetValueOrDefault("reply") as string,
        Skills = SkillSources.Inline(new SkillEntry { Name = "brand-voice", Description = "House style.", Instructions = "Short sentences." }),
    });

    private static MekikMcpServer Server(MekikApp? app = null, bool includeFrames = false) => new(app ?? App(), new McpServerOptions
    {
        Name = "support_desk",
        Description = "Answers questions about orders.",
        ServerInfo = ("mekik", "0.7.1"),
        IncludeFrames = includeFrames,
    });

    private static IReadOnlyDictionary<string, object?> Structured(IReadOnlyDictionary<string, object?> r) =>
        (IReadOnlyDictionary<string, object?>)r["structuredContent"]!;

    private static string Text(IReadOnlyDictionary<string, object?> r) =>
        (string)((IReadOnlyDictionary<string, object?>)((IEnumerable<object?>)r["content"]!).First()!)["text"]!;

    private static Dictionary<string, object?> Args(params (string, object?)[] pairs) => pairs.ToDictionary(p => p.Item1, p => p.Item2);

    // ── conformance/mcp/rpc.json ──────────────────────────────────────────────

    public static IEnumerable<object[]> RpcCases()
    {
        var fixture = (IReadOnlyDictionary<string, object?>)Json.Parse(File.ReadAllText(RpcFixture))!;
        foreach (var c in ((IEnumerable<object?>)fixture["cases"]!).Cast<IReadOnlyDictionary<string, object?>>())
            yield return [c["name"]!, c.GetValueOrDefault("request"), c.GetValueOrDefault("response")];
    }

    [Theory]
    [MemberData(nameof(RpcCases))]
    public async Task Rpc_surface_matches_the_shared_fixture(string name, object? request, object? response)
    {
        var actual = await Server().HandleAsync(request);
        Assert.True(Json.Canonicalize(response) == Json.Canonicalize(actual), $"{name}: got {Json.Canonicalize(actual)}");
    }

    // ── the turn mapping ──────────────────────────────────────────────────────

    [Fact]
    public async Task A_finished_turn_returns_the_reply_tools_and_skills()
    {
        var r = await Server().CallToolAsync("support_desk", Args(("message", "where is my order?")));
        Assert.False(r.ContainsKey("isError"));
        Assert.Equal("Order ORD-42 totals 249.9.", Text(r));
        var sc = Structured(r);
        Assert.Equal("finished", sc["status"]);
        Assert.StartsWith("conv-", (string)sc["conversationId"]!);
        var tools = ((IEnumerable<object?>)sc["toolCalls"]!).Cast<IReadOnlyDictionary<string, object?>>().ToList();
        Assert.Equal(("get_order", "completed"), ((string)tools[0]["name"]!, (string)tools[0]["status"]!));
        Assert.Equal(["brand-voice"], ((IEnumerable<object?>)sc["skills"]!).Cast<string>().ToArray());
        Assert.Empty((IEnumerable<object?>)sc["pending"]!);
        Assert.False(sc.ContainsKey("frames"));
    }

    [Fact]
    public async Task A_conversationId_continues_the_conversation_and_an_unknown_one_starts_fresh()
    {
        var s = Server();
        var first = Structured(await s.CallToolAsync("support_desk", Args(("message", "hi"))));
        var again = Structured(await s.CallToolAsync("support_desk", Args(("message", "hi again"), ("conversationId", first["conversationId"]))));
        Assert.Equal(first["conversationId"], again["conversationId"]);
        var fresh = Structured(await s.CallToolAsync("support_desk", Args(("message", "hi"), ("conversationId", "conv-does-not-exist"))));
        Assert.NotEqual("conv-does-not-exist", fresh["conversationId"]);
    }

    [Fact]
    public async Task A_paused_turn_returns_pending_and_the_resume_tool_answers_it()
    {
        var s = Server();
        var paused = await s.CallToolAsync("support_desk", Args(("message", "refund please")));
        var sc = Structured(paused);
        Assert.Equal("interrupted", sc["status"]);
        Assert.False(paused.ContainsKey("isError"));
        var p = ((IEnumerable<object?>)sc["pending"]!).Cast<IReadOnlyDictionary<string, object?>>().Single();
        Assert.Equal("""{"title":"Refund 249.9?"}""", Json.Canonicalize(p["payload"]));
        Assert.Equal("""[{"label":"Approve","value":{"approved":true}},{"label":"Cancel"}]""", Json.Canonicalize(p["actions"]));
        Assert.Contains("paused and needs input", Text(paused));
        Assert.Contains("options: {\"approved\":true}, \"Cancel\"", Text(paused));
        Assert.Contains($"Call support_desk__resume with conversationId \"{sc["conversationId"]}\"", Text(paused));

        var resumed = await s.CallToolAsync("support_desk__resume", Args(
            ("conversationId", sc["conversationId"]),
            ("answers", new Dictionary<string, object?> { [(string)p["id"]!] = new Dictionary<string, object?> { ["approved"] = true } })));
        Assert.Equal("finished", Structured(resumed)["status"]);
        Assert.Equal("Refunded.", Structured(resumed)["reply"]);
    }

    [Fact]
    public async Task A_turn_while_parked_or_a_resume_with_nothing_open_is_refused_not_a_crash()
    {
        var s = Server();
        var paused = Structured(await s.CallToolAsync("support_desk", Args(("message", "refund please"))));
        var busy = await s.CallToolAsync("support_desk", Args(("message", "hello?"), ("conversationId", paused["conversationId"])));
        Assert.Equal(true, busy["isError"]);
        Assert.Equal("refused", Structured(busy)["status"]);
        Assert.StartsWith("interrupted: answer the open interrupt", Text(busy));

        var finished = Structured(await s.CallToolAsync("support_desk", Args(("message", "hi"))));
        var nothing = await s.CallToolAsync("support_desk__resume", Args(("conversationId", finished["conversationId"]), ("answers", new Dictionary<string, object?> { ["x"] = 1L })));
        Assert.Equal("refused", Structured(nothing)["status"]);
        Assert.StartsWith("not_interrupted", Text(nothing));
    }

    [Fact]
    public async Task A_graph_error_is_a_result_with_isError()
    {
        var r = await Server().CallToolAsync("support_desk", Args(("message", "boom")));
        Assert.Equal(true, r["isError"]);
        Assert.Equal("error", Structured(r)["status"]);
        Assert.Contains("agent: kaboom", Text(r));
    }

    [Fact]
    public async Task IncludeFrames_puts_the_persistent_frames_in_structuredContent()
    {
        var r = await Server(includeFrames: true).CallToolAsync("support_desk", Args(("message", "hi")));
        var types = ((IEnumerable<object?>)Structured(r)["frames"]!).Cast<IReadOnlyDictionary<string, object?>>().Select(f => (string)f["type"]!).ToList();
        Assert.Contains("tool_call", types);
        Assert.Contains("skill", types);
        Assert.Contains("genui", types);
        Assert.Contains("text", types);
        Assert.DoesNotContain("run", types);
    }

    [Fact]
    public async Task Argument_shape_errors_throw_and_map_to_minus_32602()
    {
        var s = Server();
        await Assert.ThrowsAsync<McpArgumentException>(() => s.CallToolAsync("support_desk", Args(("message", 5L))));
        await Assert.ThrowsAsync<McpArgumentException>(() => s.CallToolAsync("support_desk", Args(("message", "x"), ("conversationId", 5L))));
        await Assert.ThrowsAsync<McpArgumentException>(() => s.CallToolAsync("support_desk__resume", Args(("answers", new Dictionary<string, object?>()))));
        var viaRpc = await s.HandleAsync(new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0", ["id"] = 1L, ["method"] = "tools/call",
            ["params"] = new Dictionary<string, object?> { ["name"] = "support_desk", ["arguments"] = Args(("message", 5L)) },
        });
        Assert.Equal(-32602L, ((IReadOnlyDictionary<string, object?>)viaRpc!["error"]!)["code"]);
        var ok = await s.HandleAsync("""{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"support_desk","arguments":{"message":"hi"}}}""");
        Assert.Equal("finished", Structured((IReadOnlyDictionary<string, object?>)ok!["result"]!)["status"]);
        var parse = await s.HandleAsync("{not json");
        Assert.Equal(-32700L, ((IReadOnlyDictionary<string, object?>)parse!["error"]!)["code"]);
    }

    [Fact]
    public void The_tool_name_is_validated()
    {
        Assert.Throws<ArgumentException>(() => new MekikMcpServer(App(), new McpServerOptions { Name = "not valid!" }));
        Assert.Equal("a-b_c__resume", new MekikMcpServer(App(), new McpServerOptions { Name = "a-b_c" }).ResumeName);
    }

    [Fact]
    public void Summarize_streamed_text_refused_aborted_and_client_tool_pauses()
    {
        var streamed = MekikMcpServer.Summarize("c",
        [
            new Dictionary<string, object?> { ["type"] = "run", ["data"] = new Dictionary<string, object?> { ["status"] = "started" } },
            new Dictionary<string, object?> { ["type"] = "genui", ["seq"] = 1L, ["chunk"] = new Dictionary<string, object?> { ["type"] = "text", ["content"] = "Hel" } },
            new Dictionary<string, object?> { ["type"] = "genui", ["seq"] = 2L, ["chunk"] = new Dictionary<string, object?> { ["type"] = "text", ["content"] = "lo" } },
            new Dictionary<string, object?> { ["type"] = "run", ["data"] = new Dictionary<string, object?> { ["status"] = "finished" } },
        ], "x__resume", false);
        Assert.Equal("Hello", Text(streamed));

        var refused = MekikMcpServer.Summarize("c",
            [new Dictionary<string, object?> { ["type"] = "error", ["data"] = new Dictionary<string, object?> { ["code"] = "busy", ["message"] = "a run is already in flight" } }],
            "x__resume", false);
        Assert.Equal(true, refused["isError"]);
        Assert.Equal("busy: a run is already in flight", Text(refused));

        var aborted = MekikMcpServer.Summarize("c",
            [new Dictionary<string, object?> { ["type"] = "run", ["data"] = new Dictionary<string, object?> { ["status"] = "aborted" } }], "x__resume", false);
        Assert.Equal("aborted", Structured(aborted)["status"]);
        Assert.False(aborted.ContainsKey("isError"));

        var empty = MekikMcpServer.Summarize("c",
            [new Dictionary<string, object?> { ["type"] = "run", ["data"] = new Dictionary<string, object?> { ["status"] = "finished" } }], "x__resume", false);
        Assert.Equal("(no reply)", Text(empty));

        var clientTool = MekikMcpServer.Summarize("c",
        [
            new Dictionary<string, object?>
            {
                ["type"] = "interrupt", ["seq"] = 1L, ["id"] = "call/0:tool:pick_date",
                ["data"] = new Dictionary<string, object?> { ["payload"] = new Dictionary<string, object?>(), ["tool"] = new Dictionary<string, object?> { ["name"] = "pick_date" } },
            },
            new Dictionary<string, object?> { ["type"] = "run", ["data"] = new Dictionary<string, object?> { ["status"] = "interrupted" } },
        ], "x__resume", false);
        Assert.Equal("""[{"id":"call/0:tool:pick_date","payload":{},"tool":"pick_date"}]""", Json.Canonicalize(Structured(clientTool)["pending"]));
        Assert.Contains("client tool call (pick_date)", Text(clientTool));
    }
}
