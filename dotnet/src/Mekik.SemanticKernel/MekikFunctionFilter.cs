using Microsoft.SemanticKernel;

using Ilmek;
using Mekik.Agents;

namespace Mekik.SemanticKernel;

/// <summary>
/// A Semantic Kernel <see cref="IFunctionInvocationFilter"/> that makes a
/// kernel's function calls visible, approvable, and replay-safe.
///
/// <para>The filter is the right seam for Semantic Kernel because <b>everything
/// funnels through it</b>: direct <c>kernel.InvokeAsync</c>, auto function
/// calling, <c>ChatCompletionAgent</c> and the other agent types, and planners.
/// One registration covers Semantic Kernel and anything built on it — no need to
/// convert plugins or hand the agent a different tool list.</para>
///
/// <code>
/// .Node("agent", async (State state, IContext ctx) =>
/// {
///     using var _ = kernel.UseMekik(ctx, new()
///     {
///         ["get_order"]       = new ToolPolicy(),                              // shown
///         ["refund_payment"]  = new ToolPolicy { Approve = new ApproveSpec() }, // ask first
///         ["internal_lookup"] = new ToolPolicy { Show = false },                // runs, unseen
///         ["charge"]          = new ToolPolicy { Redact = ["cardNumber"] },     // shown, masked
///     });
///
///     var settings = new PromptExecutionSettings { FunctionChoiceBehavior = FunctionChoiceBehavior.Auto() };
///     var reply = await kernel.InvokePromptAsync(state.Get&lt;string&gt;("input"),
///         new KernelArguments(settings));
///     return Update.Of("reply", reply.ToString());
/// })
/// </code>
///
/// <para>Policies are looked up by the plugin-qualified name
/// (<c>Plugin.Function</c>) first, then by the bare function name, so you can be
/// specific where two plugins share a function name and terse everywhere else.</para>
/// </summary>
public sealed class MekikFunctionFilter : IFunctionInvocationFilter
{
    private readonly IContext _ctx;
    private readonly IReadOnlyDictionary<string, ToolPolicy>? _policies;
    private readonly ToolPolicy _default;

    public MekikFunctionFilter(
        IContext ctx,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null,
        ToolPolicy? defaultPolicy = null)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        _ctx = ctx;
        _policies = policies;
        _default = defaultPolicy ?? new ToolPolicy();
    }

    public async Task OnFunctionInvocationAsync(
        FunctionInvocationContext context, Func<FunctionInvocationContext, Task> next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        var name = context.Function.Name;
        var qualified = string.IsNullOrEmpty(context.Function.PluginName)
            ? name
            : $"{context.Function.PluginName}.{name}";
        var policy = Resolve(qualified, name);
        var args = context.Arguments.ToDictionary(kv => kv.Key, kv => kv.Value);

        if (policy.Approve is { } spec)
        {
            if (!await AskApprovalAsync(spec, policy, qualified, name, args).ConfigureAwait(false))
            {
                // Short-circuit: `next` is never called, so the function does not
                // run. The kernel still gets a result, so the model sees a refusal
                // it can respond to rather than an exception.
                context.Result = new FunctionResult(
                    context.Function, spec.DenyMessage ?? $"The user declined to run {name}.");
                return;
            }
        }

        var id = Shuttle.NextToolCallId(_ctx);
        if (policy.Show)
        {
            Shuttle.ToolTrace(_ctx, new Dictionary<string, object?>
            {
                ["id"] = id,
                ["name"] = qualified,
                ["status"] = "running",
                ["params"] = MekikTools.Mask(args, policy.Redact),
            });
        }

        try
        {
            var invoked = false;
            // Journaled: the first pass runs the function and records its value;
            // the replay pass after an interrupt returns that value without
            // invoking anything.
            var value = await _ctx.StepAsync<object?>($"sk:{qualified}", async () =>
            {
                invoked = true;
                await next(context).ConfigureAwait(false);
                return context.Result.GetValue<object>();
            }).ConfigureAwait(false);

            // On a replay pass the lambda never ran, so the kernel's Result was
            // never populated — restore it from the journal so the caller and the
            // model see the same answer they saw the first time.
            if (!invoked) context.Result = new FunctionResult(context.Function, value);

            if (policy.Show)
            {
                Shuttle.ToolTrace(_ctx, new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["name"] = qualified,
                    ["status"] = "completed",
                    ["result"] = MekikTools.MaskValue(value, policy.Redact),
                });
            }
        }
        catch (InterruptSignalException)
        {
            // A pause is not a failure — rethrow untouched (PROTOCOL.md §9).
            throw;
        }
        catch (Exception ex)
        {
            if (policy.Show)
            {
                Shuttle.ToolTrace(_ctx, new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["name"] = qualified,
                    ["status"] = "error",
                    ["error"] = ex.Message,
                });
            }
            throw;
        }
    }

    private ToolPolicy Resolve(string qualified, string name)
    {
        if (_policies is null) return _default;
        if (_policies.TryGetValue(qualified, out var byQualified)) return byQualified;
        if (_policies.TryGetValue(name, out var byName)) return byName;
        return _default;
    }

    private async ValueTask<bool> AskApprovalAsync(
        ApproveSpec spec, ToolPolicy policy, string qualified, string name, IReadOnlyDictionary<string, object?> args)
    {
        var payload = new Dictionary<string, object?>
        {
            ["title"] = spec.Title ?? $"Run {name}?",
            ["tool"] = qualified,
            ["params"] = MekikTools.Mask(args, policy.Redact),
        };

        var actions = spec.Actions ?? new List<object>
        {
            new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } },
            new Dictionary<string, object?> { ["label"] = "Reject", ["value"] = new Dictionary<string, object?> { ["approved"] = false } },
        };

        // A stable, per-function key so a node that approves several functions
        // keeps its pauses distinct and replay-addressable (ilmek MODEL.md §5.4).
        var answer = await Shuttle.Approve<object?>(
            _ctx, payload, ui: spec.Ui, actions: actions, key: $"approve:{qualified}").ConfigureAwait(false);

        return MekikTools.IsApproved(answer);
    }
}

/// <summary>Registers <see cref="MekikFunctionFilter"/> on a kernel.</summary>
public static class MekikKernelExtensions
{
    /// <summary>
    /// Route this kernel's function calls through mekik for the lifetime of the
    /// returned scope:
    ///
    /// <code>using var _ = kernel.UseMekik(ctx, policies);</code>
    ///
    /// <para>Disposing removes the filter again, which matters because a
    /// <see cref="Kernel"/> is usually long-lived while <c>ctx</c> belongs to one
    /// graph run — leaving filters registered would leak a stale context into the
    /// next turn.</para>
    /// </summary>
    public static IDisposable UseMekik(
        this Kernel kernel,
        IContext ctx,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null,
        ToolPolicy? defaultPolicy = null)
    {
        ArgumentNullException.ThrowIfNull(kernel);
        var filter = new MekikFunctionFilter(ctx, policies, defaultPolicy);
        kernel.FunctionInvocationFilters.Add(filter);
        return new FilterScope(kernel, filter);
    }

    private sealed class FilterScope(Kernel kernel, IFunctionInvocationFilter filter) : IDisposable
    {
        public void Dispose() => kernel.FunctionInvocationFilters.Remove(filter);
    }
}
