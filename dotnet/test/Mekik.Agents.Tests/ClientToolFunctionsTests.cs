using System.Text.Json;
using Ilmek;
using Mekik;
using Mekik.Agents;
using Microsoft.Extensions.AI;

namespace Mekik.Agents.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>A bare <see cref="IContext"/> for unit-driving the Agents wrappers outside a run.</summary>
internal sealed class StubCtx(IReadOnlyDictionary<string, object?>? meta = null, Func<object?, object?>? answer = null) : IContext
{
    public CompiledGraph Graph => throw new NotSupportedException();
    public State State => throw new NotSupportedException();
    public string ThreadId => "t";
    public string RunId => "r";
    public string Node => "n";
    public string TaskId => "task";
    public int StepIndex => 0;
    public int RecursionLimit => 1;
    public int RemainingSteps => 1;
    public IReadOnlyDictionary<string, object?> Meta => meta ?? new Dictionary<string, object?>();
    public IReadOnlyList<KeyValuePair<string, JournalEntry>> Journal => [];
    public CancellationToken CancellationToken => default;
    public List<object?> Emitted { get; } = new();
    public List<object?> Interrupts { get; } = new();
    public ValueTask<T> StepAsync<T>(string key, Func<ValueTask<T>> fn) => fn();
    public ValueTask<T> StepAsync<T>(string key, Func<T> fn) => new(fn());
    public ValueTask<T> InterruptAsync<T>(object? payload = null, string key = "interrupt")
    {
        Interrupts.Add(payload);
        return ValueTask.FromResult((T)(answer?.Invoke(payload) ?? default(T))!);
    }
    public void Emit(object? payload) => Emitted.Add(payload);
    public void EmitToken(string text, IReadOnlyDictionary<string, object?>? meta = null) { }

    public List<Frame> ToolTraces => Emitted.OfType<Frame>()
        .Where(e => e.GetValueOrDefault("$mekik") as string == "tool")
        .Select(e => (Frame)e["call"]!)
        .ToList();
}

/// <summary>
/// <see cref="ClientToolFunctions"/> (PROTOCOL.md §11) — a client-declared tool as an
/// <see cref="AIFunction"/> a model can call: schema verbatim, the durable pause for a
/// call-mode tool, the event chunk for a notify tool, and failures as observations.
/// </summary>
public class ClientToolFunctionsTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    private static StubCtx Ctx(Func<object?, object?>? answer = null, params ClientToolDefinition[] defs) =>
        new(D(("clientTools", defs.ToList())), answer);

    private static readonly ClientToolDefinition PickDate = new()
    {
        Name = "pick_date",
        Description = "Open the date picker",
        Parameters = D(("type", "object"), ("properties", D(("min", D(("type", "string")))))),
        Tags = ["booking"],
    };

    private static readonly ClientToolDefinition Confetti = new() { Name = "confetti", Mode = "notify" };

    [Fact]
    public void Wrap_exposes_each_declared_tool_with_its_schema_verbatim_and_a_default_description()
    {
        var fns = ClientToolFunctions.Wrap(Ctx(null, PickDate, Confetti));

        Assert.Equal(["pick_date", "confetti"], fns.Select(f => f.Name));
        Assert.Equal("Open the date picker", fns[0].Description);
        Assert.Equal(Json.Canonicalize(PickDate.Parameters), Json.Canonicalize(fns[0].JsonSchema));
        Assert.Equal("Invoke the client's \"confetti\" tool.", fns[1].Description);
        Assert.Equal("{\"properties\":{},\"type\":\"object\"}", Json.Canonicalize(fns[1].JsonSchema));
    }

    [Fact]
    public void Wrap_filters_by_tag_and_mode_and_is_empty_without_declarations()
    {
        var ctx = Ctx(null, PickDate, Confetti);

        Assert.Equal(["pick_date", "confetti"], ClientToolFunctions.Wrap(ctx, tags: ["booking"]).Select(f => f.Name)); // untagged always match
        Assert.Equal(["confetti"], ClientToolFunctions.Wrap(ctx, mode: "notify").Select(f => f.Name));
        Assert.Empty(ClientToolFunctions.Wrap(new StubCtx()));
        Assert.Throws<ArgumentNullException>(() => ClientToolFunctions.Wrap(null!));
    }

    [Fact]
    public async Task A_call_mode_tool_resolves_to_the_clients_result()
    {
        var ctx = Ctx(_ => D(("ok", true), ("result", "2026-08-01")), PickDate);
        var fn = ClientToolFunctions.Wrap(ctx).Single();

        var result = await fn.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["min"] = "2026-07-01" }));

        Assert.Equal("2026-08-01", result);
        var pause = (Frame)((Frame)ctx.Interrupts.Single()!)["$mekik"]!;
        Assert.Equal("{\"name\":\"pick_date\",\"params\":{\"min\":\"2026-07-01\"}}", Json.Canonicalize(pause["tool"]));
        Assert.Equal(["running", "completed"], ctx.ToolTraces.Select(t => t["status"]));
    }

    [Fact]
    public async Task A_model_argument_arriving_as_JsonElement_reaches_the_client_as_plain_json()
    {
        var ctx = Ctx(_ => D(("ok", true), ("result", "x")), PickDate);
        var fn = ClientToolFunctions.Wrap(ctx).Single();
        using var doc = JsonDocument.Parse("{\"min\":\"2026-07-01\",\"n\":3}");
        var args = new AIFunctionArguments(doc.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone()));

        await fn.InvokeAsync(args);

        var tool = (Frame)((Frame)((Frame)ctx.Interrupts.Single()!)["$mekik"]!)["tool"]!;
        Assert.Equal("{\"min\":\"2026-07-01\",\"n\":3}", Json.Canonicalize(tool["params"]));
    }

    [Fact]
    public async Task A_failed_client_handler_is_an_observation_not_a_crash()
    {
        var ctx = Ctx(_ => D(("ok", false), ("error", "user closed the picker")), PickDate);
        var fn = ClientToolFunctions.Wrap(ctx).Single();

        var result = await fn.InvokeAsync(new AIFunctionArguments());

        Assert.Equal("Error from client tool pick_date: user closed the picker", result);
        Assert.Equal("error", ctx.ToolTraces.Last()["status"]);
    }

    [Fact]
    public async Task A_notify_tool_fires_an_event_chunk_and_tells_the_model_it_was_delivered()
    {
        var ctx = Ctx(null, Confetti);
        var fn = ClientToolFunctions.Wrap(ctx).Single();

        var result = await fn.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["level"] = 3L }));

        Assert.Equal("Delivered confetti to the client.", result);
        Assert.Empty(ctx.Interrupts);
        var chunk = ctx.Emitted.OfType<Frame>().Where(e => e["$mekik"] as string == "genui").Select(e => (Frame)e["chunk"]!).Single();
        Assert.Equal(Protocol.ClientToolEvent, chunk["name"]);
    }

    // ── end to end: the pause propagates through the AIFunction ───────────────

    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        public List<Frame> Sent { get; } = new();
        public void Send(Frame frame) => Sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    [Fact]
    public async Task Inside_a_run_the_call_parks_the_turn_and_a_resume_completes_it()
    {
        var g = Graph.Create("ct")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("n", async (State _, IContext ctx) =>
            {
                var fn = ClientToolFunctions.Wrap(ctx).Single();
                var picked = await fn.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["min"] = "2026-07-01" }));
                return Update.Of("reply", $"picked {picked}");
            })
            .Edge(Graph.Start, "n")
            .Edge("n", Graph.End)
            .Compile();
        var app = new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            ClientTools = ClientTools.AcceptAll,
        });
        var conn = new FakeConn();
        await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { Tools = [D(("name", "pick_date"))] } });

        await app.ReceiveAsync(conn, D(("type", "text"), ("data", D(("text", "book")))));
        var interrupt = conn.Sent.Single(f => f["type"] as string == "interrupt");
        Assert.Equal("pick_date", ((Frame)((Frame)interrupt["data"]!)["tool"]!)["name"]);

        await app.ReceiveAsync(conn, D(("type", "resume"), ("answers", D(((string)interrupt["id"]!, D(("ok", true), ("result", "2026-08-01")))))));

        Assert.Equal("picked 2026-08-01", conn.Sent.Last(f => f["type"] as string == "text")["data"] is Frame d ? d["text"] : null);
    }
}

/// <summary><see cref="SkillFunctions"/> argument handling and refusals, driven directly.</summary>
public class SkillFunctionsEdgeTests
{
    private sealed class Files : ISkillSource
    {
        public IReadOnlyList<SkillSummary> List() => [new SkillSummary { Name = "empty", Description = "No body." }, new SkillSummary { Name = "pdf", Description = "PDFs." }];
        public SkillEntry? Get(string name) => name switch
        {
            "empty" => new SkillEntry { Name = "empty", Description = "No body.", Instructions = "" },
            "pdf" => new SkillEntry { Name = "pdf", Description = "PDFs.", Instructions = "fill" },
            _ => null,
        };
        public bool HasResources => true;
        public Task<string> ReadResourceAsync(string name, string path, CancellationToken ct = default) =>
            path == "boom" ? throw new IOException("disk gone") : Task.FromResult($"{name}:{path}");
    }

    private static StubCtx Ctx(ISkillSource? source = null) =>
        new(new Dictionary<string, object?> { ["skills"] = new TurnSkillSource(source ?? new Files()) });

    private static AIFunction Fn(StubCtx ctx, string name) => SkillFunctions.Wrap(ctx).Single(f => f.Name == name);

    [Fact]
    public async Task Load_skill_accepts_a_JsonElement_name_and_reports_an_empty_body()
    {
        var ctx = Ctx();
        using var doc = JsonDocument.Parse("\"empty\"");

        var result = await Fn(ctx, SkillFunctions.LoadSkillTool).InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = doc.RootElement.Clone() }));

        Assert.Equal("(skill empty has no instructions)", result);
    }

    [Fact]
    public async Task Load_skill_with_a_missing_or_non_string_name_is_an_unknown_skill_observation()
    {
        var ctx = Ctx();
        var load = Fn(ctx, SkillFunctions.LoadSkillTool);

        var missing = await load.InvokeAsync(new AIFunctionArguments());
        var number = await load.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = 42 }));

        Assert.Equal("Unknown skill \"\". Available: empty, pdf.", missing);
        Assert.Equal("Unknown skill \"42\". Available: empty, pdf.", number);
    }

    [Fact]
    public async Task A_listed_skill_the_source_cannot_load_is_an_error_observation()
    {
        var flaky = new Flaky();
        var ctx = Ctx(flaky);

        var result = await Fn(ctx, SkillFunctions.LoadSkillTool).InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "ghost" }));

        Assert.StartsWith("Error loading skill ghost:", (string)result!);
    }

    private sealed class Flaky : ISkillSource
    {
        public IReadOnlyList<SkillSummary> List() => [new SkillSummary { Name = "ghost", Description = "Listed but gone." }];
        public SkillEntry? Get(string name) => null;
    }

    [Fact]
    public async Task Read_skill_resource_refuses_unlisted_skills_and_reports_read_failures()
    {
        var ctx = Ctx();
        var read = Fn(ctx, SkillFunctions.ReadSkillResourceTool);

        var unknown = await read.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "nope", ["path"] = "a.md" }));
        var failed = await read.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "pdf", ["path"] = "boom" }));
        var ok = await read.InvokeAsync(new AIFunctionArguments(new Dictionary<string, object?> { ["name"] = "pdf", ["path"] = "forms.md" }));

        Assert.Equal("Unknown skill \"nope\".", unknown);
        Assert.Equal("Error reading boom from skill pdf: disk gone", failed);
        Assert.Equal("pdf:forms.md", ok);
    }

    [Fact]
    public void Wrap_requires_a_ctx()
    {
        Assert.Throws<ArgumentNullException>(() => SkillFunctions.Wrap(null!));
    }
}

/// <summary><see cref="MekikTools"/> pieces the turn-level tests do not reach.</summary>
public class MekikToolsEdgeTests
{
    [Fact]
    public async Task WithMekik_applies_the_default_policy_to_functions_without_their_own()
    {
        var ctx = new StubCtx();
        var fns = new[]
        {
            AIFunctionFactory.Create(() => "a", "quiet"),
            AIFunctionFactory.Create(() => "b", "loud"),
        }.WithMekik(ctx, new Dictionary<string, ToolPolicy> { ["loud"] = new() }, defaultPolicy: new ToolPolicy { Show = false });

        await fns[0].InvokeAsync(new AIFunctionArguments());
        await fns[1].InvokeAsync(new AIFunctionArguments());

        Assert.Equal(["loud", "loud"], ctx.ToolTraces.Select(t => t["name"]));
    }

    [Fact]
    public void MaskValue_leaves_strings_alone_and_masks_inside_lists()
    {
        IReadOnlyList<string> redact = ["card"];

        Assert.Equal("card", MekikTools.MaskValue("card", redact));
        var masked = (List<object?>)MekikTools.MaskValue(new List<object?> { new Dictionary<string, object?> { ["card"] = "4111" }, 5L }, redact)!;
        var card = Assert.IsType<string>(((IReadOnlyDictionary<string, object?>)masked[0]!)["card"]);
        Assert.NotEqual("4111", card);
        Assert.DoesNotContain("4111", Json.Canonicalize(masked));
        Assert.Equal(5L, masked[1]);
        Assert.Equal(7L, MekikTools.MaskValue(7L, []));
    }
}
