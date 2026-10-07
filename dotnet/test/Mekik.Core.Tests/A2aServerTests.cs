using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// mekik as an A2A agent (PROTOCOL.md §14). The Agent Card and the JSON-RPC surface
/// are pinned by conformance/a2a/rpc.json (shared with TypeScript); the task mapping
/// is driven through a real app here. Mirror of ts/packages/core/test/a2a.test.ts.
/// </summary>
public class A2aServerTests
{
    private static readonly string Fixture = Path.Combine(AppContext.BaseDirectory, "a2a", "rpc.json");

    private static readonly CompiledGraph Desk = Graph.Create("desk")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("agent", async (State s, IContext ctx) =>
        {
            var input = s.Get<string>("input");
            if (input == "boom") throw new InvalidOperationException("kaboom");
            var order = await Shuttle.Tool(ctx, "get_order", new Dictionary<string, object?> { ["id"] = "ORD-42" },
                () => new Dictionary<string, object?> { ["id"] = "ORD-42", ["total"] = 249.9 });
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

    /// <summary>Two nodes pause in the same superstep — two concurrent interrupts on one task.</summary>
    private static readonly CompiledGraph Pair = Graph.Create("pair")
        .Channel("input", Channels.LastWrite(""))
        .Channel("log", Channels.Append())
        .Node("a", async (State _, IContext ctx) => Update.Of("log", new List<object?> { await Shuttle.Approve<string>(ctx, new Dictionary<string, object?> { ["q"] = "first?" }) }))
        .Node("b", async (State _, IContext ctx) => Update.Of("log", new List<object?> { await Shuttle.Approve<string>(ctx, new Dictionary<string, object?> { ["q"] = "second?" }) }))
        .Edge(Graph.Start, "a").Edge(Graph.Start, "b").Edge("a", Graph.End).Edge("b", Graph.End)
        .Compile();

    private static MekikApp App(CompiledGraph? graph = null) => new(new MekikOptions
    {
        Graph = graph ?? Desk,
        Checkpointer = new InMemoryCheckpointer(),
        Reply = s => graph == Pair
            ? string.Join("+", ((IEnumerable<object?>)(s.GetValueOrDefault("log") ?? new List<object?>())).Cast<string>())
            : s.GetValueOrDefault("reply") as string,
    });

    private static int _seq;

    private static (A2aServerOptions Options, object? Card, List<IReadOnlyDictionary<string, object?>> Cases) LoadFixture()
    {
        var f = (IReadOnlyDictionary<string, object?>)Json.Parse(File.ReadAllText(Fixture))!;
        var o = (IReadOnlyDictionary<string, object?>)f["options"]!;
        var options = new A2aServerOptions
        {
            Name = (string)o["name"]!,
            Description = o.GetValueOrDefault("description") as string,
            Url = (string)o["url"]!,
            Version = o.GetValueOrDefault("version") as string,
            Skills = ((IEnumerable<object?>)o["skills"]!).Cast<IReadOnlyDictionary<string, object?>>().Select(s => new SkillSummary
            {
                Name = (string)s["name"]!, Description = (string)s["description"]!,
                Tags = (s.GetValueOrDefault("tags") as IEnumerable<object?>)?.Cast<string>().ToList(),
            }).ToList(),
        };
        return (options, f["agentCard"], ((IEnumerable<object?>)f["cases"]!).Cast<IReadOnlyDictionary<string, object?>>().ToList());
    }

    private static MekikA2aServer Agent(MekikApp? app = null)
    {
        var (options, _, _) = LoadFixture();
        return new MekikA2aServer(app ?? App(), options with { Now = () => 1750000000000, MintId = kind => $"{kind}-{Interlocked.Increment(ref _seq)}" });
    }

    private static Dictionary<string, object?> UserMessage(string text, string? taskId = null, string? contextId = null)
    {
        var m = new Dictionary<string, object?>
        {
            ["role"] = "user", ["messageId"] = $"m-{Interlocked.Increment(ref _seq)}",
            ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "text", ["text"] = text } },
        };
        if (taskId is not null) m["taskId"] = taskId;
        if (contextId is not null) m["contextId"] = contextId;
        return m;
    }

    private static Dictionary<string, object?> Params(Dictionary<string, object?> message) => new() { ["message"] = message };
    private static string State(IReadOnlyDictionary<string, object?> task) => (string)((IReadOnlyDictionary<string, object?>)task["status"]!)["state"]!;
    private static IReadOnlyDictionary<string, object?>? StatusMessage(IReadOnlyDictionary<string, object?> task) =>
        ((IReadOnlyDictionary<string, object?>)task["status"]!).GetValueOrDefault("message") as IReadOnlyDictionary<string, object?>;
    private static string FirstText(IReadOnlyDictionary<string, object?> message) =>
        (string)((IReadOnlyDictionary<string, object?>)((IEnumerable<object?>)message["parts"]!).First()!)["text"]!;
    private static List<object?> History(IReadOnlyDictionary<string, object?> task) => ((IEnumerable<object?>)task["history"]!).ToList();
    private static string LastArtifactText(IReadOnlyDictionary<string, object?> task)
    {
        var artifact = (IReadOnlyDictionary<string, object?>)((IEnumerable<object?>)task["artifacts"]!).Last()!;
        return FirstText(artifact);
    }

    // ── conformance/a2a/rpc.json ──────────────────────────────────────────────

    [Fact]
    public void The_agent_card_matches_the_shared_fixture()
    {
        var (_, card, _) = LoadFixture();
        Assert.Equal(Json.Canonicalize(card), Json.Canonicalize(Agent().AgentCard()));
    }

    public static IEnumerable<object[]> RpcCases() =>
        LoadFixture().Cases.Select(c => new object[] { c["name"]!, c.GetValueOrDefault("request")!, c.GetValueOrDefault("response")! });

    [Theory]
    [MemberData(nameof(RpcCases))]
    public async Task Rpc_surface_matches_the_shared_fixture(string name, object? request, object? response)
    {
        var actual = await Agent().HandleAsync(request);
        Assert.True(Json.Canonicalize(response) == Json.Canonicalize(actual), $"{name}: got {Json.Canonicalize(actual)}");
    }

    [Fact]
    public void The_constructor_validates_name_and_url()
    {
        Assert.Throws<ArgumentException>(() => new MekikA2aServer(App(), new A2aServerOptions { Name = "", Url = "http://x" }));
        Assert.Throws<ArgumentException>(() => new MekikA2aServer(App(), new A2aServerOptions { Name = "x", Url = "" }));
    }

    // ── message/send ──────────────────────────────────────────────────────────

    [Fact]
    public async Task A_finished_turn_is_a_completed_task_with_the_reply_as_an_artifact()
    {
        var task = await Agent().SendMessageAsync(Params(UserMessage("where is my order?")));
        Assert.Equal("task", task["kind"]);
        Assert.Equal("completed", State(task));
        Assert.Equal("2025-06-15T15:06:40.000Z", ((IReadOnlyDictionary<string, object?>)task["status"]!)["timestamp"]);
        Assert.Null(StatusMessage(task));
        Assert.StartsWith("conv-", (string)task["contextId"]!);
        Assert.Equal("Order ORD-42 totals 249.9.", LastArtifactText(task));
        var history = History(task);
        Assert.Single(history);
        Assert.Equal(task["id"], ((IReadOnlyDictionary<string, object?>)history[0]!)["taskId"]);
        var mekik = (IReadOnlyDictionary<string, object?>)((IReadOnlyDictionary<string, object?>)task["metadata"]!)["mekik"]!;
        Assert.Equal("finished", mekik["status"]);
    }

    [Fact]
    public async Task ContextId_continues_the_conversation_and_each_turn_is_its_own_task()
    {
        var a = Agent();
        var first = await a.SendMessageAsync(Params(UserMessage("hi")));
        var second = await a.SendMessageAsync(Params(UserMessage("again", contextId: (string)first["contextId"]!)));
        Assert.Equal(first["contextId"], second["contextId"]);
        Assert.NotEqual(first["id"], second["id"]);
    }

    [Fact]
    public async Task A_paused_turn_is_input_required_and_a_text_reply_resumes_it()
    {
        var a = Agent();
        var paused = await a.SendMessageAsync(Params(UserMessage("refund please")));
        Assert.Equal("input-required", State(paused));
        var status = StatusMessage(paused)!;
        Assert.Equal("agent", status["role"]);
        Assert.Equal(paused["id"], status["taskId"]);
        Assert.Contains("needs input before it can continue", FirstText(status));
        Assert.Contains("options: Approve, Cancel", FirstText(status));
        var pending = ((IEnumerable<object?>)((IReadOnlyDictionary<string, object?>)paused["metadata"]!)["pending"]!).ToList();
        Assert.Single(pending);

        var done = await a.SendMessageAsync(Params(UserMessage("Approve", taskId: (string)paused["id"]!)));
        Assert.Equal(paused["id"], done["id"]);
        Assert.Equal("completed", State(done));
        Assert.Equal("Refunded.", LastArtifactText(done));
        Assert.Equal(3, History(done).Count);
        Assert.False(((IReadOnlyDictionary<string, object?>)done["metadata"]!).ContainsKey("pending"));
    }

    [Fact]
    public async Task A_data_part_with_answers_resolves_several_interrupts_and_text_alone_is_refused()
    {
        var a = Agent(App(Pair));
        var paused = await a.SendMessageAsync(Params(UserMessage("two please")));
        Assert.Equal("input-required", State(paused));
        var pending = ((IEnumerable<object?>)((IReadOnlyDictionary<string, object?>)paused["metadata"]!)["pending"]!).Cast<IReadOnlyDictionary<string, object?>>().ToList();
        Assert.Equal(2, pending.Count);

        var ex = await Assert.ThrowsAsync<A2aRequestException>(() => a.SendMessageAsync(Params(UserMessage("yes", taskId: (string)paused["id"]!))));
        Assert.Contains("2 open interrupts; answer them all", ex.Message);

        var answers = new Dictionary<string, object?> { [(string)pending[0]["id"]!] = "A", [(string)pending[1]["id"]!] = "B" };
        var done = await a.SendMessageAsync(Params(new Dictionary<string, object?>
        {
            ["role"] = "user", ["taskId"] = paused["id"],
            ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "data", ["data"] = new Dictionary<string, object?> { ["answers"] = answers } } },
        }));
        Assert.Equal("completed", State(done));
        Assert.Matches("^(A\\+B|B\\+A)$", LastArtifactText(done));
    }

    [Fact]
    public async Task A_message_on_a_completed_task_is_refused()
    {
        var a = Agent();
        var done = await a.SendMessageAsync(Params(UserMessage("hi")));
        var ex = await Assert.ThrowsAsync<A2aRequestException>(() => a.SendMessageAsync(Params(UserMessage("more", taskId: (string)done["id"]!))));
        Assert.Contains("is completed and takes no more input", ex.Message);
    }

    [Fact]
    public async Task A_graph_error_is_failed_and_a_turn_on_a_parked_conversation_is_rejected()
    {
        var a = Agent();
        var failed = await a.SendMessageAsync(Params(UserMessage("boom")));
        Assert.Equal("failed", State(failed));
        Assert.Contains("agent: kaboom", FirstText(StatusMessage(failed)!));

        var paused = await a.SendMessageAsync(Params(UserMessage("refund please")));
        var rejected = await a.SendMessageAsync(Params(UserMessage("hello?", contextId: (string)paused["contextId"]!)));
        Assert.Equal("rejected", State(rejected));
        Assert.StartsWith("interrupted: answer the open interrupt", FirstText(StatusMessage(rejected)!));
    }

    // ── tasks/get and tasks/cancel ────────────────────────────────────────────

    [Fact]
    public async Task Get_returns_the_task_and_historyLength_truncates()
    {
        var a = Agent();
        var paused = await a.SendMessageAsync(Params(UserMessage("refund please")));
        var done = await a.SendMessageAsync(Params(UserMessage("Cancel", taskId: (string)paused["id"]!)));
        var id = (string)done["id"]!;
        Assert.Equal(3, History(await a.GetTaskAsync(id)).Count);
        Assert.Single(History(await a.GetTaskAsync(id, 1)));
        Assert.Empty(History(await a.GetTaskAsync(id, 0)));
        var viaRpc = await a.HandleAsync(new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0", ["id"] = 1L, ["method"] = "tasks/get", ["params"] = new Dictionary<string, object?> { ["id"] = id, ["historyLength"] = 2L },
        });
        Assert.Equal(2, History((IReadOnlyDictionary<string, object?>)viaRpc!["result"]!).Count);
    }

    [Fact]
    public async Task Cancel_marks_an_input_required_task_canceled_and_refuses_a_completed_one()
    {
        var a = Agent();
        var paused = await a.SendMessageAsync(Params(UserMessage("refund please")));
        var canceled = await a.CancelTaskAsync((string)paused["id"]!);
        Assert.Equal("canceled", State(canceled));
        Assert.Equal("canceled", State(await a.GetTaskAsync((string)paused["id"]!)));
        var done = await a.SendMessageAsync(Params(UserMessage("hi")));
        var err = await a.HandleAsync(new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0", ["id"] = 1L, ["method"] = "tasks/cancel", ["params"] = new Dictionary<string, object?> { ["id"] = done["id"] },
        });
        Assert.Equal(-32002L, ((IReadOnlyDictionary<string, object?>)err!["error"]!)["code"]);
    }

    // ── pure helpers ──────────────────────────────────────────────────────────

    [Fact]
    public void AnswersFor_label_text_data_and_explicit_answers()
    {
        var pending = new List<IReadOnlyDictionary<string, object?>>
        {
            new Dictionary<string, object?>
            {
                ["id"] = "p1", ["payload"] = new Dictionary<string, object?>(),
                ["actions"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } },
                    new Dictionary<string, object?> { ["label"] = "Cancel" },
                },
            },
        };
        Dictionary<string, object?> Msg(params object?[] parts) => new() { ["parts"] = parts.ToList() };
        Dictionary<string, object?> Text(string t) => new() { ["kind"] = "text", ["text"] = t };
        Dictionary<string, object?> Data(Dictionary<string, object?> d) => new() { ["kind"] = "data", ["data"] = d };

        Assert.Equal("""{"p1":{"approved":true}}""", Json.Canonicalize(MekikA2aServer.AnswersFor(Msg(Text("Approve")), pending)));
        Assert.Equal("""{"p1":"Cancel"}""", Json.Canonicalize(MekikA2aServer.AnswersFor(Msg(Text("Cancel")), pending)));
        Assert.Equal("""{"p1":"maybe later"}""", Json.Canonicalize(MekikA2aServer.AnswersFor(Msg(Text("maybe later")), pending)));
        Assert.Equal("""{"p1":{"approved":false}}""", Json.Canonicalize(MekikA2aServer.AnswersFor(Msg(Data(new() { ["approved"] = false })), pending)));
        Assert.Equal("""{"p1":1,"p2":2}""", Json.Canonicalize(MekikA2aServer.AnswersFor(Msg(Data(new() { ["answers"] = new Dictionary<string, object?> { ["p1"] = 1L, ["p2"] = 2L } })), pending)));
        Assert.Throws<A2aRequestException>(() => MekikA2aServer.AnswersFor(Msg(Text("x")), []));
        Assert.Throws<A2aRequestException>(() => MekikA2aServer.AnswersFor(Msg(new Dictionary<string, object?> { ["kind"] = "file", ["file"] = new Dictionary<string, object?>() }), pending));
    }

    [Fact]
    public void ParseMessage_validates_and_mints_a_messageId()
    {
        var m = MekikA2aServer.ParseMessage(new Dictionary<string, object?>
        {
            ["role"] = "user",
            ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "text", ["text"] = "hi" }, new Dictionary<string, object?> { ["kind"] = "data", ["data"] = new Dictionary<string, object?> { ["a"] = 1L } } },
        });
        Assert.StartsWith("message-", (string)m["messageId"]!);
        Assert.Equal(2, ((IEnumerable<object?>)m["parts"]!).Count());
        Assert.Throws<A2aRequestException>(() => MekikA2aServer.ParseMessage(new Dictionary<string, object?> { ["role"] = "bot", ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "text", ["text"] = "x" } } }));
        Assert.Throws<A2aRequestException>(() => MekikA2aServer.ParseMessage(new Dictionary<string, object?> { ["role"] = "user", ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "audio" } } }));
        Assert.Throws<A2aRequestException>(() => MekikA2aServer.ParseMessage(new Dictionary<string, object?> { ["role"] = "user", ["taskId"] = 5L, ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "text", ["text"] = "x" } } }));
    }
}
