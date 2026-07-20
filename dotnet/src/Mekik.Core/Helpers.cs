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

    private static void EmitChunk(IContext ctx, Dictionary<string, object?> chunk) =>
        ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "genui", ["chunk"] = chunk });

    /// <summary>Stream one prose delta as a genui text chunk.</summary>
    public static void Text(IContext ctx, string content) =>
        EmitChunk(ctx, new Dictionary<string, object?> { ["type"] = "text", ["content"] = content });

    /// <summary>Mount/update a GenUI component by registry name.</summary>
    public static void Ui(IContext ctx, string component, IReadOnlyDictionary<string, object?>? props = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "ui", ["component"] = component };
        if (props is not null) chunk["props"] = props;
        EmitChunk(ctx, chunk);
    }

    /// <summary>Dispatch a named GenUI event to a mounted component.</summary>
    public static void Event(IContext ctx, string name, object? payload = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "event", ["name"] = name };
        if (payload is not null) chunk["payload"] = payload;
        EmitChunk(ctx, chunk);
    }

    /// <summary>
    /// Run a tool exactly once (journaled by <c>ctx.StepAsync</c>) and emit its
    /// `tool_call` running→completed/error trace. The side effect is memoized
    /// across an interrupt-replay; the trace, an upsert by id, re-emits harmlessly.
    /// </summary>
    public static async ValueTask<T> Tool<T>(IContext ctx, string name, IReadOnlyDictionary<string, object?> @params, Func<ValueTask<T>> fn)
    {
        var id = NextToolId(ctx);
        void EmitTool(Dictionary<string, object?> call) => ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "tool", ["call"] = call });

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

    /// <summary>
    /// Pause for a human, attaching presentation metadata under the reserved
    /// `$mekik` key so the mapper can build the interrupt frame's ui/actions
    /// (PROTOCOL.md §4.2). Returns the human's answer on resume.
    /// </summary>
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
