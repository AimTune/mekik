using System.Runtime.CompilerServices;

using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

/// <summary>
/// Drives <see cref="Agent.RunAsync"/> with a scripted model through a real ilmek
/// graph and the real engine, then asserts on the frames a client would receive:
/// the tool runs and is traced, live text streams as one coalesced bubble, and the
/// consolidated answer is the returned reply. Mirror of the TypeScript runAgent suite.
/// </summary>
public class AgentTests
{
    private sealed class FakeConn : IConnection
    {
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public string Id => "c-1";
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame) { Json.Canonicalize(frame); _sent.Add(frame); }
        public void Close(int? code = null, string? reason = null) { }
    }

    /// <summary>A model scripted turn by turn: each turn is the updates it streams.</summary>
    private sealed class ScriptedChat : IChatClient
    {
        private readonly Queue<IReadOnlyList<ChatResponseUpdate>> _turns;
        public ScriptedChat(params IReadOnlyList<ChatResponseUpdate>[] turns) => _turns = new(turns);

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            Task.FromResult(_turns.Dequeue().ToChatResponse());

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            foreach (var update in _turns.Dequeue())
            {
                await Task.Yield();
                yield return update;
            }
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private static ChatResponseUpdate TextUpdate(string text) => new(ChatRole.Assistant, text);

    private static ChatResponseUpdate CallUpdate(string id, string name, Dictionary<string, object?> args) =>
        new(ChatRole.Assistant, new List<AIContent> { new FunctionCallContent(id, name, args) });

    private static Dictionary<string, object?> TextFrame(string text) => new()
    {
        ["type"] = "text",
        ["data"] = new Dictionary<string, object?> { ["text"] = text },
    };

    private static string? Type(IReadOnlyDictionary<string, object?> f) => f.GetValueOrDefault("type") as string;
    private static IReadOnlyDictionary<string, object?> Data(IReadOnlyDictionary<string, object?> f) =>
        (IReadOnlyDictionary<string, object?>)f["data"]!;

    private static MekikApp AgentApp(IChatClient chat, AIFunction[] tools, bool stream = true)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State state, IContext ctx) =>
                Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
                {
                    System = "You are a test agent.",
                    Input = state.Get<string>("input") ?? string.Empty,
                    Tools = tools,
                    Stream = stream,
                })))
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();

        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
        });
    }

    private static string GenuiText(FakeConn conn) => string.Concat(conn.Sent
        .Where(f => Type(f) == "genui")
        .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
        .Where(c => c.GetValueOrDefault("type") as string == "text")
        .Select(c => c["content"] as string));

    private static IReadOnlyList<int> GenuiTextIds(FakeConn conn) => conn.Sent
        .Where(f => Type(f) == "genui")
        .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
        .Where(c => c.GetValueOrDefault("type") as string == "text")
        .Select(c => Convert.ToInt32(c["id"]))
        .Distinct()
        .ToList();

    private static int BotTextFrameCount(FakeConn conn) => conn.Sent.Count(f => Type(f) == "text");

    [Fact]
    public async Task Streams_the_answer_live_as_one_bubble_without_a_duplicate_reply()
    {
        // Returns a dict → AIFunctionFactory marshals it to a JsonElement, exercising the
        // canonicalize path (FakeConn.Send would throw otherwise).
        var getOrder = AIFunctionFactory.Create(
            (string id) => new Dictionary<string, object?> { ["id"] = id, ["total"] = 249.9 },
            "get_order", "Look up an order");

        var chat = new ScriptedChat(
            [CallUpdate("c1", "get_order", new Dictionary<string, object?> { ["id"] = "ORD-42" })],
            [TextUpdate("Order total is "), TextUpdate("249.9.")]);

        var app = AgentApp(chat, [getOrder]); // stream: true (default)
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("what's my order total?"));

        // The tool the model asked for ran and is traced running → completed.
        var statuses = conn.Sent.Where(f => Type(f) == "tool_call")
            .Select(f => Data(f))
            .Where(d => d.GetValueOrDefault("name") as string == "get_order")
            .Select(d => d["status"] as string)
            .ToList();
        Assert.Equal(["running", "completed"], statuses);

        // The answer streamed as genui text under ONE text-run id (one growing bubble)…
        Assert.Equal("Order total is 249.9.", GenuiText(conn));
        Assert.Single(GenuiTextIds(conn));
        // …and it is NOT re-sent as a consolidated bot `text` frame (no duplicate).
        Assert.Equal(0, BotTextFrameCount(conn));
    }

    [Fact]
    public async Task Without_streaming_the_answer_is_one_consolidated_text_reply()
    {
        var chat = new ScriptedChat([TextUpdate("Hello there.")]);

        var app = AgentApp(chat, [], stream: false);
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("hi"));

        // Not streamed → no genui text, one durable bot text frame.
        Assert.Equal("", GenuiText(conn));
        var reply = conn.Sent.Where(f => Type(f) == "text")
            .Select(f => Data(f).GetValueOrDefault("text") as string)
            .LastOrDefault();
        Assert.Equal("Hello there.", reply);
    }

    // ── route ───────────────────────────────────────────────────────────────────

    private static readonly IReadOnlyList<Route> Routes =
    [
        new Route("reporting", "sprint reports and metrics"),
        new Route("general", "everything else"),
    ];

    private static MekikApp RouteApp(IChatClient chat, string? fallback = null)
    {
        var g = Graph.Create("router")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("route", async (State state, IContext ctx) =>
                Update.Of("reply", await Agent.RouteAsync(ctx, chat, Routes, state.Get<string>("input") ?? string.Empty, fallback)))
            .Edge(Graph.Start, "route")
            .Edge("route", Graph.End)
            .Compile();

        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
        });
    }

    private static string? Reply(FakeConn conn) => conn.Sent
        .Where(f => Type(f) == "text")
        .Select(f => Data(f).GetValueOrDefault("text") as string)
        .LastOrDefault();

    [Fact]
    public async Task Route_classifies_the_input_into_one_of_the_routes()
    {
        var app = RouteApp(new ScriptedChat([TextUpdate("reporting")]));
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("show me the sprint report"));
        Assert.Equal("reporting", Reply(conn));
    }

    [Fact]
    public async Task Route_falls_back_when_the_model_answers_off_list()
    {
        var app = RouteApp(new ScriptedChat([TextUpdate("banana")]), fallback: "general");
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("??"));
        Assert.Equal("general", Reply(conn));
    }
}
