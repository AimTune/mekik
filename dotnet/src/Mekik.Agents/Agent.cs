using System.Text.Json;

using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;

namespace Mekik.Agents;

/// <summary>One classification target for <see cref="Agent.RouteAsync"/>: a node name and what it handles.</summary>
public sealed record Route(string Name, string Description);

/// <summary>Options for one <see cref="Agent.RunAsync"/> turn-driving loop.</summary>
public sealed record AgentRunOptions
{
    /// <summary>The system prompt that frames the node's role.</summary>
    public required string System { get; init; }

    /// <summary>The user's message for this turn (usually <c>state.Get&lt;string&gt;("input")</c>).</summary>
    public required string Input { get; init; }

    /// <summary>The tools the model may call. Wrapped with <see cref="MekikTools"/> automatically.</summary>
    public IReadOnlyList<AIFunction> Tools { get; init; } = [];

    /// <summary>Max model↔tool round-trips before the loop gives up (guards runaway calls).</summary>
    public int MaxTurns { get; init; } = 6;

    /// <summary>Per-tool policies (visibility, approval, redaction) forwarded to <see cref="MekikTools.Wrap"/>.</summary>
    public IReadOnlyDictionary<string, ToolPolicy>? Policies { get; init; }

    /// <summary>Default policy for tools without an explicit entry in <see cref="Policies"/>.</summary>
    public ToolPolicy? DefaultPolicy { get; init; }

    /// <summary>Stream text deltas live (one growing bubble via <see cref="Shuttle.StreamText"/>). Default true.</summary>
    public bool Stream { get; init; } = true;

    /// <summary>Reply when the model settles with neither text nor a tool call.</summary>
    public string EmptyReply { get; init; } = "(no reply)";

    /// <summary>Reply when <see cref="MaxTurns"/> is exhausted without the model settling.</summary>
    public string BudgetReply { get; init; } = "I could not finish that within my step budget — please try again.";
}

/// <summary>
/// The agentic model↔tool loop, packaged. A node hands its prompt, the user input
/// and a tool set to <see cref="RunAsync"/>; the model drives — calling tools until
/// it answers — and the reply comes back as a string to return as the node's
/// <c>reply</c>. Mirror of the TypeScript <c>runAgent</c> in @mekik/langchain.
///
/// <para>What the loop owns, so callers don't re-derive it every node:</para>
/// <list type="bullet">
///   <item>tools are wrapped with <see cref="MekikTools"/> — each call is a visible
///   <c>tool_call</c> trace, gated by any approval policy, and journaled exactly-once
///   across an interrupt/resume;</item>
///   <item>each model call runs inside <c>ctx.StepAsync</c>, so a resume replays the
///   recorded decision instead of paying for (and possibly changing) it, and text is
///   not re-streamed;</item>
///   <item>with <see cref="AgentRunOptions.Stream"/> (default), text deltas stream live
///   through <see cref="Shuttle.StreamText"/> — one growing bubble — while the
///   consolidated answer is the returned string.</item>
/// </list>
/// </summary>
public static class Agent
{
    /// <summary>Run the model↔tool loop and return the consolidated reply text.</summary>
    /// <example><code>
    /// return Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
    /// {
    ///     System = prompt,
    ///     Input  = state.Get&lt;string&gt;("input") ?? string.Empty,
    ///     Tools  = BuildTools(scope, user),
    /// }));
    /// </code></example>
    public static async ValueTask<string> RunAsync(IContext ctx, IChatClient chat, AgentRunOptions options)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(chat);
        ArgumentNullException.ThrowIfNull(options);

        // Wrap per run: each wrapper closes over *this* run's ctx, which is what lets a
        // function emit its trace frame and journal itself.
        var tools = MekikTools.Wrap(ctx, options.Tools, options.Policies, options.DefaultPolicy);
        var byName = tools.ToDictionary(t => t.Name);
        var chatOptions = new ChatOptions { Tools = [.. tools] };

        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, options.System),
            new(ChatRole.User, options.Input),
        };

        for (var turn = 0; turn < options.MaxTurns; turn++)
        {
            // Journaled: on the replay pass after an interrupt this returns the recorded
            // decision instead of calling the model again — so the replayed tool keys line
            // up and text is not re-streamed.
            var decision = await ctx.StepAsync<Dictionary<string, object?>>($"agent:llm:{turn}", async () =>
            {
                ChatResponse response;
                if (options.Stream)
                {
                    var updates = new List<ChatResponseUpdate>();
                    await foreach (var update in chat
                        .GetStreamingResponseAsync(messages, chatOptions, ctx.CancellationToken).ConfigureAwait(false))
                    {
                        if (!string.IsNullOrEmpty(update.Text)) Shuttle.Text(ctx, update.Text);
                        updates.Add(update);
                    }
                    response = updates.ToChatResponse();
                }
                else
                {
                    response = await chat.GetResponseAsync(messages, chatOptions, ctx.CancellationToken).ConfigureAwait(false);
                }

                var calls = response.Messages
                    .SelectMany(m => m.Contents)
                    .OfType<FunctionCallContent>()
                    .Select(c => (object?)new Dictionary<string, object?>
                    {
                        ["id"] = c.CallId,
                        ["name"] = c.Name,
                        ["args"] = ToPlainArgs(c.Arguments),
                    })
                    .ToList();

                return new Dictionary<string, object?> { ["text"] = response.Text, ["calls"] = calls };
            }).ConfigureAwait(false);

            var text = decision.GetValueOrDefault("text") as string ?? string.Empty;
            var calls = ((IEnumerable<object?>)(decision.GetValueOrDefault("calls") ?? new List<object?>()))
                .OfType<IReadOnlyDictionary<string, object?>>()
                .ToList();

            // Rebuild the assistant turn from the journal so the replay pass presents the
            // model with exactly the history the first pass did.
            var contents = new List<AIContent>();
            if (!string.IsNullOrEmpty(text)) contents.Add(new TextContent(text));
            foreach (var call in calls)
            {
                contents.Add(new FunctionCallContent(
                    (string)call["id"]!, (string)call["name"]!, ToArgs(call.GetValueOrDefault("args"))));
            }
            messages.Add(new ChatMessage(ChatRole.Assistant, contents));

            if (calls.Count == 0)
            {
                if (string.IsNullOrEmpty(text)) return options.EmptyReply;
                // When streaming, the answer was already delivered live as the durable
                // genui message (streamed chunks are persisted and replayed). Returning
                // it again would emit a second, consolidated `text` frame — the client
                // would show the message twice. So the stream IS the reply: return nothing.
                return options.Stream ? string.Empty : text;
            }

            foreach (var call in calls)
            {
                var callId = (string)call["id"]!;
                var name = (string)call["name"]!;
                // A wrapped function may throw the interrupt that parks the graph; letting
                // it propagate is how the pause reaches the client.
                object? result = byName.TryGetValue(name, out var fn)
                    ? await fn.InvokeAsync(new AIFunctionArguments(ToArgs(call.GetValueOrDefault("args"))), ctx.CancellationToken).ConfigureAwait(false)
                    : $"Unknown tool {name}.";
                messages.Add(new ChatMessage(ChatRole.Tool, new List<AIContent>
                {
                    new FunctionResultContent(callId, result),
                }));
            }
        }

        return options.BudgetReply;
    }

    /// <summary>
    /// Classify <paramref name="input"/> into exactly one of <paramref name="routes"/> and
    /// return the chosen route name — the router-node pattern (classify → goto expert node) in
    /// one call. The classification is journaled (a resume replays the same route), runs at
    /// temperature 0, and is normalized to a valid route name, falling back to
    /// <paramref name="fallback"/> (or the last route) when the model answers off-list.
    /// </summary>
    /// <example><code>
    /// var route = await Agent.RouteAsync(ctx, chat, routes, state.Get&lt;string&gt;("input") ?? "");
    /// return Command.Create(Update.Of("route", route), route);
    /// </code></example>
    public static async ValueTask<string> RouteAsync(
        IContext ctx,
        IChatClient chat,
        IReadOnlyList<Route> routes,
        string input,
        string? fallback = null,
        string stepKey = "route")
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(chat);
        ArgumentNullException.ThrowIfNull(routes);
        if (routes.Count == 0) throw new ArgumentException("RouteAsync needs at least one route.", nameof(routes));

        var choice = await ctx.StepAsync(stepKey, async () =>
        {
            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, RoutePrompt(routes)),
                new(ChatRole.User, input),
            };
            var response = await chat
                .GetResponseAsync(messages, new ChatOptions { Temperature = 0f }, ctx.CancellationToken).ConfigureAwait(false);
            return response.Text ?? string.Empty;
        }).ConfigureAwait(false);

        return NormalizeRoute(choice, routes, fallback);
    }

    private static string RoutePrompt(IReadOnlyList<Route> routes) =>
        "Assign the user's message to EXACTLY ONE category and reply with only the category name (one word):\n"
        + string.Join("\n", routes.Select(r => $"- {r.Name}: {r.Description}"))
        + "\nReply with only the category name — no explanation or punctuation.";

    private static string NormalizeRoute(string modelOutput, IReadOnlyList<Route> routes, string? fallback)
    {
        var text = modelOutput.Trim().ToLowerInvariant();
        foreach (var r in routes)
            if (text.Contains(r.Name.ToLowerInvariant(), StringComparison.Ordinal))
                return r.Name;
        return fallback ?? routes[^1].Name;
    }

    // A model's function-call arguments arrive as JsonElement (System.Text.Json); fold
    // them to plain CLR so the journal round-trips and the reconstructed call rebuilds cleanly.
    private static Dictionary<string, object?> ToPlainArgs(IDictionary<string, object?>? args) =>
        args is null
            ? new Dictionary<string, object?>()
            : args.ToDictionary(kv => kv.Key, kv => kv.Value is JsonElement je ? Json.FromElement(je) : kv.Value);

    private static Dictionary<string, object?> ToArgs(object? value) =>
        value is IReadOnlyDictionary<string, object?> d
            ? new Dictionary<string, object?>(d)
            : new Dictionary<string, object?>();
}
