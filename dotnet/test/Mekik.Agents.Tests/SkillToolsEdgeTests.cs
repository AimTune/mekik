using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

/// <summary>
/// AgentRunOptions.SkillTools at the edges SkillToolsTests leaves open, plus the agent
/// loop's handling of a tool call that fails: a skill the catalog does not know, a skill
/// the node's filter hides (with an explicit load attempt), a skill that is listed but
/// cannot be loaded, loading the same skill twice, unlocking two skills in one round, the
/// offered set across two interrupt/resume cycles, and calls whose arguments fail binding
/// or whose function throws. Mirror of ts/packages/langchain/test/skill-tools-edges.test.ts.
/// </summary>
public class SkillToolsEdgeTests
{
    private sealed class FakeConn : IConnection
    {
        public string Id => "ste-1";
        public List<IReadOnlyDictionary<string, object?>> Sent { get; } = new();
        public void Send(IReadOnlyDictionary<string, object?> frame) => Sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    /// <summary>A scripted model recording the tools offered on each call and every observation it was shown.</summary>
    private sealed class ScriptedChat(params IReadOnlyList<ChatResponseUpdate>[] turns) : IChatClient
    {
        private readonly Queue<IReadOnlyList<ChatResponseUpdate>> _turns = new(turns);
        public List<List<string>> Offered { get; } = [];
        public List<string> Observations { get; } = [];

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            Offered.Add((options?.Tools ?? []).Select(t => t.Name).ToList());
            Observations.Clear();
            Observations.AddRange(messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.Result?.ToString() ?? ""));
            return Task.FromResult(_turns.Dequeue().ToChatResponse());
        }

        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException("these tests run with Stream = false");

        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    /// <summary>Lists a skill it cannot hand back — a catalog whose listing and lookup disagree.</summary>
    private sealed class BrokenSource : ISkillSource
    {
        public IReadOnlyList<SkillSummary> List() => [new SkillSummary { Name = "reporting", Description = "Sprint numbers." }];
        public SkillEntry? Get(string name) => null;
    }

    private sealed class Counters
    {
        public int Sprint;
        public int Refund;
        public int Lookup;
    }

    private static readonly SkillEntry Reporting = new() { Name = "reporting", Description = "Sprint numbers.", Instructions = "Use the sprint tools." };
    private static readonly SkillEntry Billing = new() { Name = "billing", Description = "Refunds.", Instructions = "Refund carefully." };
    private static readonly SkillEntry Docs = new() { Name = "docs", Description = "Docs.", Instructions = "Read docs.", Tags = ["docs"] };

    private static ChatResponseUpdate Text(string text) => new(ChatRole.Assistant, text);
    private static ChatResponseUpdate Call(string id, string name, Dictionary<string, object?>? args = null) =>
        new(ChatRole.Assistant, new List<AIContent> { new FunctionCallContent(id, name, args ?? new()) });
    private static ChatResponseUpdate Load(string id, string skill) => Call(id, "load_skill", new() { ["name"] = skill });

    private static (AIFunction Sprint, AIFunction Refund, AIFunction Lookup, AIFunction Explode) Tools(Counters c) => (
        AIFunctionFactory.Create(() => { c.Sprint++; return "velocity 42"; }, "get_sprint", "Sprint metrics."),
        AIFunctionFactory.Create(() => { c.Refund++; return "refunded"; }, "refund", "Refund a payment."),
        AIFunctionFactory.Create((int qty) => { c.Lookup++; return $"qty {qty}"; }, "lookup_order", "Look up an order line."),
        AIFunctionFactory.Create(string () => throw new InvalidOperationException("upstream down"), "explode", "Always fails."));

    private static MekikApp App(
        IChatClient chat,
        AIFunction[]? tools = null,
        Dictionary<string, IReadOnlyList<AIFunction>>? skillTools = null,
        IReadOnlyList<string>? skillTags = null,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null,
        ISkillSource? catalog = null)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State state, IContext ctx) =>
                Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
                {
                    System = "test",
                    Input = state.Get<string>("input") ?? string.Empty,
                    Tools = tools ?? [],
                    Stream = false,
                    Skills = true,
                    SkillTags = skillTags,
                    SkillTools = skillTools,
                    Policies = policies,
                })))
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();
        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            Skills = catalog ?? SkillSources.Inline(Reporting, Billing, Docs),
        });
    }

    private static async Task<FakeConn> Run(MekikApp app)
    {
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, new Dictionary<string, object?> { ["type"] = "text", ["data"] = new Dictionary<string, object?> { ["text"] = "go" } });
        return conn;
    }

    private static Task Resume(MekikApp app, FakeConn conn, IReadOnlyDictionary<string, object?> interrupt) =>
        app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?> { [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = true } },
        });

    private static string? Type(IReadOnlyDictionary<string, object?> f) => f.GetValueOrDefault("type") as string;
    private static IReadOnlyDictionary<string, object?> Data(IReadOnlyDictionary<string, object?> f) => (IReadOnlyDictionary<string, object?>)f["data"]!;
    private static List<string> Runs(FakeConn c) => c.Sent.Where(f => Type(f) == "run").Select(f => (string)Data(f)["status"]!).ToList();
    private static List<string> Traces(FakeConn c, string name) =>
        c.Sent.Where(f => Type(f) == "tool_call" && (string?)Data(f)["name"] == name).Select(f => (string)Data(f)["status"]!).ToList();

    [Fact]
    public async Task Tools_held_under_a_skill_the_catalog_does_not_know_are_never_offered_nor_run()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat([Load("1", "ghost")], [Call("2", "get_sprint")], [Text("done")]);
        var conn = await Run(App(chat, skillTools: new() { ["ghost"] = [t.Sprint] }));

        Assert.All(chat.Offered, o => Assert.DoesNotContain("get_sprint", o));
        Assert.Equal(0, c.Sprint);
        Assert.Contains(chat.Observations, o => o.StartsWith("Unknown skill \"ghost\""));
        Assert.Contains("Unknown tool get_sprint.", chat.Observations);
        Assert.Equal(["started", "finished"], Runs(conn));
    }

    [Fact]
    public async Task A_skill_the_filter_hides_refuses_an_explicit_load_and_its_tool_stays_unknown()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat([Load("1", "docs"), Call("2", "get_sprint")], [Text("done")]);
        var conn = await Run(App(chat, skillTools: new() { ["docs"] = [t.Sprint] }, skillTags: ["ops"]));

        Assert.Equal(0, c.Sprint);
        Assert.StartsWith("Unknown skill \"docs\"", chat.Observations[0]);
        Assert.Equal("Unknown tool get_sprint.", chat.Observations[1]);
        Assert.All(chat.Offered, o => Assert.DoesNotContain("get_sprint", o));
        Assert.DoesNotContain(conn.Sent, f => Type(f) == "skill");
    }

    [Fact]
    public async Task A_skill_listed_but_not_loadable_does_not_unlock_its_tools()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat([Load("1", "reporting")], [Call("2", "get_sprint")], [Text("done")]);
        await Run(App(chat, skillTools: new() { ["reporting"] = [t.Sprint] }, catalog: new BrokenSource()));

        Assert.DoesNotContain("get_sprint", chat.Offered[1]);
        Assert.Equal(0, c.Sprint);
        Assert.Contains(chat.Observations, o => o.Contains("belongs to skill \"reporting\""));
    }

    [Fact]
    public async Task Loading_the_same_skill_twice_offers_each_tool_once()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat([Load("1", "reporting")], [Load("2", "reporting")], [Call("3", "get_sprint")], [Text("done")]);
        await Run(App(chat, skillTools: new() { ["reporting"] = [t.Sprint] }));

        Assert.All(chat.Offered.Skip(1), o => Assert.Single(o, n => n == "get_sprint"));
        Assert.Equal(chat.Offered[1], chat.Offered[2]);
        Assert.Equal(1, c.Sprint);
    }

    [Fact]
    public async Task Two_skills_unlocked_in_one_round_are_both_offered_next_round_a_shared_tool_once()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat(
            [Load("1", "reporting"), Load("2", "billing")],
            [Call("3", "get_sprint"), Call("4", "refund")],
            [Text("done")]);
        await Run(App(chat, skillTools: new() { ["reporting"] = [t.Sprint, t.Refund], ["billing"] = [t.Refund] }));

        Assert.DoesNotContain("get_sprint", chat.Offered[0]);
        Assert.DoesNotContain("refund", chat.Offered[0]);
        Assert.Equal(["get_sprint", "refund"], chat.Offered[1].Where(n => n is "get_sprint" or "refund").Order().ToArray());
        Assert.Equal((1, 1), (c.Sprint, c.Refund));
    }

    [Fact]
    public async Task The_offered_set_is_rebuilt_identically_across_two_interrupt_resume_cycles()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat(
            [Load("1", "reporting")], [Call("2", "get_sprint")], [Load("3", "billing")], [Call("4", "refund")], [Text("done")]);
        var app = App(chat,
            skillTools: new() { ["reporting"] = [t.Sprint], ["billing"] = [t.Refund] },
            policies: new Dictionary<string, ToolPolicy>
            {
                ["get_sprint"] = new() { Approve = new ApproveSpec() },
                ["refund"] = new() { Approve = new ApproveSpec() },
            });

        var conn = await Run(app);
        await Resume(app, conn, conn.Sent.Where(f => Type(f) == "interrupt").ElementAt(0));
        var interrupts = conn.Sent.Where(f => Type(f) == "interrupt").ToList();
        Assert.Equal(2, interrupts.Count);
        Assert.NotEqual(interrupts[0]["id"], interrupts[1]["id"]);
        await Resume(app, conn, interrupts[1]);

        Assert.Equal((1, 1), (c.Sprint, c.Refund));
        Assert.Equal(["started", "interrupted", "started", "interrupted", "started", "finished"], Runs(conn));
        Assert.Equal(5, chat.Offered.Count);
        Assert.Contains("get_sprint", chat.Offered[4]);
        Assert.Contains("refund", chat.Offered[4]);
        Assert.DoesNotContain(chat.Observations, o => o.Contains("belongs to skill"));
    }

    [Fact]
    public async Task Arguments_that_fail_binding_are_an_observation_with_an_error_trace_and_the_loop_continues()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "lookup_order", new() { ["qty"] = "lots" })],
            [Call("2", "lookup_order", new() { ["qty"] = 3 })],
            [Text("done")]);
        var conn = await Run(App(chat, tools: [t.Lookup]));

        Assert.Equal(["started", "finished"], Runs(conn));
        Assert.Equal(1, c.Lookup);
        Assert.StartsWith("Error from lookup_order: ", chat.Observations[0]);
        Assert.Equal("qty 3", chat.Observations[1]);
        Assert.Equal(["running", "error", "running", "completed"], Traces(conn, "lookup_order"));
    }

    [Fact]
    public async Task A_function_that_throws_is_an_observation_not_a_crashed_run()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat([Call("1", "explode")], [Text("sorry")]);
        var conn = await Run(App(chat, tools: [t.Explode]));

        Assert.Equal(["started", "finished"], Runs(conn));
        Assert.Equal(["Error from explode: upstream down"], chat.Observations);
        Assert.Equal(["running", "error"], Traces(conn, "explode"));
    }

    [Fact]
    public async Task An_approval_interrupt_still_parks_the_run()
    {
        var c = new Counters();
        var t = Tools(c);
        var chat = new ScriptedChat([Call("1", "refund")], [Text("done")]);
        var conn = await Run(App(chat, tools: [t.Refund],
            policies: new Dictionary<string, ToolPolicy> { ["refund"] = new() { Approve = new ApproveSpec() } }));

        Assert.Equal(["started", "interrupted"], Runs(conn));
    }
}
