using Ilmek;

namespace Mekik;

/// <summary>Per-run context the engine threads into ilmek (PROTOCOL.md §5).</summary>
public sealed record RunContext
{
    /// <summary>The ilmek thread id — mekik's `conversationId`.</summary>
    public required string ThreadId { get; init; }
    /// <summary>Merged context (`meta.mekik`/`meta.client`/`meta.auth`), read by nodes as `ctx.Meta`.</summary>
    public IReadOnlyDictionary<string, object?> Meta { get; init; } = new Dictionary<string, object?>();
    /// <summary>Cancels the run at the next superstep boundary (an `abort` frame).</summary>
    public CancellationToken CancellationToken { get; init; } = CancellationToken.None;
}

/// <summary>
/// The ilmek seam (PROTOCOL.md §5), mirror of the TypeScript <c>IlmekAdapter</c>.
/// A thin wrapper over ilmek's run/resume streams so the engine depends on this
/// surface, injecting the checkpointer every call needs.
/// </summary>
public sealed class IlmekAdapter
{
    public CompiledGraph Graph { get; }
    public ICheckpointer Checkpointer { get; }
    private readonly int? _recursionLimit;

    public IlmekAdapter(CompiledGraph graph, ICheckpointer checkpointer, int? recursionLimit = null)
    {
        Graph = graph;
        Checkpointer = checkpointer;
        _recursionLimit = recursionLimit;
    }

    /// <summary>Start a fresh turn: fold `input` into the graph and stream its events.</summary>
    public IAsyncEnumerable<IlmekEvent> Run(IReadOnlyDictionary<string, object?> input, RunContext ctx) =>
        IlmekRuntime.Stream(Graph, input, Opts(ctx), ctx.CancellationToken);

    /// <summary>Resume a parked thread, answering interrupts by thread-scoped id (PROTOCOL.md §4.4).</summary>
    public IAsyncEnumerable<IlmekEvent> Resume(IReadOnlyDictionary<string, object?> answers, RunContext ctx) =>
        IlmekRuntime.ResumeKeyedStream(Graph, answers, Opts(ctx), ctx.CancellationToken);

    /// <summary>The interrupts the thread is parked on, or empty. Drives `welcome.pending` and the parked-turn guard.</summary>
    public Task<IReadOnlyList<Pending>> PendingAsync(string threadId, CancellationToken ct = default) =>
        IlmekRuntime.PendingInterruptsAsync(Checkpointer, threadId, ct);

    private RunOptions Opts(RunContext ctx) => new()
    {
        ThreadId = ctx.ThreadId,
        Checkpointer = Checkpointer,
        Meta = ctx.Meta,
        RecursionLimit = _recursionLimit ?? 25,
    };
}
