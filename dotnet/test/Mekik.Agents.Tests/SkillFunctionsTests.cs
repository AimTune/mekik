using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

/// <summary>
/// SkillFunctions (PROTOCOL.md §12): the turn's skills surfaced as AIFunctions —
/// load_skill for instructions, read_skill_resource when the catalog has files.
/// Driven through the real engine so the assertions are about the wire. Mirror
/// of ts/packages/langchain/test/skills.test.ts.
/// </summary>
public class SkillFunctionsTests
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

    private static readonly SkillEntry Pdf = new() { Name = "pdf", Description = "Fill PDF forms.", Instructions = "Use scripts/fill.py.", Tags = ["docs"] };
    private static readonly SkillEntry Voice = new() { Name = "brand-voice", Description = "House style.", Instructions = "Short sentences." };

    private sealed class WithFiles : ISkillSource
    {
        public IReadOnlyList<SkillSummary> List() => [Voice.ToSummary(), Pdf.ToSummary()];
        public SkillEntry? Get(string name) => name switch { "pdf" => Pdf, "brand-voice" => Voice, _ => null };
        public bool HasResources => true;
        public Task<string> ReadResourceAsync(string name, string path, CancellationToken ct = default)
        {
            if (path.StartsWith("..")) throw new InvalidOperationException("outside skill");
            return Task.FromResult($"{name}/{path}: field names are snake_case");
        }
    }

    private static List<IReadOnlyDictionary<string, object?>> SkillFrames(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "skill")
        .Select(f => (IReadOnlyDictionary<string, object?>)f["data"]!)
        .ToList();

    private static string? LastBot(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "text" && (string?)f.GetValueOrDefault("from") == "bot")
        .Select(f => ((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") as string)
        .LastOrDefault();

    private static MekikApp MakeApp(ISkillSource? skills, Func<IContext, ValueTask<string>> body)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State _, IContext ctx) => Update.Of("reply", await body(ctx)))
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();
        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            Skills = skills,
        });
    }

    private static async Task<FakeConn> Run(MekikApp app)
    {
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, new Dictionary<string, object?> { ["type"] = "text", ["data"] = new Dictionary<string, object?> { ["text"] = "go" } });
        return conn;
    }

    private static ValueTask<object?> Invoke(AIFunction fn, params (string Key, object? Value)[] args) =>
        fn.InvokeAsync(new AIFunctionArguments(args.ToDictionary(a => a.Key, a => a.Value)));

    [Fact]
    public async Task Exposes_load_skill_and_read_skill_resource_only_when_the_catalog_has_files()
    {
        string[] names = [];
        await Run(MakeApp(SkillSources.Inline(Pdf, Voice), ctx => { names = SkillFunctions.Wrap(ctx).Select(f => f.Name).ToArray(); return new ValueTask<string>("done"); }));
        Assert.Equal([SkillFunctions.LoadSkillTool], names);

        await Run(MakeApp(new WithFiles(), ctx => { names = SkillFunctions.Wrap(ctx).Select(f => f.Name).ToArray(); return new ValueTask<string>("done"); }));
        Assert.Equal([SkillFunctions.LoadSkillTool, SkillFunctions.ReadSkillResourceTool], names);
    }

    [Fact]
    public async Task No_skills_in_the_turn_means_no_functions_and_an_empty_prompt_block()
    {
        var count = -1;
        var prompt = "x";
        await Run(MakeApp(null, ctx => { count = SkillFunctions.Wrap(ctx).Count; prompt = Shuttle.SkillsPrompt(ctx); return new ValueTask<string>("ok"); }));
        Assert.Equal(0, count);
        Assert.Equal("", prompt);
    }

    [Fact]
    public async Task Load_skill_returns_the_instructions_and_emits_the_skill_trace()
    {
        var conn = await Run(MakeApp(SkillSources.Inline(Pdf, Voice), async ctx =>
        {
            var load = SkillFunctions.Wrap(ctx)[0];
            return (await Invoke(load, ("name", "pdf")))?.ToString() ?? "";
        }));
        Assert.Equal("Use scripts/fill.py.", LastBot(conn));
        var uses = SkillFrames(conn);
        Assert.Single(uses);
        Assert.Equal(("pdf", "loaded", "server"), ((string)uses[0]["name"]!, (string)uses[0]["status"]!, (string)uses[0]["source"]!));
    }

    [Fact]
    public async Task An_unknown_name_is_an_observation_and_the_filter_hides_what_the_prompt_hides()
    {
        var observation = "";
        var conn = await Run(MakeApp(SkillSources.Inline(Pdf, Voice), async ctx =>
        {
            var load = SkillFunctions.Wrap(ctx, tags: ["docs"])[0]; // brand-voice untagged → visible; pdf tagged docs → visible
            observation = (await Invoke(load, ("name", "nope")))?.ToString() ?? "";
            var scoped = SkillFunctions.Wrap(ctx, source: SkillOrigin.Client); // nothing declared → no functions at all
            return scoped.Count == 0 ? "scoped-empty" : "unexpected";
        }));
        Assert.Equal("Unknown skill \"nope\". Available: brand-voice, pdf.", observation);
        Assert.Empty(SkillFrames(conn));
        Assert.Equal("scoped-empty", LastBot(conn));
    }

    [Fact]
    public async Task Read_skill_resource_reads_through_the_catalog_and_reports_refusals_as_observations()
    {
        var ok = "";
        var refused = "";
        await Run(MakeApp(new WithFiles(), async ctx =>
        {
            var read = SkillFunctions.Wrap(ctx).Single(f => f.Name == SkillFunctions.ReadSkillResourceTool);
            ok = (await Invoke(read, ("name", "pdf"), ("path", "references/forms.md")))?.ToString() ?? "";
            refused = (await Invoke(read, ("name", "pdf"), ("path", "../secret")))?.ToString() ?? "";
            return "done";
        }));
        Assert.Equal("pdf/references/forms.md: field names are snake_case", ok);
        Assert.Equal("Error reading ../secret from skill pdf: outside skill", refused);
    }
}
