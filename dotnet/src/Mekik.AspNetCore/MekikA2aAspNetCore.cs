using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Mekik;

/// <summary>
/// The A2A HTTP transport for mekik (PROTOCOL.md §14), mirror of the TypeScript
/// <c>@mekik/a2a</c>. The Agent Card on <c>GET</c>, one JSON-RPC message per
/// <c>POST</c> handed to <see cref="MekikA2aServer.HandleAsync"/>.
///
/// <code>
/// var agent = new MekikA2aServer(app, new A2aServerOptions { Name = "Support desk", Url = "https://bot.example.com/a2a" });
/// web.MapMekikA2a("/a2a", agent);   // card at /.well-known/agent-card.json
/// </code>
/// </summary>
public static class MekikA2aAspNetCore
{
    /// <summary>The default Agent Card path (A2A 0.3).</summary>
    public const string AgentCardPath = "/.well-known/agent-card.json";

    /// <summary>The default for <c>maxBodyBytes</c>: the largest request body accepted, 1 MiB.</summary>
    public const int MaxBodyBytes = 1024 * 1024;

    /// <summary>Map the A2A endpoint at <paramref name="path"/> and the Agent Card at <paramref name="cardPath"/>.</summary>
    /// <param name="endpoints">The route builder.</param>
    /// <param name="path">The JSON-RPC endpoint path, e.g. <c>/a2a</c>.</param>
    /// <param name="agent">The server that answers each JSON-RPC message.</param>
    /// <param name="cardPath">Where the Agent Card is served. Default <see cref="AgentCardPath"/>.</param>
    /// <param name="maxBodyBytes">
    /// Largest request body accepted, in UTF-8 bytes (default <see cref="MaxBodyBytes"/>, 1 MiB) —
    /// TypeScript's <c>maxBodyBytes</c>. Reading stops as soon as a body passes it, and the
    /// request is answered <c>413</c> with JSON-RPC error <c>-32600</c>.
    /// </param>
    public static void MapMekikA2a(this IEndpointRouteBuilder endpoints, string path, MekikA2aServer agent, string cardPath = AgentCardPath, int maxBodyBytes = MaxBodyBytes)
    {
        ArgumentNullException.ThrowIfNull(agent);
        RequestBody.ValidateMax(maxBodyBytes);

        endpoints.MapGet(cardPath, async (HttpContext context) =>
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(Json.Serialize(agent.AgentCard()), context.RequestAborted);
        });

        endpoints.MapPost(path, async (HttpContext context) =>
        {
            var response = context.Response;
            var body = await RequestBody.ReadAsync(context.Request, maxBodyBytes, context.RequestAborted);
            if (body is null)
            {
                await WriteAsync(response, StatusCodes.Status413PayloadTooLarge, RequestBody.TooLarge(), context.RequestAborted);
                return;
            }

            object? message;
            try { message = Json.Parse(body); }
            catch
            {
                await WriteAsync(response, StatusCodes.Status400BadRequest, RpcError(-32700, "parse error"), context.RequestAborted);
                return;
            }

            var reply = await agent.HandleAsync(message);
            if (reply is null)
            {
                response.StatusCode = StatusCodes.Status202Accepted;
                return;
            }
            await WriteAsync(response, StatusCodes.Status200OK, reply, context.RequestAborted);
        });
    }

    private static Dictionary<string, object?> RpcError(int code, string message) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = null,
        ["error"] = new Dictionary<string, object?> { ["code"] = (long)code, ["message"] = message },
    };

    private static async Task WriteAsync(HttpResponse response, int status, IReadOnlyDictionary<string, object?> payload, CancellationToken ct)
    {
        response.StatusCode = status;
        response.ContentType = "application/json";
        await response.WriteAsync(Json.Serialize(payload), ct);
    }
}
