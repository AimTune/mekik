using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// JSON-RPC edges of the MCP (§13) and A2A (§14) servers beyond the shared
/// fixtures: raw-string messages, an unexpected exception mapped to -32603, and
/// the task-state table.
/// </summary>
public class RpcEdgeTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    private static MekikMcpServer Mcp(MekikApp? app = null) =>
        new(app ?? Graphs.App(Graphs.Echo), new McpServerOptions { Name = "echo", Description = "Echoes." });

    private static MekikA2aServer A2a(MekikApp? app = null) =>
        new(app ?? Graphs.App(Graphs.Echo), new A2aServerOptions { Name = "Echo", Url = "https://x/a2a" });

    private static Frame Error(Frame? reply) => (Frame)reply!["error"]!;

    [Fact]
    public async Task Mcp_accepts_a_raw_json_string_and_answers_bad_json_with_a_parse_error()
    {
        var ok = await Mcp().HandleAsync("{\"jsonrpc\":\"2.0\",\"id\":\"p\",\"method\":\"ping\"}");
        var bad = await Mcp().HandleAsync("{nope");

        Assert.Equal("p", ok!["id"]);
        Assert.Equal(MekikMcpServer.ParseError, Convert.ToInt32(Error(bad)["code"]));
        Assert.True(bad!.ContainsKey("id"));
        Assert.Null(bad["id"]);
        Assert.Equal("{\"error\":{\"code\":-32700,\"message\":\"parse error\"},\"id\":null,\"jsonrpc\":\"2.0\"}", Json.Serialize(bad));
    }

    [Fact]
    public async Task Mcp_maps_an_unexpected_failure_inside_a_call_to_internal_error()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Input = _ => throw new InvalidOperationException("mapper exploded") });

        var reply = await Mcp(app).HandleAsync(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "tools/call"),
            ("params", D(("name", "echo"), ("arguments", D(("message", "hi")))))));

        Assert.Equal(MekikMcpServer.InternalError, Convert.ToInt32(Error(reply)["code"]));
        Assert.Equal("mapper exploded", Error(reply)["message"]);
    }

    [Fact]
    public async Task A2a_accepts_a_raw_json_string_and_answers_bad_json_with_a_parse_error()
    {
        var ok = await A2a().HandleAsync("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tasks/get\",\"params\":{\"id\":\"nope\"}}");
        var bad = await A2a().HandleAsync("[");

        Assert.Equal(MekikA2aServer.TaskNotFound, Convert.ToInt32(Error(ok)["code"]));
        Assert.Equal(-32700, Convert.ToInt32(Error(bad)["code"]));
    }

    [Fact]
    public async Task A2a_maps_an_unexpected_failure_to_internal_error()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Input = _ => throw new InvalidOperationException("mapper exploded") });

        var reply = await A2a(app).HandleAsync(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "message/send"),
            ("params", D(("message", D(("role", "user"), ("parts", new List<object?> { D(("kind", "text"), ("text", "hi")) })))))));

        Assert.Equal(-32603, Convert.ToInt32(Error(reply)["code"]));
    }

    [Theory]
    [InlineData("finished", "completed")]
    [InlineData("interrupted", "input-required")]
    [InlineData("error", "failed")]
    [InlineData("aborted", "canceled")]
    [InlineData("refused", "rejected")]
    [InlineData("anything-else", "rejected")]
    public void A2a_task_state_for_each_turn_status(string status, string state)
    {
        Assert.Equal(state, MekikA2aServer.StateOf(status));
    }

    [Fact]
    public async Task A2a_a_turn_whose_stream_throws_is_a_failed_task_with_the_warning()
    {
        var spinner = Ilmek.Graph.Create("spin")
            .Channel("input", Ilmek.Channels.LastWrite(""))
            .Channel("reply", Ilmek.Channels.LastWrite(""))
            .Node("s", (Ilmek.State _, Ilmek.IContext _) => Ilmek.Update.Of("reply", "x"))
            .Edge(Ilmek.Graph.Start, "s")
            .Edge("s", "s")
            .Compile();
        var app = new MekikApp(Graphs.Options(spinner) with { RecursionLimit = 2 });

        var reply = await A2a(app).HandleAsync(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "message/send"),
            ("params", D(("message", D(("role", "user"), ("parts", new List<object?> { D(("kind", "text"), ("text", "go")) })))))));

        var task = (Frame)reply!["result"]!;
        var status = (Frame)task["status"]!;
        Assert.Equal("failed", status["state"]);
        var text = (string)((Frame)((IEnumerable<object?>)((Frame)status["message"]!)["parts"]!).First()!)["text"]!;
        Assert.StartsWith("⚠️ ", text);
    }
}
