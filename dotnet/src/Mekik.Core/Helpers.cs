using System.Runtime.CompilerServices;
using Ilmek;

namespace Mekik;

/// <summary>
/// Author-facing helpers (PROTOCOL.md §6), mirror of the TypeScript `mekik.*`
/// namespace. Each takes ilmek's <see cref="IContext"/> and emits the custom
/// payloads <see cref="TurnMapper"/> recognises — no ambient storage, because
/// ilmek already threads <c>ctx</c> through every node.
///
/// <para>Named <c>Shuttle</c>, not <c>Mekik</c>: a static class sharing its
/// namespace's name binds ambiguously (the same reason ilmek uses
/// <c>IlmekRuntime</c>). "Shuttle" is what <i>mekik</i> means — the loom part that
/// carries the thread across, which is exactly this layer's job. Call sites read
/// <c>Shuttle.Ui(ctx, …)</c>, <c>Shuttle.Approve(ctx, …)</c>.</para>
/// </summary>
public static class Shuttle
{
    private const string MekikKey = "$mekik";

    // Per-ctx tool counter, so repeated tool calls get stable, replay-safe ids.
    private static readonly ConditionalWeakTable<IContext, StrongBox<int>> ToolCounters = new();

    private static string NextToolId(IContext ctx)
    {
        var box = ToolCounters.GetValue(ctx, _ => new StrongBox<int>(0));
        var n = box.Value++;
        // Stable across replay: taskId is unchanged and call order is deterministic,
        // so the resume pass mints the same id and its re-emitted trace upserts.
        return $"{(string.IsNullOrEmpty(ctx.TaskId) ? "task" : ctx.TaskId)}:tool:{n}";
    }

    /// <summary>
    /// Emit one `tool_call` frame. The low-level primitive behind <see cref="Tool{T}"/>,
    /// public so an integration that does its own execution (e.g. Mekik.Agents,
    /// where the model invokes the function) can still produce the same trace
    /// without re-deriving the reserved <c>$mekik</c> payload shape. Traces upsert
    /// by <c>call["id"]</c>, so re-emitting the same id is how a
    /// running→completed pair is expressed.
    /// </summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="call">The trace record: <c>{ id, name, status, params?, result?, error? }</c>.</param>
    /// <seealso cref="NextToolCallId"/>
    public static void ToolTrace(IContext ctx, IReadOnlyDictionary<string, object?> call) =>
        ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "tool", ["call"] = call });

    /// <summary>Mint a replay-stable <c>tool_call</c> id for this ctx — stable across an
    /// interrupt/resume, so a re-emitted trace upserts instead of duplicating.</summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <returns>A deterministic id for the next tool call on this context.</returns>
    /// <seealso cref="ToolTrace"/>
    public static string NextToolCallId(IContext ctx) => NextToolId(ctx);

    private static void EmitChunk(IContext ctx, Dictionary<string, object?> chunk) =>
        ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "genui", ["chunk"] = chunk });

    /// <summary>Stream one prose delta to the client as a generative-UI text chunk.</summary>
    /// <remarks>
    /// Text chunks are transient — they render live as the run streams, but they are not
    /// the conversation's durable reply (that is the single <c>text</c> frame emitted at
    /// run end from the reply selector). Use this for token-by-token model output.
    /// </remarks>
    /// <param name="ctx">The ilmek node context (threaded into every node).</param>
    /// <param name="content">The prose fragment to append to the current turn's stream.</param>
    public static void Text(IContext ctx, string content) =>
        EmitChunk(ctx, new Dictionary<string, object?> { ["type"] = "text", ["content"] = content });

    /// <summary>Mount or update a generative-UI component by its client-registry name.</summary>
    /// <remarks>Emitting the same component again with new props updates it in place. mekik
    /// ships no components — it streams the instruction to render one the client has registered.</remarks>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="component">The component name registered on the client (chativa).</param>
    /// <param name="props">Props handed to the component; omit for one that needs none.</param>
    /// <example><code>Shuttle.Ui(ctx, "order-card", new Dictionary&lt;string, object?&gt; { ["id"] = order.Id });</code></example>
    public static void Ui(IContext ctx, string component, IReadOnlyDictionary<string, object?>? props = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "ui", ["component"] = component };
        if (props is not null) chunk["props"] = props;
        EmitChunk(ctx, chunk);
    }

    /// <summary>Dispatch a named event to a mounted GenUI component — advance a step,
    /// highlight a row — without re-mounting it.</summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="name">The event name the component listens for.</param>
    /// <param name="payload">Optional event payload.</param>
    public static void Event(IContext ctx, string name, object? payload = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "event", ["name"] = name };
        if (payload is not null) chunk["payload"] = payload;
        EmitChunk(ctx, chunk);
    }

    /// <summary>Run a side effect exactly once and surface it as a <c>tool_call</c> trace.</summary>
    /// <remarks>
    /// <paramref name="fn"/> executes inside ilmek's <c>ctx.StepAsync</c>, so its result is
    /// journaled: on the replay pass after an interrupt the node re-runs, but <paramref name="fn"/>
    /// is not called again — it returns the recorded value. This is what stops a paused-then-resumed
    /// node from repeating a charge or a lookup. The trace re-emits on replay, but as an upsert by id
    /// the client just updates the existing entry. An <see cref="InterruptSignalException"/> is
    /// rethrown untouched — a pause is not a failure (the .NET rethrow rule, PROTOCOL.md §9).
    /// </remarks>
    /// <typeparam name="T">The tool's result type. Must survive a journal round-trip (plain data).</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="name">Tool name; shown in the trace and used as the journal step key.</param>
    /// <param name="params">Parameters, surfaced in the <c>running</c> trace.</param>
    /// <param name="fn">The side effect. Runs once ever, across any number of resumes.</param>
    /// <returns>The tool's result — the recorded value on a replay pass.</returns>
    /// <example><code>var order = await Shuttle.Tool(ctx, "get_order", p, () => Orders.Get(id));</code></example>
    public static async ValueTask<T> Tool<T>(IContext ctx, string name, IReadOnlyDictionary<string, object?> @params, Func<ValueTask<T>> fn)
    {
        var id = NextToolId(ctx);
        void EmitTool(Dictionary<string, object?> call) => ToolTrace(ctx, call);

        EmitTool(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "running", ["params"] = @params });
        try
        {
            var result = await ctx.StepAsync(name, fn).ConfigureAwait(false);
            EmitTool(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "completed", ["result"] = result });
            return result;
        }
        catch (InterruptSignalException)
        {
            // An interrupt is not a tool failure — rethrow untouched so the pause
            // propagates. This IS the .NET rethrow rule (PROTOCOL.md §9).
            throw;
        }
        catch (Exception ex)
        {
            EmitTool(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "error", ["error"] = ex.Message });
            throw;
        }
    }

    /// <summary>Synchronous-body overload of <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object?}, Func{ValueTask{T}})"/>.</summary>
    public static ValueTask<T> Tool<T>(IContext ctx, string name, IReadOnlyDictionary<string, object?> @params, Func<T> fn) =>
        Tool(ctx, name, @params, () => new ValueTask<T>(fn()));

    /// <summary>Pause the run for a human and resume with their answer.</summary>
    /// <remarks>
    /// The node suspends at this call on the first pass — it never returns there. The engine emits an
    /// <c>interrupt</c> frame (with the optional <paramref name="ui"/>/<paramref name="actions"/> under
    /// the reserved <c>$mekik</c> key, PROTOCOL.md §4.2) and ends the run <c>interrupted</c>. When the
    /// client answers with a <c>resume</c> keyed by the interrupt id, the node re-runs from the top and
    /// this call returns the answer. Everything before it re-runs on resume, so wrap side effects in
    /// <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object?}, Func{ValueTask{T}})"/>.
    /// Pass neither <paramref name="ui"/> nor <paramref name="actions"/> for default Approve/Cancel chips.
    /// </remarks>
    /// <typeparam name="T">The shape of the human's answer.</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="payload">The question, delivered to the client as <c>interrupt.data.payload</c>.</param>
    /// <param name="ui">Optional: mount a form component instead of relying on chips.</param>
    /// <param name="actions">Optional: quick-reply chips.</param>
    /// <param name="key">Journal key, when a node pauses more than once.</param>
    /// <returns>The human's answer, on resume.</returns>
    public static ValueTask<T> Approve<T>(
        IContext ctx,
        IReadOnlyDictionary<string, object?> payload,
        IReadOnlyDictionary<string, object?>? ui = null,
        IReadOnlyList<object>? actions = null,
        string key = "interrupt")
    {
        if (ui is null && actions is null) return ctx.InterruptAsync<T>(payload, key);

        var meta = new Dictionary<string, object?>();
        if (ui is not null) meta["ui"] = ui;
        if (actions is not null) meta["actions"] = actions;

        var wrapped = payload.ToDictionary(kv => kv.Key, kv => kv.Value);
        wrapped[MekikKey] = meta;
        return ctx.InterruptAsync<T>(wrapped, key);
    }
}
