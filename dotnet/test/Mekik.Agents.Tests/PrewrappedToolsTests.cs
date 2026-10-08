using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// <see cref="Agent.RunAsync"/> with functions mekik already wrapped —
/// <see cref="MekikTools.Wrap"/>, <see cref="McpFunctions.Wrap"/>,
/// <see cref="ClientToolFunctions.Wrap"/> — handed in directly. Each passes through
/// untouched: one <c>tool_call</c> trace per call (not two with different ids), one
/// <c>ai:</c> journal entry for a server/MCP function (none for a client tool, whose
/// answer is the interrupt), and no second execution across a resume. Raw functions
/// are still wrapped with the run's policy. Mirror of the TypeScript prewrapped suite.
/// </summary>
public class PrewrappedToolsTests
{
    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        public List<Frame> Sent { get; } = new();
        public void Send(Frame frame) { Json.Canonicalize(frame); Sent.Add(frame); }
        public void Close(int? code = null, string? reason = null) { }
    }

    /// <summary>A model scripted turn by turn (non-streaming).</summary>
    private sealed class ScriptedChat(params ChatResponseUpdate[][] turns) : IChatClient
    {
        private readonly Queue<ChatResponseUpdate[]> _turns = new(turns);

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(_turns.Dequeue().ToChatResponse());

        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private static ChatResponseUpdate Text(string text) => new(ChatRole.Assistant, text);

    private static ChatResponseUpdate Call(string id, string name, Dictionary<string, object?> args) =>
        new(ChatRole.Assistant, new List<AIContent> { new FunctionCallContent(id, name, args) });

    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    /// <summary>One agent node; <paramref name="journal"/> receives its journal keys each time it finishes.</summary>
    private static MekikApp App(Func<IContext, ValueTask<string>> body, List<List<string>> journal, bool clientTools = false)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State _, IContext ctx) =>
            {
                var reply = await body(ctx);
                journal.Add(ctx.Journal.Select(e => e.Key).ToList());
                return Update.Of("reply", reply);
            })
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();
        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            ClientTools = clientTools ? ClientTools.AcceptAll : null,
        });
    }

    private static List<Frame> Traces(FakeConn c, string name) => c.Sent
        .Where(f => f["type"] as string == "tool_call")
        .Select(f => (Frame)f["data"]!)
        .Where(d => d["name"] as string == name)
        .ToList();

    private static int AiKeys(List<List<string>> journal, string name) =>
        journal[^1].Count(k => k == $"ai:{name}" || k.StartsWith($"ai:{name}#", StringComparison.Ordinal));

    private static string? LastBot(FakeConn c) => c.Sent
        .Where(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot")
        .Select(f => ((Frame)f["data"]!)["text"] as string)
        .LastOrDefault();

    private static ValueTask<string> Run(IContext ctx, IChatClient chat, IReadOnlyList<AIFunction> tools,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null) =>
        Agent.RunAsync(ctx, chat, new AgentRunOptions
        {
            System = "s",
            Input = "go",
            Tools = tools,
            Policies = policies,
            Stream = false,
        });

    [Fact]
    public void Wrap_output_is_marked_and_wrapping_it_again_is_the_identity()
    {
        var raw = AIFunctionFactory.Create((string id) => id, "get_order");
        var ctx = new StubCtx();

        var once = MekikTools.Wrap(ctx, [raw]).Single();
        var twice = MekikTools.Wrap(ctx, [once]).Single();

        Assert.Same(once, twice);
        Assert.True(MekikTools.IsMekikFunction(once));
        Assert.False(MekikTools.IsMekikFunction(raw));
    }

    [Fact]
    public async Task A_server_function_wrapped_with_its_own_policy_is_traced_and_journaled_once_and_keeps_that_policy()
    {
        var ran = 0;
        var getOrder = AIFunctionFactory.Create((string id) => { ran++; return $"order {id}"; }, "get_order");
        var journal = new List<List<string>>();
        var chat = new ScriptedChat([Call("t1", "get_order", new() { ["id"] = "42" })], [Text("done")]);
        var app = App(ctx => Run(ctx, chat,
            MekikTools.Wrap(ctx, [getOrder], new Dictionary<string, ToolPolicy> { ["get_order"] = new() { Redact = ["id"] } }),
            // The run's policy would hide it — the pre-wrapped function keeps its own.
            new Dictionary<string, ToolPolicy> { ["get_order"] = new() { Show = false } }), journal);
        var c = new FakeConn();
        await app.ConnectAsync(c);
        await app.ReceiveAsync(c, D(("type", "text"), ("data", D(("text", "go")))));

        Assert.Equal(1, ran);
        Assert.Equal(["running", "completed"], Traces(c, "get_order").Select(d => d["status"] as string));
        Assert.Equal(MekikTools.Redacted, ((Frame)Traces(c, "get_order")[0]["params"]!)["id"]);
        Assert.Equal(1, AiKeys(journal, "get_order"));
    }

    [Fact]
    public async Task MCP_functions_go_to_RunAsync_directly_traced_and_journaled_once_and_not_rerun_on_resume()
    {
        var invocations = new List<string>();
        RemoteToolInvoker invoke = (name, args, _) =>
        {
            invocations.Add($"{name}:{args["q"]}");
            return Task.FromResult(new RemoteToolResult { Text = "3 hits" });
        };
        var pause = AIFunctionFactory.Create((string id) => "unused", "pause");
        var journal = new List<List<string>>();
        var chat = new ScriptedChat(
            [Call("t1", "github__search", new() { ["q"] = "ilmek" })],
            [Call("t2", "pause", new() { ["id"] = "x" })],
            [Text("found 3")]);
        var app = App(ctx => Run(ctx, chat,
            [.. McpFunctions.Wrap(ctx, [new RemoteToolInfo { Name = "github__search" }], invoke), pause],
            new Dictionary<string, ToolPolicy> { ["pause"] = new() { Approve = new ApproveSpec() } }), journal);
        var c = new FakeConn();
        await app.ConnectAsync(c);
        await app.ReceiveAsync(c, D(("type", "text"), ("data", D(("text", "go")))));
        var interrupt = c.Sent.Single(f => f["type"] as string == "interrupt"); // the raw function keeps the run's approval
        await app.ReceiveAsync(c, D(("type", "resume"), ("answers", D(((string)interrupt["id"]!, D(("approved", false)))))));

        Assert.Equal(["github__search:ilmek"], invocations);
        var search = Traces(c, "github__search");
        Assert.Single(search.Select(d => d["id"]).Distinct());
        Assert.Equal(["running", "completed", "running", "completed"], search.Select(d => d["status"] as string));
        Assert.Equal(1, AiKeys(journal, "github__search"));
        Assert.Equal("found 3", LastBot(c));
    }

    [Fact]
    public async Task Client_tools_go_to_RunAsync_directly_traced_once_never_journaled_and_answered_by_the_resume()
    {
        var journal = new List<List<string>>();
        var chat = new ScriptedChat([Call("t1", "pick_date", new() { ["min"] = "2026-08-01" })], [Text("booked")]);
        var app = App(ctx => Run(ctx, chat, ClientToolFunctions.Wrap(ctx)), journal, clientTools: true);
        var c = new FakeConn();
        await app.ConnectAsync(c, new ConnectParams { Hello = new HelloInfo { Tools = [D(("name", "pick_date"))] } });
        await app.ReceiveAsync(c, D(("type", "text"), ("data", D(("text", "go")))));
        var interrupt = c.Sent.Single(f => f["type"] as string == "interrupt");
        await app.ReceiveAsync(c, D(("type", "resume"), ("answers", D(((string)interrupt["id"]!, D(("ok", true), ("result", "2026-08-15")))))));

        Assert.Single(Traces(c, "pick_date").Select(d => d["id"]).Distinct());
        Assert.Equal(0, AiKeys(journal, "pick_date"));
        Assert.Equal("booked", LastBot(c));
    }
}
