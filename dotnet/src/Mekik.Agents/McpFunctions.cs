using System.Text.Json;
using Ilmek;
using Microsoft.Extensions.AI;

namespace Mekik.Agents;

/// <summary>One tool an MCP server exposes, as <see cref="McpFunctions.Wrap"/> needs it — the shape of <c>Ilmek.Mcp</c>'s <c>McpTool</c>.</summary>
public sealed record RemoteToolInfo
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    /// <summary>JSON Schema for the arguments, as a plain dictionary.</summary>
    public IReadOnlyDictionary<string, object?> InputSchema { get; init; } = new Dictionary<string, object?> { ["type"] = "object" };
}

/// <summary>The normalized result of a remote tool call — the shape of <c>Ilmek.Mcp</c>'s <c>McpToolResult</c>.</summary>
public sealed record RemoteToolResult
{
    public required string Text { get; init; }
    public IReadOnlyDictionary<string, object?>? Structured { get; init; }
    public bool IsError { get; init; }
}

/// <summary>Invokes one remote tool by its exposed name — <c>Ilmek.Mcp</c>'s <c>McpToolbox.InvokeAsync</c>, or anything with that shape.</summary>
public delegate Task<RemoteToolResult> RemoteToolInvoker(string name, IReadOnlyDictionary<string, object?> arguments, CancellationToken ct);

/// <summary>
/// An MCP server's tools as <see cref="AIFunction"/>s with the mekik treatment
/// (PROTOCOL.md §13): each call is a <c>tool_call</c> trace, runs exactly once
/// across an interrupt/resume, and may require human approval — the same
/// <see cref="ToolPolicy"/> map as server functions, keyed by the exposed tool name.
/// The .NET counterpart of <c>@mekik/langchain</c>'s <c>withMcpTools</c>.
/// </summary>
/// <remarks>
/// Two ways in. With the official <c>ModelContextProtocol</c> client, its
/// <c>McpClientTool</c>s already are <see cref="AIFunction"/>s — hand them to
/// <see cref="MekikTools.Wrap"/> directly. With <c>Ilmek.Mcp</c>'s toolbox (or any
/// tool list plus an invoker), use this: it builds the functions from the tool
/// descriptors and delegates each call to the invoker, then wraps them the same way.
/// The observation the model reads is the result's text (or its structured content
/// when there is no text); a result the server flagged as an error comes back as
/// <c>Error from &lt;tool&gt;: …</c> — an observation, not a crash.
/// </remarks>
/// <example><code>
/// var github = await McpToolbox.ConnectAsync(client, new() { Name = "github" });   // Ilmek.Mcp
/// var tools = MekikTools.Wrap(ctx, serverFunctions, policies)
///     .Concat(McpFunctions.Wrap(ctx,
///         github.Tools().Select(t => new RemoteToolInfo { Name = t.Name, Description = t.Description, InputSchema = t.InputSchema }),
///         async (name, args, ct) => { var r = await github.InvokeAsync(name, args, ct); return new RemoteToolResult { Text = r.Text, Structured = r.Structured, IsError = r.IsError }; },
///         new Dictionary&lt;string, ToolPolicy&gt; { ["github__create_issue"] = new ToolPolicy { Approve = new ApproveSpec() } }))
///     .ToList();
/// </code></example>
public static class McpFunctions
{
    /// <summary>Build and wrap the functions; see the class remarks.</summary>
    public static IReadOnlyList<AIFunction> Wrap(
        IContext ctx,
        IEnumerable<RemoteToolInfo> tools,
        RemoteToolInvoker invoke,
        IReadOnlyDictionary<string, ToolPolicy>? policies = null,
        ToolPolicy? defaultPolicy = null)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(tools);
        ArgumentNullException.ThrowIfNull(invoke);
        var raw = tools.Select(t => (AIFunction)new RemoteToolFunction(t, invoke)).ToList();
        return MekikTools.Wrap(ctx, raw, policies, defaultPolicy);
    }

    private sealed class RemoteToolFunction : AIFunction
    {
        private readonly RemoteToolInfo _tool;
        private readonly RemoteToolInvoker _invoke;
        private readonly JsonElement _schema;

        internal RemoteToolFunction(RemoteToolInfo tool, RemoteToolInvoker invoke)
        {
            _tool = tool;
            _invoke = invoke;
            using var doc = JsonDocument.Parse(Json.Canonicalize(tool.InputSchema));
            _schema = doc.RootElement.Clone();
        }

        public override string Name => _tool.Name;
        public override string Description => _tool.Description ?? $"The {_tool.Name} tool of an MCP server.";
        public override JsonElement JsonSchema => _schema;

        protected override async ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
        {
            var args = arguments.ToDictionary(kv => kv.Key, kv => kv.Value is JsonElement je ? Json.FromElement(je) : kv.Value);
            var result = await _invoke(_tool.Name, args, cancellationToken).ConfigureAwait(false);
            var text = result.Text.Length > 0 ? result.Text : result.Structured is not null ? Json.Canonicalize(result.Structured) : "";
            if (result.IsError) return $"Error from {_tool.Name}: {(text.Length > 0 ? text : "the tool reported an error")}";
            return text.Length > 0 ? text : "(empty result)";
        }
    }
}
