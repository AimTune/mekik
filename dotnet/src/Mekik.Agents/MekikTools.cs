using System.Text.Json;

using Microsoft.Extensions.AI;

using Ilmek;

namespace Mekik.Agents;

/// <summary>Presentation and gating for one function's calls (mirror of the TypeScript `ToolPolicy`).</summary>
public sealed record ToolPolicy
{
    /// <summary>Surface this function's `tool_call` trace to the client. Default true.</summary>
    public bool Show { get; init; } = true;

    /// <summary>Require human approval before the function runs. Null means no approval.</summary>
    public ApproveSpec? Approve { get; init; }

    /// <summary>Argument/result field names to mask in the surfaced trace. The function still sees the real values.</summary>
    public IReadOnlyList<string> Redact { get; init; } = Array.Empty<string>();
}

/// <summary>How an approval pause is presented, and what the model is told when it is declined.</summary>
public sealed record ApproveSpec
{
    /// <summary>Question shown to the human. Defaults to <c>Run &lt;function&gt;?</c>.</summary>
    public string? Title { get; init; }

    /// <summary>Chips. Defaults to Approve/Reject carrying <c>{approved: true|false}</c>.</summary>
    public IReadOnlyList<object>? Actions { get; init; }

    /// <summary>Mount a form instead of relying on chips: <c>{ component, props }</c>.</summary>
    public IReadOnlyDictionary<string, object?>? Ui { get; init; }

    /// <summary>What the function returns to the model when the human declines.</summary>
    public string? DenyMessage { get; init; }
}

/// <summary>
/// Wraps <see cref="AIFunction"/>s so a model's function calls become visible,
/// approvable, and replay-safe. The .NET mirror of <c>@mekik/langchain</c>'s
/// <c>withMekikTools</c>.
///
/// <para>A chat client invokes its own functions, which leaves two gaps
/// <see cref="Shuttle.Tool{T}"/> normally closes for you:</para>
/// <list type="number">
///   <item><b>Visibility</b> — nothing emits a `tool_call` frame, so the UI never
///   learns a function ran.</item>
///   <item><b>Exactly-once</b> — when a node pauses for a human and the graph
///   resumes, the node re-runs from the top and the model calls its functions
///   <i>again</i>. Only <c>ctx.StepAsync</c> makes an effect survive that
///   replay.</item>
/// </list>
///
/// <code>
/// var tools = MekikTools.Wrap(ctx, [getOrder, refundPayment, internalLookup], new()
/// {
///     ["get_order"]       = new ToolPolicy(),                                        // shown
///     ["refund_payment"]  = new ToolPolicy { Approve = new ApproveSpec() },           // ask first
///     ["internal_lookup"] = new ToolPolicy { Show = false },                          // runs, unseen
///     ["charge"]          = new ToolPolicy { Redact = ["cardNumber"] },               // shown, masked
/// });
///
/// var options = new ChatOptions { Tools = [.. tools] };
/// var reply = await chatClient.GetResponseAsync(messages, options, ct);
/// </code>
///
/// <para>Note: Microsoft.Extensions.AI ships its own
/// <c>ApprovalRequiredAIFunction</c>, which asks for approval through the chat
/// protocol (the caller must round-trip approval content). This wrapper instead
/// pauses the <i>graph</i> with a mekik interrupt, so the approval renders in
/// chativa and survives a process restart in ilmek's checkpoint.</para>
/// </summary>
public static class MekikTools
{
    /// <summary>What a redacted field is replaced with in a surfaced trace.</summary>
    public const string Redacted = "«redacted»";

    private static readonly ToolPolicy DefaultPolicy = new();

    /// <summary>
    /// Wrap each function so that, when the model calls it, it emits a
    /// `tool_call` trace (unless <see cref="ToolPolicy.Show"/> is false),
    /// optionally pauses for human approval, and executes inside
    /// <c>ctx.StepAsync</c> so it runs exactly once across an interrupt/resume.
    /// Name, description and JSON schema are preserved, so the model sees the
    /// same tools as before.
    /// </summary>
    public static IReadOnlyList<AIFunction> Wrap(
        IContext ctx,
        IEnumerable<AIFunction> functions,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null,
        ToolPolicy? defaultPolicy = null)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(functions);

        var fallback = defaultPolicy ?? DefaultPolicy;
        return functions
            .Select(f => (AIFunction)new MekikFunction(
                f, ctx, policies is not null && policies.TryGetValue(f.Name, out var p) ? p : fallback))
            .ToList();
    }

    /// <summary>Fluent form of <see cref="Wrap"/>: <c>tools.WithMekik(ctx, policies)</c>.</summary>
    public static IReadOnlyList<AIFunction> WithMekik(
        this IEnumerable<AIFunction> functions,
        IContext ctx,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null,
        ToolPolicy? defaultPolicy = null) => Wrap(ctx, functions, policies, defaultPolicy);

    // ── the wrapper ───────────────────────────────────────────────────────────

    private sealed class MekikFunction : DelegatingAIFunction
    {
        private readonly IContext _ctx;
        private readonly ToolPolicy _policy;

        internal MekikFunction(AIFunction inner, IContext ctx, ToolPolicy policy) : base(inner)
        {
            _ctx = ctx;
            _policy = policy;
        }

        protected override async ValueTask<object?> InvokeCoreAsync(
            AIFunctionArguments arguments, CancellationToken cancellationToken)
        {
            var args = arguments.ToDictionary(kv => kv.Key, kv => kv.Value);

            if (_policy.Approve is { } spec)
            {
                var approved = await AskApprovalAsync(spec, args).ConfigureAwait(false);
                if (!approved)
                {
                    // Returning (not throwing) keeps the agent loop alive: the model
                    // sees a refusal it can respond to, which is what a function
                    // result is for.
                    return spec.DenyMessage ?? $"The user declined to run {Name}.";
                }
            }

            var id = Shuttle.NextToolCallId(_ctx);
            if (_policy.Show)
            {
                Shuttle.ToolTrace(_ctx, new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["name"] = Name,
                    ["status"] = "running",
                    ["params"] = Mask(args, _policy.Redact),
                });
            }

            try
            {
                // Journaled: on the replay pass after an interrupt this returns the
                // recorded value instead of invoking the function again. The value
                // must survive a serializer round-trip, like any ilmek step result.
                //
                // InnerFunction.InvokeAsync is what DelegatingAIFunction's own
                // InvokeCoreAsync forwards to; calling it directly keeps `base`
                // out of a lambda.
                var result = await _ctx.StepAsync(
                    $"ai:{Name}",
                    () => InnerFunction.InvokeAsync(arguments, cancellationToken)).ConfigureAwait(false);

                if (_policy.Show)
                {
                    Shuttle.ToolTrace(_ctx, new Dictionary<string, object?>
                    {
                        ["id"] = id,
                        ["name"] = Name,
                        ["status"] = "completed",
                        ["result"] = MaskValue(result, _policy.Redact),
                    });
                }
                return result;
            }
            catch (InterruptSignalException)
            {
                // A pause is not a failure — rethrow untouched (PROTOCOL.md §9).
                throw;
            }
            catch (Exception ex)
            {
                if (_policy.Show)
                {
                    Shuttle.ToolTrace(_ctx, new Dictionary<string, object?>
                    {
                        ["id"] = id,
                        ["name"] = Name,
                        ["status"] = "error",
                        ["error"] = ex.Message,
                    });
                }
                throw;
            }
        }

        private async ValueTask<bool> AskApprovalAsync(ApproveSpec spec, IReadOnlyDictionary<string, object?> args)
        {
            var payload = new Dictionary<string, object?>
            {
                ["title"] = spec.Title ?? $"Run {Name}?",
                ["tool"] = Name,
                ["params"] = Mask(args, _policy.Redact),
            };

            var actions = spec.Actions ?? new List<object>
            {
                new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } },
                new Dictionary<string, object?> { ["label"] = "Reject", ["value"] = new Dictionary<string, object?> { ["approved"] = false } },
            };

            // A stable, per-function key so a node that approves several functions
            // keeps its pauses distinct and replay-addressable (ilmek MODEL.md §5.4).
            var answer = await Shuttle.Approve<object?>(
                _ctx, payload, ui: spec.Ui, actions: actions, key: $"approve:{Name}").ConfigureAwait(false);

            return IsApproved(answer);
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// <summary>Accepts <c>{approved:true}</c>, <c>true</c>, or a yes-ish string — clients vary.</summary>
    internal static bool IsApproved(object? answer)
    {
        switch (answer)
        {
            case bool b:
                return b;
            case string s:
                var t = s.Trim();
                return t.StartsWith("y", StringComparison.OrdinalIgnoreCase)
                    || t.StartsWith("ok", StringComparison.OrdinalIgnoreCase)
                    || t.StartsWith("approve", StringComparison.OrdinalIgnoreCase)
                    || t.StartsWith("true", StringComparison.OrdinalIgnoreCase);
            case IReadOnlyDictionary<string, object?> d when d.TryGetValue("approved", out var v):
                return v is bool ok && ok;
            default:
                return false;
        }
    }

    internal static IReadOnlyDictionary<string, object?> Mask(
        IReadOnlyDictionary<string, object?> value, IReadOnlyList<string> redact)
    {
        if (redact.Count == 0) return value;
        var outp = new Dictionary<string, object?>();
        foreach (var (k, v) in value)
            outp[k] = redact.Contains(k) ? Redacted : MaskValue(v, redact);
        return outp;
    }

    internal static object? MaskValue(object? value, IReadOnlyList<string> redact)
    {
        if (redact.Count == 0) return value;
        return value switch
        {
            IReadOnlyDictionary<string, object?> d => Mask(d, redact),
            string => value, // a string is IEnumerable; never treat it as a list
            // A result that came back through Microsoft.Extensions.AI is JSON, not
            // a dictionary: AIFunctionFactory marshals return values through
            // System.Text.Json. Without this case Redact silently does nothing for
            // every function built that way, which is nearly all of them.
            JsonElement json => MaskJson(json, redact),
            IEnumerable<object?> seq => seq.Select(v => MaskValue(v, redact)).ToList(),
            _ => value,
        };
    }

    /// <summary>
    /// Walks a <see cref="JsonElement"/> the same way <see cref="Mask"/> walks a
    /// dictionary. Scalars are returned untouched — the canonical writer already
    /// knows how to emit them.
    /// </summary>
    private static object? MaskJson(JsonElement json, IReadOnlyList<string> redact) => json.ValueKind switch
    {
        JsonValueKind.Object => json.EnumerateObject().ToDictionary(
            p => p.Name,
            p => redact.Contains(p.Name) ? Redacted : MaskJson(p.Value, redact)),
        JsonValueKind.Array => json.EnumerateArray().Select(v => MaskJson(v, redact)).ToList(),
        _ => json,
    };
}
