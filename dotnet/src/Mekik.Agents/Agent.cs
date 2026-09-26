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

    /// <summary>
    /// Max model↔tool round-trips — how many times the model may run again after calling
    /// tools. Default 25. Individual tool invocations do NOT consume turns: a round that
    /// fires five tools still costs one turn. Cap raw tool usage with <see cref="MaxToolCalls"/>.
    /// </summary>
    public int MaxTurns { get; init; } = 25;

    /// <summary>Max total tool invocations across the run. Default 25.</summary>
    public int MaxToolCalls { get; init; } = 25;

    /// <summary>Per-tool policies (visibility, approval, redaction) forwarded to <see cref="MekikTools.Wrap"/>.</summary>
    public IReadOnlyDictionary<string, ToolPolicy>? Policies { get; init; }

    /// <summary>Default policy for tools without an explicit entry in <see cref="Policies"/>.</summary>
    public ToolPolicy? DefaultPolicy { get; init; }

    /// <summary>Stream text deltas live (one growing bubble via <see cref="Shuttle.StreamText"/>). Default true.</summary>
    public bool Stream { get; init; } = true;

    /// <summary>Reply when the model settles with neither text nor a tool call.</summary>
    public string EmptyReply { get; init; } = "(no reply)";

    /// <summary>Reply when <see cref="MaxTurns"/> or <see cref="MaxToolCalls"/> is exhausted without the model settling.</summary>
    public string BudgetReply { get; init; } = "I could not finish that within my step budget — please try again.";

    /// <summary>
    /// Give the model the turn's skills (PROTOCOL.md §12): the <c>&lt;available_skills&gt;</c>
    /// block is appended to <see cref="System"/> and the <see cref="SkillFunctions"/> join
    /// <see cref="Tools"/>. Off by default — a node that never mentions skills is unchanged.
    /// Scope with <see cref="SkillTags"/> / <see cref="SkillSource"/>.
    /// </summary>
    public bool Skills { get; init; }

    /// <summary>Tag filter for <see cref="Skills"/>; see <see cref="Shuttle.Skills"/>.</summary>
    public IReadOnlyList<string>? SkillTags { get; init; }

    /// <summary>Origin filter for <see cref="Skills"/> (<see cref="SkillOrigin.Server"/> / <see cref="SkillOrigin.Client"/>).</summary>
    public string? SkillSource { get; init; }
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
        var tools = MekikTools.Wrap(ctx, options.Tools, options.Policies, options.DefaultPolicy).ToList();

        // Skills (§12): level 1 goes in the prompt, levels 2–3 become functions. The
        // skill functions are not wrapped with MekikTools — a load is a catalog read
        // that emits its own `skill` trace, not a side effect to journal.
        var system = options.System;
        if (options.Skills)
        {
            var block = Shuttle.SkillsPrompt(ctx, options.SkillTags, options.SkillSource);
            if (block.Length > 0) system = system.Length > 0 ? $"{system}\n\n{block}" : block;
            tools.AddRange(SkillFunctions.Wrap(ctx, options.SkillTags, options.SkillSource));
        }

        var byName = tools.ToDictionary(t => t.Name);
        var chatOptions = new ChatOptions { Tools = [.. tools] };

        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, system),
            new(ChatRole.User, options.Input),
        };

        // `turn` counts model rounds, not tool invocations — a round that fires several
        // tools still costs one turn. `toolCallsUsed` tracks the raw tool budget
        // separately for callers that set MaxToolCalls.
        var toolCallsUsed = 0;

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

            toolCallsUsed += calls.Count;
            if (toolCallsUsed > options.MaxToolCalls) return options.BudgetReply;

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
    /// one call. The classification is journaled (a resume replays the same route) and is
    /// normalized to a valid route name, falling back to <paramref name="fallback"/> (or the
    /// last route) when the model answers off-list.
    ///
    /// <para>No sampling options are sent unless you ask for them: reasoning models
    /// (gpt-5.x and friends) reject any non-default <c>temperature</c> with HTTP 400,
    /// which would fail every classification rather than degrade it. Pass
    /// <paramref name="temperature"/> (e.g. <c>0f</c>) when the model behind
    /// <paramref name="chat"/> accepts it; otherwise configure sampling on the
    /// <see cref="IChatClient"/> itself. The prompt already pins the answer to one word,
    /// and an off-list answer falls back — determinism is not load-bearing here.</para>
    /// </summary>
    /// <example><code>
    /// var route = await Agent.RouteAsync(ctx, chat, routes, state.Get&lt;string&gt;("input") ?? "");
    /// return Command.Create(Update.Of("route", route), route);
    /// </code></example>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="chat">The model that classifies.</param>
    /// <param name="routes">The candidate nodes — name plus what each handles.</param>
    /// <param name="input">The user's message for this turn.</param>
    /// <param name="fallback">Route to use when the model answers off-list. Default: the last route.</param>
    /// <param name="stepKey">Journal key, when a node routes more than once.</param>
    /// <param name="temperature">Sampling temperature. Default: unset — nothing is sent.</param>
    public static async ValueTask<string> RouteAsync(
        IContext ctx,
        IChatClient chat,
        IReadOnlyList<Route> routes,
        string input,
        string? fallback = null,
        string stepKey = "route",
        float? temperature = null)
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
            // Null options, not an empty ChatOptions: a provider that rejects an
            // explicitly-set temperature must never see one it did not ask for.
            var options = temperature is null ? null : new ChatOptions { Temperature = temperature };
            var response = await chat
                .GetResponseAsync(messages, options, ctx.CancellationToken).ConfigureAwait(false);
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
