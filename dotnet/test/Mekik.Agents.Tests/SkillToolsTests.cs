using System.Runtime.CompilerServices;

using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

/// <summary>
/// AgentRunOptions.SkillTools — tools held under a skill: hidden from the model until it
/// loads the skill, then offered for the rest of the run; a premature call is refused as an
/// observation; the active set survives an interrupt/resume. Driven through the real engine.
/// Mirror of ts/packages/langchain/test/skill-tools.test.ts.
/// </summary>
public class SkillToolsTests
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

    /// <summary>A scripted model that records which tools each call offered and the tool observations it saw.</summary>
    private sealed class ScriptedChat(params IReadOnlyList<ChatResponseUpdate>[] turns) : IChatClient
    {
        private readonly Queue<IReadOnlyList<ChatResponseUpdate>> _turns = new(turns);
        public List<List<string>> Offered { get; } = [];
        public List<string> Observations { get; } = [];

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            Record(messages, options);
            return Task.FromResult(_turns.Dequeue().ToChatResponse());
        }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            Record(messages, options);
            foreach (var update in _turns.Dequeue())
            {
                await Task.Yield();
                yield return update;
            }
        }

        private void Record(IEnumerable<ChatMessage> messages, ChatOptions? options)
        {
            Offered.Add((options?.Tools ?? []).Select(t => t.Name).ToList());
            Observations.Clear();
            Observations.AddRange(messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().Select(r => r.Result?.ToString() ?? ""));
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    private sealed class Counters
    {
        public int Sprint;
        public int Refund;
    }

    private static readonly SkillEntry Reporting = new() { Name = "reporting", Description = "Sprint numbers.", Instructions = "Use the sprint tools." };
    private static readonly SkillEntry Docs = new() { Name = "docs", Description = "Docs.", Instructions = "Read docs.", Tags = ["docs"] };

    private static ChatResponseUpdate Text(string text) => new(ChatRole.Assistant, text);

    private static ChatResponseUpdate Call(string id, string name, Dictionary<string, object?>? args = null) =>
        new(ChatRole.Assistant, new List<AIContent> { new FunctionCallContent(id, name, args ?? new()) });

    private static string? Type(IReadOnlyDictionary<string, object?> f) => f.GetValueOrDefault("type") as string;
    private static IReadOnlyDictionary<string, object?> Data(IReadOnlyDictionary<string, object?> f) =>
        (IReadOnlyDictionary<string, object?>)f["data"]!;

    private static (AIFunction Today, AIFunction Sprint, AIFunction Refund) Tools(Counters c) => (
        AIFunctionFactory.Create(() => "2026-10-07", "today", "Today's date."),
        AIFunctionFactory.Create(() => { c.Sprint++; return "velocity 42"; }, "get_sprint", "Sprint metrics."),
        AIFunctionFactory.Create(() => { c.Refund++; return "refunded"; }, "refund", "Refund a payment."));

    private static MekikApp App(
        IChatClient chat,
        AIFunction[] tools,
        Dictionary<string, IReadOnlyList<AIFunction>> skillTools,
        IReadOnlyList<string>? skillTags = null,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null)
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
            Skills = SkillSources.Inline(Reporting, Docs),
        });
    }

    private static async Task<FakeConn> Run(MekikApp app, string input = "go")
    {
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, new Dictionary<string, object?> { ["type"] = "text", ["data"] = new Dictionary<string, object?> { ["text"] = input } });
        return conn;
    }

    [Fact]
    public async Task Skill_tools_are_offered_only_after_load_skill_and_the_load_names_them()
    {
        var c = new Counters();
        var (today, sprint, _) = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "get_sprint")],
            [Text("Velocity is 42.")]);

        var conn = await Run(App(chat, [today], new() { ["reporting"] = [sprint] }));

        Assert.Equal(["today", "load_skill"], chat.Offered[0]);
        Assert.Equal(["today", "load_skill", "get_sprint"], chat.Offered[1]);
        Assert.Equal(["today", "load_skill", "get_sprint"], chat.Offered[2]);
        Assert.Contains("Tools now available from skill reporting: get_sprint.", string.Join("\n", chat.Observations));
        Assert.Equal(1, c.Sprint);
        Assert.Contains(conn.Sent, f => Type(f) == "skill" && (string?)Data(f)["name"] == "reporting");
        Assert.Contains(conn.Sent, f => Type(f) == "tool_call" && (string?)Data(f)["name"] == "get_sprint");
    }

    [Fact]
    public async Task A_skill_tool_called_before_its_skill_is_loaded_is_refused_without_running()
    {
        var c = new Counters();
        var (today, sprint, _) = Tools(c);
        var chat = new ScriptedChat([Call("1", "get_sprint")], [Text("ok")]);

        await Run(App(chat, [today], new() { ["reporting"] = [sprint] }));

        Assert.Equal(0, c.Sprint);
        Assert.Contains(chat.Observations, o => o.Contains("belongs to skill \"reporting\"") && o.Contains("load_skill"));
        Assert.DoesNotContain("get_sprint", chat.Offered[1]); // still locked
    }

    [Fact]
    public async Task A_skill_hidden_by_the_node_filter_never_unlocks_its_tools()
    {
        var c = new Counters();
        var (today, sprint, _) = Tools(c);
        var chat = new ScriptedChat([Call("1", "load_skill", new() { ["name"] = "reporting" })], [Text("ok")]);

        // The node scopes to a tag "docs" does not carry, so the tagged "docs" skill — the one
        // holding get_sprint — is hidden (untagged "reporting" stays visible but holds nothing).
        await Run(App(chat, [today], new() { ["docs"] = [sprint] }, skillTags: ["nothing"]));

        Assert.All(chat.Offered, offered => Assert.DoesNotContain("get_sprint", offered));
    }

    [Fact]
    public async Task A_tool_both_always_on_and_skill_held_fails_the_run()
    {
        var c = new Counters();
        var (today, sprint, _) = Tools(c);
        var chat = new ScriptedChat([Text("unused")]);

        var conn = await Run(App(chat, [today, sprint], new() { ["reporting"] = [sprint] }));

        Assert.Contains(conn.Sent, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "error");
        Assert.Empty(chat.Offered);
    }

    [Fact]
    public async Task The_active_skill_set_survives_an_approval_interrupt_and_resume()
    {
        var c = new Counters();
        var (today, _, refund) = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "refund")],
            [Text("Refunded.")]);
        var app = App(chat, [today], new() { ["reporting"] = [refund] },
            policies: new Dictionary<string, ToolPolicy> { ["refund"] = new() { Approve = new ApproveSpec() } });

        var conn = await Run(app);
        var interrupt = conn.Sent.Single(f => Type(f) == "interrupt");
        Assert.Equal(0, c.Refund);

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });

        // On the replay pass the recorded load_skill re-activated the skill, so the refund
        // was dispatched (not refused as locked) and ran exactly once.
        Assert.Equal(1, c.Refund);
        Assert.Equal(3, chat.Offered.Count); // two recorded decisions replayed, one new model call
        Assert.Contains("refund", chat.Offered[2]);
        Assert.Contains(conn.Sent, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "finished");
    }

    // ── tools the skill entry owns (SkillEntry<AIFunction>) ───────────────────

    private static SkillEntry<AIFunction> Owning(SkillEntry entry, params AIFunction[] tools) => new()
    {
        Name = entry.Name,
        Description = entry.Description,
        Instructions = entry.Instructions,
        Tags = entry.Tags,
        Tools = tools,
    };

    private static MekikApp CatalogApp(
        IChatClient chat,
        ISkillSource catalog,
        AIFunction[]? tools = null,
        Dictionary<string, IReadOnlyList<AIFunction>>? skillTools = null,
        IReadOnlyList<string>? skillTags = null,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State state, IContext ctx) =>
                Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
                {
                    System = "You are a test agent.",
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
            Skills = catalog,
        });
    }

    private static bool RunErrored(FakeConn conn) =>
        conn.Sent.Any(f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "error");

    [Fact]
    public async Task An_entrys_own_tools_are_offered_only_after_load_skill_and_the_load_names_them()
    {
        var c = new Counters();
        var (today, sprint, _) = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "get_sprint")],
            [Text("Velocity is 42.")]);

        var conn = await Run(CatalogApp(chat, SkillSources.Inline(Owning(Reporting, sprint), Docs), tools: [today]));

        Assert.Equal(["today", "load_skill"], chat.Offered[0]);
        Assert.Equal(["today", "load_skill", "get_sprint"], chat.Offered[1]);
        Assert.Contains("Tools now available from skill reporting: get_sprint.", string.Join("\n", chat.Observations));
        Assert.Equal(1, c.Sprint);
        Assert.Contains(conn.Sent, f => Type(f) == "tool_call" && (string?)Data(f)["name"] == "get_sprint");
        Assert.DoesNotContain("get_sprint", Json.Canonicalize(conn.Sent.Where(f => Type(f) == "skills").ToList()));
    }

    [Fact]
    public async Task A_premature_call_to_an_entrys_tool_is_refused_without_running()
    {
        var c = new Counters();
        var (_, sprint, _) = Tools(c);
        var chat = new ScriptedChat([Call("1", "get_sprint")], [Text("ok")]);

        await Run(CatalogApp(chat, SkillSources.Inline(Owning(Reporting, sprint))));

        Assert.Equal(0, c.Sprint);
        Assert.Contains(chat.Observations, o => o.Contains("belongs to skill \"reporting\""));
        Assert.All(chat.Offered, offered => Assert.DoesNotContain("get_sprint", offered));
    }

    [Fact]
    public async Task Explicit_SkillTools_merge_with_the_entrys_own_tools()
    {
        var c = new Counters();
        var (_, sprint, refund) = Tools(c);
        var chat = new ScriptedChat([Call("1", "load_skill", new() { ["name"] = "reporting" })], [Text("ok")]);

        await Run(CatalogApp(chat, SkillSources.Inline(Owning(Reporting, sprint)), skillTools: new() { ["reporting"] = [refund, sprint] }));

        Assert.Equal(["load_skill", "get_sprint", "refund"], chat.Offered[1]);
        Assert.Contains("Tools now available from skill reporting: get_sprint, refund.", string.Join("\n", chat.Observations));
    }

    [Fact]
    public async Task An_entry_tool_sharing_a_name_with_an_always_on_tool_fails_the_run()
    {
        var c = new Counters();
        var (_, sprint, _) = Tools(c);
        var chat = new ScriptedChat([Text("unused")]);

        var conn = await Run(CatalogApp(chat, SkillSources.Inline(Owning(Reporting, sprint)), tools: [sprint]));

        Assert.True(RunErrored(conn));
        Assert.Empty(chat.Offered);
    }

    [Fact]
    public async Task One_name_under_two_skills_with_different_tools_fails_the_run_the_same_tool_under_two_is_fine()
    {
        var c = new Counters();
        var (_, sprint, _) = Tools(c);
        var other = AIFunctionFactory.Create(() => "x", "get_sprint", "A different sprint tool.");
        var docsUntagged = new SkillEntry { Name = "docs", Description = "Docs.", Instructions = "Read docs." };

        var bad = new ScriptedChat([Text("unused")]);
        var failed = await Run(CatalogApp(bad, SkillSources.Inline(Owning(Reporting, sprint), docsUntagged), skillTools: new() { ["docs"] = [other] }));
        Assert.True(RunErrored(failed));
        Assert.Empty(bad.Offered);

        var ok = new ScriptedChat([Call("0", "get_sprint")], [Call("1", "load_skill", new() { ["name"] = "docs" })], [Text("ok")]);
        await Run(CatalogApp(ok, SkillSources.Inline(Owning(Reporting, sprint), Owning(docsUntagged, sprint))));
        Assert.Equal(["load_skill", "get_sprint"], ok.Offered[2]);
        // A premature call names every skill that holds the tool, in catalog order.
        Assert.Contains(ok.Observations, o => o.StartsWith("Tool get_sprint belongs to skills \"docs\", \"reporting\"."));
    }

    [Fact]
    public async Task An_entry_hidden_by_the_nodes_tag_filter_never_unlocks_its_tools()
    {
        var c = new Counters();
        var (_, sprint, _) = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "docs" })],
            [Call("2", "get_sprint")],
            [Text("ok")]);

        await Run(CatalogApp(chat, SkillSources.Inline(Reporting, Owning(Docs, sprint)), skillTags: ["nothing"]));

        Assert.All(chat.Offered, offered => Assert.DoesNotContain("get_sprint", offered));
        Assert.Equal(0, c.Sprint);
        Assert.Contains(chat.Observations, o => o.Contains("Unknown skill \"docs\""));
    }

    /// <summary>Lists a skill it cannot produce: load_skill fails with a status:error trace.</summary>
    private sealed class Broken : ISkillSource
    {
        public IReadOnlyList<SkillSummary> List() => [Reporting.ToSummary()];
        public SkillEntry? Get(string name) => null;
    }

    [Fact]
    public async Task A_failed_load_unlocks_nothing()
    {
        var c = new Counters();
        var (_, sprint, _) = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "get_sprint")],
            [Text("ok")]);

        var conn = await Run(CatalogApp(chat, new Broken(), skillTools: new() { ["reporting"] = [sprint] }));

        Assert.All(chat.Offered, offered => Assert.DoesNotContain("get_sprint", offered));
        Assert.Equal(0, c.Sprint);
        Assert.Contains(conn.Sent, f => Type(f) == "skill" && Data(f).GetValueOrDefault("status") as string == "error");
        Assert.Contains(chat.Observations, o => o.Contains("belongs to skill \"reporting\""));
    }

    [Fact]
    public async Task An_entrys_tools_stay_unlocked_across_an_approval_interrupt_and_resume_and_run_once()
    {
        var c = new Counters();
        var (_, _, refund) = Tools(c);
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "refund")],
            [Text("Refunded.")]);
        var app = CatalogApp(chat, SkillSources.Inline(Owning(Reporting, refund)),
            policies: new Dictionary<string, ToolPolicy> { ["refund"] = new() { Approve = new ApproveSpec() } });

        var conn = await Run(app);
        var interrupt = conn.Sent.Single(f => Type(f) == "interrupt");
        Assert.Equal(0, c.Refund);

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });

        Assert.Equal(1, c.Refund);
        Assert.Contains("refund", chat.Offered[2]);
        Assert.Contains(conn.Sent, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "finished");
    }

    [Fact]
    public async Task An_unlocked_skill_tool_that_throws_comes_back_as_an_observation_traced_running_then_error()
    {
        var boom = AIFunctionFactory.Create(string () => throw new InvalidOperationException("sprint service down"), "get_sprint", "Sprint metrics.");
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "get_sprint")],
            [Text("The sprint service is down.")]);

        var conn = await Run(CatalogApp(chat, SkillSources.Inline(Owning(Reporting, boom))));

        Assert.Contains(chat.Observations, o => o == "Error from get_sprint: sprint service down");
        Assert.Equal(["running", "error"], conn.Sent
            .Where(f => Type(f) == "tool_call" && (string?)Data(f)["name"] == "get_sprint")
            .Select(f => (string?)Data(f)["status"]).ToArray());
        Assert.Contains(conn.Sent, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "finished");
    }

    [Fact]
    public async Task An_entry_owning_tools_of_another_type_fails_the_run()
    {
        var chat = new ScriptedChat([Text("unused")]);
        var wrongType = new SkillEntry<string> { Name = "reporting", Description = "Sprint numbers.", Instructions = "x", Tools = ["get_sprint"] };
        var conn = await Run(CatalogApp(chat, SkillSources.Inline(wrongType)));
        Assert.True(RunErrored(conn));
    }

    [Fact]
    public async Task Wrap_for_a_hand_wired_loop_names_the_entrys_tools_plus_extra_and_onLoaded_fires_only_on_success()
    {
        var c = new Counters();
        var (_, sprint, _) = Tools(c);
        var loaded = new List<string>();
        string observation = "";

        var g = Graph.Create("hand")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State state, IContext ctx) =>
            {
                var fns = SkillFunctions.Wrap(ctx, null, null,
                    new Dictionary<string, IReadOnlyList<string>> { ["reporting"] = ["refund"] }, loaded.Add);
                var load = fns.Single(f => f.Name == SkillFunctions.LoadSkillTool);
                observation = (await load.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "reporting" })))?.ToString() ?? "";
                await load.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "docs" })); // a skill without tools loads too
                await load.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "missing" }));
                return Update.Of("reply", "done");
            })
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();
        var app = new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            Skills = SkillSources.Inline(Owning(Reporting, sprint), Docs),
        });

        await Run(app);

        Assert.EndsWith("Tools now available from skill reporting: get_sprint, refund.", observation);
        Assert.Equal(["reporting", "docs"], loaded); // "missing" never fires
    }

    [Fact]
    public async Task ToolContext_a_catalog_owned_function_reads_the_calling_runs_context_outside_a_wrapped_call_it_throws()
    {
        var seen = new List<string>();
        // Built once — no context in scope.
        var whoAmI = AIFunctionFactory.Create((AIFunctionArguments call) =>
        {
            var ctx = MekikTools.ToolContext(call);
            seen.Add(ctx.ThreadId);
            Shuttle.Text(ctx, "said by the tool");
            return "ok";
        }, "who_am_i", "Report the conversation.");
        var chat = new ScriptedChat(
            [Call("1", "load_skill", new() { ["name"] = "reporting" })],
            [Call("2", "who_am_i")],
            [Text("done")]);

        var conn = await Run(CatalogApp(chat, SkillSources.Inline(Owning(Reporting, whoAmI))));

        Assert.Single(seen);
        Assert.False(string.IsNullOrEmpty(seen[0]));
        Assert.Contains("said by the tool", string.Join("\n", conn.Sent.Select(f => Json.Canonicalize(f))));
        await Assert.ThrowsAsync<InvalidOperationException>(async () => await whoAmI.InvokeAsync(new AIFunctionArguments()));
    }
}
