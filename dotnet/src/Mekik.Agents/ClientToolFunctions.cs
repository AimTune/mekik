using System.Text.Json;
using Ilmek;
using Microsoft.Extensions.AI;

namespace Mekik.Agents;

/// <summary>
/// The <b>client's</b> declared tools as <see cref="AIFunction"/>s, so a model
/// can call the UI the same way it calls a server tool (PROTOCOL.md §11). The
/// .NET counterpart of <c>@mekik/langchain</c>'s <c>withClientTools</c>.
/// </summary>
/// <remarks>
/// Reads <see cref="Shuttle.ClientTools(IContext, IReadOnlyList{string}?, string?)"/>
/// — the tools the connected frontend declared and the server accepted — and
/// wraps each one in an <see cref="AIFunction"/> whose executor is
/// <see cref="Shuttle.CallClientToolAsync{T}"/>. A <c>"call"</c>-mode tool parks
/// the run until the client's handler answers (the pause is durable, like any
/// mekik interrupt); a <c>"notify"</c>-mode tool streams the invocation and
/// returns a delivery note the model can read. A handler error comes back as an
/// error observation (the agent loop stays alive), and the <c>tool_call</c>
/// running → completed/error trace is emitted for you.
/// </remarks>
/// <example><code>
/// var tools = MekikTools.Wrap(ctx, serverFunctions, policies)
///     .Concat(ClientToolFunctions.Wrap(ctx, tags: ["billing"]))
///     .ToList();
/// </code></example>
public static class ClientToolFunctions
{
    /// <summary>Wrap the turn's client tools (optionally tag/mode-filtered) as AIFunctions.</summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="tags">Optional tag filter — see <see cref="Shuttle.ClientTools(IContext, IReadOnlyList{string}?, string?)"/>.</param>
    /// <param name="mode">Optional invocation-mode filter (<c>"call"</c> or <c>"notify"</c>).</param>
    public static IReadOnlyList<AIFunction> Wrap(IContext ctx, IReadOnlyList<string>? tags = null, string? mode = null)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        return Shuttle.ClientTools(ctx, tags, mode)
            .Select(def => (AIFunction)new ClientToolFunction(ctx, def))
            .ToList();
    }

    private sealed class ClientToolFunction : AIFunction, IMekikFunction
    {
        private static readonly JsonElement EmptyObjectSchema = JsonDocument.Parse("""{"type":"object","properties":{}}""").RootElement;

        private readonly IContext _ctx;
        private readonly ClientToolDefinition _def;
        private readonly JsonElement _schema;

        internal ClientToolFunction(IContext ctx, ClientToolDefinition def)
        {
            _ctx = ctx;
            _def = def;
            if (def.Parameters is not null)
            {
                // The declared JSON Schema is what the model sees, verbatim.
                using var doc = JsonDocument.Parse(Json.Canonicalize(def.Parameters));
                _schema = doc.RootElement.Clone();
            }
            else
            {
                _schema = EmptyObjectSchema;
            }
        }

        public override string Name => _def.Name;
        public override string Description => _def.Description ?? $"Invoke the client's \"{_def.Name}\" tool.";
        public override JsonElement JsonSchema => _schema;

        protected override async ValueTask<object?> InvokeCoreAsync(
            AIFunctionArguments arguments, CancellationToken cancellationToken)
        {
            var @params = arguments.ToDictionary(kv => kv.Key, kv => kv.Value);
            try
            {
                var result = await Shuttle.CallClientToolAsync<object?>(_ctx, _def.Name, @params).ConfigureAwait(false);
                return result ?? $"Delivered {_def.Name} to the client.";
            }
            catch (InterruptSignalException)
            {
                throw; // the pause IS the mechanism — never swallow it
            }
            catch (Exception ex)
            {
                // A failed client handler is an observation, not a crash: the
                // model reads the error and can route around it.
                return $"Error from client tool {_def.Name}: {ex.Message}";
            }
        }
    }
}
