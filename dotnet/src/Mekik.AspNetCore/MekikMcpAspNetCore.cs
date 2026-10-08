using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Mekik;

/// <summary>
/// The MCP Streamable HTTP transport for mekik (PROTOCOL.md §13), mirror of the
/// TypeScript <c>@mekik/mcp</c>. A thin adapter: one JSON-RPC message per
/// <c>POST</c>, handed to <see cref="MekikMcpServer.HandleAsync"/>; the response is
/// written back (<c>202</c> for a notification). <c>GET</c> is <c>405</c> — this
/// transport does not open a server-to-client stream; <c>DELETE</c> ends a
/// (stateless) session with <c>200</c>.
///
/// <code>
/// var mcp = new MekikMcpServer(app, new McpServerOptions { Name = "support_desk", Description = "Answers support questions." });
/// web.MapMekikMcp("/mcp", mcp);
/// </code>
/// </summary>
public static class MekikMcpAspNetCore
{
    /// <summary>The default for <c>maxBodyBytes</c>: the largest request body accepted, 1 MiB.</summary>
    public const int MaxBodyBytes = 1024 * 1024;

    /// <summary>Map the MCP endpoint at <paramref name="path"/>.</summary>
    /// <param name="endpoints">The route builder.</param>
    /// <param name="path">The endpoint path, e.g. <c>/mcp</c>.</param>
    /// <param name="mcp">The server that answers each JSON-RPC message.</param>
    /// <param name="maxBodyBytes">
    /// Largest request body accepted, in UTF-8 bytes (default <see cref="MaxBodyBytes"/>, 1 MiB) —
    /// TypeScript's <c>maxBodyBytes</c>. Reading stops as soon as a body passes it, and the
    /// request is answered <c>413</c> with JSON-RPC error <c>-32600</c>.
    /// </param>
    public static void MapMekikMcp(this IEndpointRouteBuilder endpoints, string path, MekikMcpServer mcp, int maxBodyBytes = MaxBodyBytes)
    {
        ArgumentNullException.ThrowIfNull(mcp);
        RequestBody.ValidateMax(maxBodyBytes);
        endpoints.Map(path, async (HttpContext context) =>
        {
            var response = context.Response;
            switch (context.Request.Method)
            {
                case "DELETE":
                    response.StatusCode = StatusCodes.Status200OK;
                    return;
                case "POST":
                    break;
                default:
                    response.StatusCode = StatusCodes.Status405MethodNotAllowed;
                    response.Headers.Allow = "POST, DELETE";
                    return;
            }

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
                await WriteAsync(response, StatusCodes.Status400BadRequest, RpcError(MekikMcpServer.ParseError, "parse error"), context.RequestAborted);
                return;
            }

            var reply = await mcp.HandleAsync(message);
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
