using System.Text;
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

    /// <summary>Largest request body accepted, in bytes.</summary>
    public const int MaxBodyBytes = 1024 * 1024;

    public static void MapMekikA2a(this IEndpointRouteBuilder endpoints, string path, MekikA2aServer agent, string cardPath = AgentCardPath)
    {
        ArgumentNullException.ThrowIfNull(agent);

        endpoints.MapGet(cardPath, async (HttpContext context) =>
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(Json.Serialize(agent.AgentCard()), context.RequestAborted);
        });

        endpoints.MapPost(path, async (HttpContext context) =>
        {
            var response = context.Response;
            string body;
            using (var reader = new StreamReader(context.Request.Body, Encoding.UTF8))
            {
                body = await reader.ReadToEndAsync(context.RequestAborted);
            }
            if (body.Length > MaxBodyBytes)
            {
                await WriteAsync(response, StatusCodes.Status413PayloadTooLarge, RpcError(-32600, "request body too large"), context.RequestAborted);
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
