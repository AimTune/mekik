using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Mekik;

/// <summary>
/// The ASP.NET Core WebSocket transport (PROTOCOL.md §2), mirror of the
/// TypeScript <c>@mekik/ws</c>. A thin adapter: it turns each socket into an
/// <see cref="IConnection"/> and forwards frames to a <see cref="MekikApp"/> —
/// all protocol logic lives in the engine.
///
/// <code>
/// var builder = WebApplication.CreateBuilder(args);
/// var web = builder.Build();
/// web.UseWebSockets();
/// web.MapMekik("/ws", new MekikApp(new MekikOptions { Graph = graph }));
/// web.Run();
/// </code>
/// </summary>
public static class MekikAspNetCore
{
    public static void MapMekik(this IEndpointRouteBuilder endpoints, string path, MekikApp app)
    {
        endpoints.Map(path, async (HttpContext context) =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }

            using var ws = await context.WebSockets.AcceptWebSocketAsync();
            var conn = new WebSocketConnection(ws);
            var connected = false;

            try
            {
                await foreach (var text in ReadFramesAsync(ws, context.RequestAborted))
                {
                    if (!connected)
                    {
                        connected = true;
                        await app.ConnectAsync(conn, MergeConnectParams(context, text));
                        // A non-hello first frame (identity came via query) still needs processing.
                        if (!IsHelloFrame(text)) await app.ReceiveAsync(conn, text);
                        continue;
                    }
                    await app.ReceiveAsync(conn, text);
                }
            }
            finally
            {
                if (connected) app.Disconnect(conn);
                await conn.DisposeAsync();
            }
        });
    }

    private static async IAsyncEnumerable<string> ReadFramesAsync(WebSocket ws, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var buffer = new byte[8192];
        var acc = new List<byte>();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            WebSocketReceiveResult result;
            try { result = await ws.ReceiveAsync(buffer, ct); }
            catch (OperationCanceledException) { yield break; }
            catch (WebSocketException) { yield break; }

            if (result.MessageType == WebSocketMessageType.Close) yield break;

            acc.AddRange(buffer.AsSpan(0, result.Count).ToArray());
            if (!result.EndOfMessage) continue;

            var text = Encoding.UTF8.GetString(acc.ToArray());
            acc.Clear();
            yield return text;
        }
    }

    /// <summary>Identity may travel in the URL query string OR the first `hello` frame; merge, frame wins.</summary>
    private static ConnectParams MergeConnectParams(HttpContext context, string firstFrame)
    {
        var q = context.Request.Query;
        var hello = new HelloInfo
        {
            UserId = q["userId"].FirstOrDefault(),
            ConversationId = q["conversationId"].FirstOrDefault(),
            Watermark = long.TryParse(q["watermark"].FirstOrDefault(), out var wm) ? wm : null,
            Token = q["token"].FirstOrDefault() ?? Bearer(context),
        };

        if (IsHelloFrame(firstFrame) && Json.Parse(firstFrame) is IReadOnlyDictionary<string, object?> h)
        {
            hello = hello with
            {
                UserId = h.GetValueOrDefault("userId") as string ?? hello.UserId,
                ConversationId = h.GetValueOrDefault("conversationId") as string ?? hello.ConversationId,
                Watermark = h.GetValueOrDefault("watermark") is long w ? w : hello.Watermark,
                Token = h.GetValueOrDefault("token") as string ?? hello.Token,
                Meta = h.GetValueOrDefault("meta") as IReadOnlyDictionary<string, object?>,
            };
        }

        var headers = context.Request.Headers.ToDictionary(h => h.Key, h => (string?)h.Value.ToString());
        return new ConnectParams
        {
            Hello = hello,
            Credential = new Credential
            {
                Token = hello.Token,
                Headers = headers,
                Query = q.ToDictionary(kv => kv.Key, kv => (string?)kv.Value.ToString()),
            },
        };
    }

    private static string? Bearer(HttpContext context)
    {
        var auth = context.Request.Headers.Authorization.ToString();
        return auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? auth["Bearer ".Length..] : null;
    }

    private static bool IsHelloFrame(string text)
    {
        try { return Json.Parse(text) is IReadOnlyDictionary<string, object?> d && d.GetValueOrDefault("type") as string == "hello"; }
        catch { return false; }
    }
}

/// <summary>An <see cref="IConnection"/> over a single ASP.NET Core <see cref="WebSocket"/>.</summary>
internal sealed class WebSocketConnection : IConnection, IAsyncDisposable
{
    public string Id { get; } = $"connection-{Guid.NewGuid():N}";

    private readonly WebSocket _ws;
    private readonly Channel<string> _outbound = System.Threading.Channels.Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Task _writer;

    public WebSocketConnection(WebSocket ws)
    {
        _ws = ws;
        // Serialize writes: Send is synchronous (IConnection), the socket write is
        // not — a single writer drains the queue in order.
        _writer = Task.Run(WritePumpAsync);
    }

    public void Send(IReadOnlyDictionary<string, object?> frame) => _outbound.Writer.TryWrite(Json.Serialize(frame));

    public void Close(int? code = null, string? reason = null) => _outbound.Writer.TryComplete();

    private async Task WritePumpAsync()
    {
        await foreach (var text in _outbound.Reader.ReadAllAsync())
        {
            if (_ws.State != WebSocketState.Open) break;
            var bytes = Encoding.UTF8.GetBytes(text);
            try { await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None); }
            catch (WebSocketException) { break; }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _outbound.Writer.TryComplete();
        try { await _writer; } catch { /* writer already faulted/closed */ }
    }
}
