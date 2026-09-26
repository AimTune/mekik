using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

/// <summary>
/// McpFunctions (PROTOCOL.md §13): an MCP toolbox's tools as AIFunctions with the
/// mekik treatment. The toolbox is a stub with Ilmek.Mcp's shape; the assertions
/// are about the wire and the observation the model reads. Mirror of
/// ts/packages/langchain/test/mcp.test.ts.
/// </summary>
public class McpFunctionsTests
{
    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame)
        {
            Json.Canonicalize(frame);
            _sent.Add(frame);
        }
        public void Close(int? code = null, string? reason = null) { }
    }

    private static readonly RemoteToolInfo[] Tools =
    [
        new() { Name = "github__search", Description = "Search repositories.", InputSchema = new Dictionary<string, object?> { ["type"] = "object", ["properties"] = new Dictionary<string, object?> { ["q"] = new Dictionary<string, object?> { ["type"] = "string" } }, ["required"] = new List<object?> { "q" } } },
        new() { Name = "github__delete_repo" },
        new() { Name = "github__broken" },
        new() { Name = "github__structured" },
    ];

    private sealed class Stub
    {
        public List<(string Name, IReadOnlyDictionary<string, object?> Args)> Invocations { get; } = new();
        public Task<RemoteToolResult> Invoke(string name, IReadOnlyDictionary<string, object?> args, CancellationToken ct)
        {
            Invocations.Add((name, args));
            return Task.FromResult(name switch
            {
                "github__search" => new RemoteToolResult { Text = $"hits for {args["q"]}" },
                "github__delete_repo" => new RemoteToolResult { Text = "deleted" },
                "github__broken" => new RemoteToolResult { Text = "permission denied", IsError = true },
                _ => new RemoteToolResult { Text = "", Structured = new Dictionary<string, object?> { ["count"] = 3L } },
            });
        }
    }

    private static MekikApp MakeApp(Func<IContext, ValueTask<string>> body)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State _, IContext ctx) => Update.Of("reply", await body(ctx)))
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();
        return new MekikApp(new MekikOptions { Graph = g, Checkpointer = new InMemoryCheckpointer(), Reply = s => s.GetValueOrDefault("reply") as string });
    }

    private static Dictionary<string, object?> TextFrame(string text) => new() { ["type"] = "text", ["data"] = new Dictionary<string, object?> { ["text"] = text } };

    private static List<IReadOnlyDictionary<string, object?>> Calls(FakeConn c, string name) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "tool_call")
        .Select(f => (IReadOnlyDictionary<string, object?>)f["data"]!)
        .Where(d => d.GetValueOrDefault("name") as string == name)
        .ToList();

    private static string? LastBot(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "text" && (string?)f.GetValueOrDefault("from") == "bot")
        .Select(f => ((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") as string)
        .LastOrDefault();

    [Fact]
    public async Task Keeps_names_descriptions_and_schemas_with_a_default_description()
    {
        var stub = new Stub();
        (string, string)[] seen = [];
        var app = MakeApp(ctx =>
        {
            seen = McpFunctions.Wrap(ctx, Tools, stub.Invoke).Select(f => (f.Name, f.Description)).ToArray();
            return new ValueTask<string>("ok");
        });
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));
        Assert.Equal(("github__search", "Search repositories."), seen[0]);
        Assert.Equal(("github__delete_repo", "The github__delete_repo tool of an MCP server."), seen[1]);
    }

    [Fact]
    public async Task A_call_is_traced_journaled_once_across_a_pause_and_reads_as_the_text()
    {
        var stub = new Stub();
        var app = MakeApp(async ctx =>
        {
            var search = McpFunctions.Wrap(ctx, Tools, stub.Invoke)[0];
            var result = await search.InvokeAsync(new AIFunctionArguments { ["q"] = "ilmek" });
            await Shuttle.Approve<object?>(ctx, new Dictionary<string, object?> { ["title"] = "continue?" });
            return result?.ToString() ?? "";
        });
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));
        var interrupt = conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt");
        await app.ReceiveAsync(conn, new Dictionary<string, object?> { ["type"] = "resume", ["answers"] = new Dictionary<string, object?> { [(string)interrupt["id"]!] = "yes" } });

        Assert.Single(stub.Invocations);
        Assert.Equal(["running", "completed", "running", "completed"], Calls(conn, "github__search").Select(d => (string)d["status"]!));
        Assert.Single(Calls(conn, "github__search").Select(d => d["id"]).Distinct());
        Assert.Equal("hits for ilmek", LastBot(conn));
    }

    [Fact]
    public async Task IsError_and_structured_only_results_become_readable_observations()
    {
        var stub = new Stub();
        string broken = "", structured = "";
        var app = MakeApp(async ctx =>
        {
            var fns = McpFunctions.Wrap(ctx, Tools, stub.Invoke);
            broken = (await fns.Single(f => f.Name == "github__broken").InvokeAsync(new AIFunctionArguments()))?.ToString() ?? "";
            structured = (await fns.Single(f => f.Name == "github__structured").InvokeAsync(new AIFunctionArguments()))?.ToString() ?? "";
            return "ok";
        });
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));
        Assert.Equal("Error from github__broken: permission denied", broken);
        Assert.Equal("""{"count":3}""", structured);
    }

    [Fact]
    public async Task The_policy_map_applies_by_exposed_name()
    {
        var stub = new Stub();
        var app = MakeApp(async ctx =>
        {
            var del = McpFunctions.Wrap(ctx, Tools, stub.Invoke, new Dictionary<string, ToolPolicy> { ["github__delete_repo"] = new() { Approve = new ApproveSpec() } })
                .Single(f => f.Name == "github__delete_repo");
            return (await del.InvokeAsync(new AIFunctionArguments { ["name"] = "old" }))?.ToString() ?? "";
        });
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));
        var interrupt = conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt");
        Assert.Equal("""{"params":{"name":"old"},"title":"Run github__delete_repo?","tool":"github__delete_repo"}""",
            Json.Canonicalize(((IReadOnlyDictionary<string, object?>)interrupt["data"]!)["payload"]));
        Assert.Empty(stub.Invocations);
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume", ["answers"] = new Dictionary<string, object?> { [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = false } },
        });
        Assert.Empty(stub.Invocations);
        Assert.Equal("The user declined to run github__delete_repo.", LastBot(conn));
    }
}
