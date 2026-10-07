using Ilmek;
using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// An in-memory <see cref="IConnection"/> that records every frame the engine sends.
/// Thread-safe, because a run streams from whatever thread ilmek drives it on, and
/// awaitable (<see cref="WaitForAsync"/>) so a test can synchronize on a frame
/// instead of sleeping. Every frame is also pushed through <see cref="Json.Serialize"/>
/// on the way in: a frame the real WebSocket transport could not serialize fails the
/// test here, not in production.
/// </summary>
internal sealed class FakeConn : IConnection
{
    private static int _next;
    private readonly object _gate = new();
    private readonly List<Frame> _sent = new();
    private readonly List<(Func<Frame, bool> Match, TaskCompletionSource<Frame> Tcs)> _waiters = new();

    public FakeConn(string? id = null) => Id = id ?? $"c-{Interlocked.Increment(ref _next)}";

    public string Id { get; }

    /// <summary>The close the engine requested, if any.</summary>
    public (int? Code, string? Reason)? Closed { get; private set; }

    public IReadOnlyList<Frame> Sent
    {
        get { lock (_gate) return _sent.ToList(); }
    }

    public void Send(Frame frame)
    {
        _ = Json.Serialize(frame); // must be wire-serializable
        List<TaskCompletionSource<Frame>> fire = new();
        lock (_gate)
        {
            _sent.Add(frame);
            for (var i = _waiters.Count - 1; i >= 0; i--)
            {
                if (!_waiters[i].Match(frame)) continue;
                fire.Add(_waiters[i].Tcs);
                _waiters.RemoveAt(i);
            }
        }
        foreach (var tcs in fire) tcs.TrySetResult(frame);
    }

    public void Close(int? code = null, string? reason = null) => Closed = (code, reason);

    /// <summary>The first frame (already sent or still to come) matching <paramref name="match"/>.</summary>
    public async Task<Frame> WaitForAsync(Func<Frame, bool> match, int timeoutMs = 10_000)
    {
        TaskCompletionSource<Frame> tcs;
        lock (_gate)
        {
            var hit = _sent.FirstOrDefault(match);
            if (hit is not null) return hit;
            tcs = new TaskCompletionSource<Frame>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiters.Add((match, tcs));
        }
        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
        if (done != tcs.Task)
            throw new TimeoutException($"{Id}: no matching frame; sent so far: {string.Join(",", Sent.Select(f => f.Type()))}");
        return await tcs.Task.ConfigureAwait(false);
    }

    public Task<Frame> WaitForRunAsync(string status) =>
        WaitForAsync(f => f.Type() == "run" && f.Data().GetValueOrDefault("status") as string == status);
}

/// <summary>Terse, typed reads over the dictionary-shaped wire frames.</summary>
internal static class FrameExt
{
    public static string? Type(this Frame f) => f.GetValueOrDefault("type") as string;

    public static IReadOnlyDictionary<string, object?> Data(this Frame f) => (IReadOnlyDictionary<string, object?>)f["data"]!;

    public static long? Seq(this Frame f) => f.GetValueOrDefault("seq") switch
    {
        long l => l,
        int i => i,
        _ => null,
    };

    public static string? Code(this Frame f) => f.Data().GetValueOrDefault("code") as string;

    public static string? Text(this Frame f) => f.Data().GetValueOrDefault("text") as string;

    public static string? Id(this Frame f) => f.GetValueOrDefault("id") as string;

    public static IReadOnlyDictionary<string, object?> Welcome(this FakeConn c) =>
        c.Sent.First(f => f.Type() == "welcome").Data();

    public static List<string?> Types(this FakeConn c) => c.Sent.Select(f => f.Type()).ToList();

    public static List<string?> RunStatuses(this FakeConn c) => c.Sent
        .Where(f => f.Type() == "run")
        .Select(f => f.Data().GetValueOrDefault("status") as string)
        .ToList();

    public static List<string?> ErrorCodes(this FakeConn c) => c.Sent.Where(f => f.Type() == "error").Select(f => f.Code()).ToList();

    public static List<long> Seqs(this IEnumerable<Frame> frames) =>
        frames.Select(f => f.Seq()).Where(s => s is not null).Select(s => s!.Value).ToList();

    public static List<string?> BotTexts(this FakeConn c) => c.Sent
        .Where(f => f.Type() == "text" && f.GetValueOrDefault("from") as string == "bot")
        .Select(f => f.Text())
        .ToList();

    public static List<string?> UserTexts(this FakeConn c) => c.Sent
        .Where(f => f.Type() == "text" && f.GetValueOrDefault("from") as string == "user")
        .Select(f => f.Text())
        .ToList();
}

/// <summary>Client→server frame builders.</summary>
internal static class In
{
    public static Dictionary<string, object?> Text(string text, IReadOnlyDictionary<string, object?>? meta = null)
    {
        var f = new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = text },
        };
        if (meta is not null) f["meta"] = meta;
        return f;
    }

    public static Dictionary<string, object?> Resume(params (string Id, object? Answer)[] answers) => new()
    {
        ["type"] = "resume",
        ["answers"] = answers.ToDictionary(a => a.Id, a => a.Answer),
    };

    public static Dictionary<string, object?> Abort() => new() { ["type"] = "abort" };
}

/// <summary>
/// A two-sided latch for a node: <see cref="Entered"/> completes once the node is
/// running, and the node does not return until the test completes <see cref="Release"/>.
/// This is how a test holds a run in flight without a sleep.
/// </summary>
internal sealed class Gate
{
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task WaitEnteredAsync() => Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
}

/// <summary>The graphs the engine scenarios drive — mirrors of ts/packages/core/test/scenarios.test.ts.</summary>
internal static class Graphs
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    /// <summary>Emits a ui chunk and returns a reply — the happy-path turn.</summary>
    public static readonly CompiledGraph Greeter = Graph.Create("greeter")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("greet", (State s, IContext ctx) =>
        {
            Shuttle.Ui(ctx, "hello-card", D(("name", s.Get<string>("input"))));
            return Update.Of("reply", $"Hi, {s.Get<string>("input")}!");
        })
        .Edge(Graph.Start, "greet")
        .Edge("greet", Graph.End)
        .Compile();

    /// <summary>Replies with the input and emits nothing else — the smallest possible turn.</summary>
    public static readonly CompiledGraph Echo = Graph.Create("echo")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("echo", (State s, IContext _) => Update.Of("reply", $"echo:{s.Get<string>("input")}"))
        .Edge(Graph.Start, "echo")
        .Edge("echo", Graph.End)
        .Compile();

    /// <summary>Pauses once for an approval, with a form and a payload.</summary>
    public static readonly CompiledGraph Approval = Graph.Create("approval")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("gate", async (State s, IContext ctx) =>
        {
            var answer = await Shuttle.Approve<IReadOnlyDictionary<string, object?>>(
                ctx,
                D(("title", $"approve {s.Get<string>("input")}?")),
                ui: D(("component", "approval-form"), ("props", D(("what", s.Get<string>("input"))))));
            return Update.Of("reply", answer.GetValueOrDefault("approved") is true ? "approved" : "rejected");
        })
        .Edge(Graph.Start, "gate")
        .Edge("gate", Graph.End)
        .Compile();

    /// <summary>Fans out to two workers, each of which pauses — two concurrent interrupts.</summary>
    public static readonly CompiledGraph Batch = Graph.Create("batch")
        .Channel("input", Channels.LastWrite(""))
        .Channel("item", Channels.LastWrite(""))
        .Channel("done", Channels.Append())
        .Node("fan", (State _, IContext _) => Command.Goto_(
            new Send("worker", D(("item", "A"))),
            new Send("worker", D(("item", "B")))))
        .Node("worker", async (State s, IContext ctx) =>
        {
            await Shuttle.Approve<object?>(ctx, D(("title", $"charge {s.Get<string>("item")}")),
                actions: [Shuttle.Action("ok", true)]);
            return Update.Of("done", s.Get<string>("item"));
        })
        .Edge(Graph.Start, "fan")
        .Edge("worker", Graph.End)
        .Compile();

    /// <summary>Holds the run inside its node until the gate is released.</summary>
    public static CompiledGraph Gated(Gate gate, bool emitFirst = false) => Graph.Create("slow")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("wait", async (State s, IContext ctx) =>
        {
            if (emitFirst) Shuttle.Ui(ctx, "progress", D(("step", 1L)));
            gate.Entered.TrySetResult();
            await gate.Release.Task.ConfigureAwait(false);
            return Update.Of("reply", $"done:{s.Get<string>("input")}");
        })
        .Edge(Graph.Start, "wait")
        .Edge("wait", Graph.End)
        .Compile();

    /// <summary>Throws on "boom", echoes otherwise — the graph-error path.</summary>
    public static readonly CompiledGraph Fragile = Graph.Create("fragile")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("work", (State s, IContext _) =>
        {
            var input = s.Get<string>("input");
            if (input == "boom") throw new InvalidOperationException("kaboom");
            return Update.Of("reply", $"ok:{input}");
        })
        .Edge(Graph.Start, "work")
        .Edge("work", Graph.End)
        .Compile();

    /// <summary>Replies with what the node sees in <c>ctx.Meta</c>, canonicalized.</summary>
    public static readonly CompiledGraph MetaProbe = Graph.Create("meta-probe")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("probe", (State _, IContext ctx) =>
        {
            var visible = new Dictionary<string, object?>();
            foreach (var key in new[] { "auth", "client", "mekik" })
                if (ctx.Meta.GetValueOrDefault(key) is { } v) visible[key] = v;
            visible["keys"] = ctx.Meta.Keys.OrderBy(k => k, StringComparer.Ordinal).Cast<object?>().ToList();
            return Update.Of("reply", Json.Canonicalize(visible));
        })
        .Edge(Graph.Start, "probe")
        .Edge("probe", Graph.End)
        .Compile();

    public static MekikOptions Options(CompiledGraph graph) => new()
    {
        Graph = graph,
        Checkpointer = new InMemoryCheckpointer(),
        Reply = s => s.GetValueOrDefault("reply") as string,
    };

    public static MekikApp App(CompiledGraph graph) => new(Options(graph));
}

/// <summary>
/// A bare <see cref="IContext"/> that records what a helper emits — for unit tests of the
/// author-facing helpers outside a run. Journal steps run inline; interrupts are not modelled.
/// </summary>
internal sealed class RecordingCtx(IReadOnlyDictionary<string, object?>? meta = null, string taskId = "task") : IContext
{
    public CompiledGraph Graph => throw new NotSupportedException();
    public State State => throw new NotSupportedException();
    public string ThreadId => "t";
    public string RunId => "r";
    public string Node => "n";
    public string TaskId => taskId;
    public int StepIndex => 0;
    public int RecursionLimit => 1;
    public int RemainingSteps => 1;
    public IReadOnlyDictionary<string, object?> Meta => meta ?? new Dictionary<string, object?>();
    public IReadOnlyList<KeyValuePair<string, JournalEntry>> Journal => [];
    public CancellationToken CancellationToken => default;
    public List<object?> Emitted { get; } = new();
    public List<(object? Payload, string Key)> Interrupts { get; } = new();
    public ValueTask<T> StepAsync<T>(string key, Func<ValueTask<T>> fn) => fn();
    public ValueTask<T> StepAsync<T>(string key, Func<T> fn) => new(fn());
    public ValueTask<T> InterruptAsync<T>(object? payload = null, string key = "interrupt")
    {
        Interrupts.Add((payload, key));
        return ValueTask.FromResult(default(T)!);
    }
    public void Emit(object? payload) => Emitted.Add(payload);
    public void EmitToken(string text, IReadOnlyDictionary<string, object?>? meta = null) { }

    /// <summary>The genui chunks emitted, unwrapped from their <c>$mekik</c> envelope.</summary>
    public List<IReadOnlyDictionary<string, object?>> Chunks => Emitted
        .OfType<IReadOnlyDictionary<string, object?>>()
        .Where(e => e.GetValueOrDefault("$mekik") as string == "genui")
        .Select(e => (IReadOnlyDictionary<string, object?>)e["chunk"]!)
        .ToList();
}
