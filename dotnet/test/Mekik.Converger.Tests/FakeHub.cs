using System.Net.WebSockets;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Mekik.Converger.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// A fake Converger: the channel-scoped side of the native endpoint (Converger protocol
/// v1 section 10), just enough of it to drive the transport. Bare <c>hello</c> → channel
/// <c>welcome</c>; every conversation frame is <c>{conversationId, frame}</c>; persistent
/// frames get the hub's own seq; a message with an <c>id</c> is acked. Mirror of
/// <c>ts/packages/converger/test/fake-hub.ts</c>.
/// </summary>
internal sealed class FakeHub : IAsyncDisposable
{
    private readonly WebApplication _web;
    private readonly List<Socket> _sockets = new();
    private readonly Dictionary<string, long> _seqs = new();
    private readonly object _lock = new();
    private int _acks;

    public List<(Frame Frame, string? Bearer)> Hellos { get; } = new();
    public List<(string ConversationId, Frame Frame)> Received { get; } = new();
    public List<Frame> Bare { get; } = new();
    public int? RefuseWith { get; set; }
    public string Url { get; private set; } = "";

    private sealed class Socket(WebSocket ws)
    {
        public WebSocket Ws { get; } = ws;
        public SemaphoreSlim SendLock { get; } = new(1, 1);
        public TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private FakeHub(WebApplication web) => _web = web;

    public static async Task<FakeHub> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        var web = builder.Build();
        var hub = new FakeHub(web);
        web.UseWebSockets();
        web.Map("/socket/converger/v1", hub.AcceptAsync);
        await web.StartAsync();
        var address = web.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        hub.Url = address.Replace("http://", "ws://") + "/socket/converger/v1";
        return hub;
    }

    public List<Frame> FramesOf(string conversationId)
    {
        lock (_lock) return Received.Where(e => e.ConversationId == conversationId).Select(e => e.Frame).ToList();
    }

    public int HelloCount
    {
        get { lock (_lock) return Hellos.Count; }
    }

    /// <summary>Deliver a user turn the way Converger does: stored first (a seq), then enveloped.</summary>
    public async Task<long> UserTurnAsync(string conversationId, string text, Dictionary<string, object?>? extra = null)
    {
        long seq;
        lock (_lock) seq = NextSeq(conversationId);
        var frame = new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["id"] = $"act-{conversationId}-{seq}",
            ["seq"] = seq,
            ["from"] = "user",
            ["sender"] = new Dictionary<string, object?> { ["id"] = "alice", ["role"] = "user" },
            ["data"] = new Dictionary<string, object?> { ["text"] = text },
            ["timestamp"] = 1750000000000L,
        };
        foreach (var kv in extra ?? new()) frame[kv.Key] = kv.Value;
        await PushAsync(new Dictionary<string, object?> { ["conversationId"] = conversationId, ["frame"] = frame });
        return seq;
    }

    /// <summary>Forward an end user's bot-only frame (resume, abort, ...) unchanged.</summary>
    public Task ForwardAsync(string conversationId, Frame frame) =>
        PushAsync(new Dictionary<string, object?> { ["conversationId"] = conversationId, ["frame"] = frame });

    public async Task PushAsync(object message)
    {
        List<Socket> sockets;
        lock (_lock) sockets = _sockets.ToList();
        foreach (var s in sockets) await SendAsync(s, message);
    }

    /// <summary>Drop every connection abruptly (a network blip).</summary>
    public void Drop()
    {
        List<Socket> sockets;
        lock (_lock)
        {
            sockets = _sockets.ToList();
            _sockets.Clear();
        }
        foreach (var s in sockets)
        {
            s.Ws.Abort();
            s.Done.TrySetResult();
        }
    }

    public static async Task WaitForAsync(Func<bool> cond, string label, int timeoutMs = 10_000, Func<string>? detail = null)
    {
        var start = Environment.TickCount64;
        while (!cond())
        {
            if (Environment.TickCount64 - start > timeoutMs) throw new TimeoutException($"timed out waiting for {label}{(detail is null ? "" : ": " + detail())}");
            await Task.Delay(5);
        }
    }

    public async ValueTask DisposeAsync()
    {
        Drop();
        await _web.StopAsync();
        await _web.DisposeAsync();
    }

    private long NextSeq(string conversationId)
    {
        var seq = _seqs.GetValueOrDefault(conversationId) + 1;
        _seqs[conversationId] = seq;
        return seq;
    }

    private static async Task SendAsync(Socket s, object message)
    {
        await s.SendLock.WaitAsync();
        try
        {
            if (s.Ws.State == WebSocketState.Open)
                await s.Ws.SendAsync(Encoding.UTF8.GetBytes(Json.Serialize(message)), WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (WebSocketException) { }
        finally { s.SendLock.Release(); }
    }

    private async Task AcceptAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
        var auth = context.Request.Headers.Authorization.ToString();
        var bearer = auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? auth["Bearer ".Length..] : null;
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var socket = new Socket(ws);
        lock (_lock) _sockets.Add(socket);
        var read = ReadAsync(socket, bearer);
        await Task.WhenAny(read, socket.Done.Task);
    }

    private async Task ReadAsync(Socket s, string? bearer)
    {
        var buffer = new byte[64 * 1024];
        using var acc = new MemoryStream();
        while (s.Ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try { result = await s.Ws.ReceiveAsync(buffer, CancellationToken.None); }
            catch (Exception) { return; }
            if (result.MessageType == WebSocketMessageType.Close) return;
            acc.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;
            var msg = (Frame)Json.Parse(Encoding.UTF8.GetString(acc.ToArray()))!;
            acc.SetLength(0);
            await HandleAsync(s, msg, bearer);
        }
    }

    private async Task HandleAsync(Socket s, Frame msg, string? bearer)
    {
        var type = msg.GetValueOrDefault("type") as string;
        if (type == "hello")
        {
            lock (_lock) Hellos.Add((msg, bearer));
            if (RefuseWith is { } code)
            {
                await SendAsync(s, new Dictionary<string, object?>
                {
                    ["type"] = "error",
                    ["data"] = new Dictionary<string, object?> { ["code"] = "unauthorized", ["message"] = "invalid token" },
                });
                await s.Ws.CloseOutputAsync((WebSocketCloseStatus)code, "unauthorized", CancellationToken.None);
                return;
            }
            await SendAsync(s, new Dictionary<string, object?>
            {
                ["type"] = "welcome",
                ["data"] = new Dictionary<string, object?>
                {
                    ["protocol"] = "converger/1",
                    ["compat"] = new List<object?> { "mekik/1" },
                    ["scope"] = "channel",
                    ["channelId"] = "ch-bot",
                    ["connectionId"] = $"hub-{HelloCount}",
                    ["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1_800_000,
                    ["limits"] = new Dictionary<string, object?> { ["idleTimeoutMs"] = 60000L, ["maxConversations"] = 5000L },
                },
            });
            return;
        }
        if (type is not null)
        {
            lock (_lock) Bare.Add(msg);
            if (type == "ping") await SendAsync(s, new Dictionary<string, object?> { ["type"] = "heartbeat", ["timestamp"] = 0L });
            return;
        }
        var conversationId = (string)msg["conversationId"]!;
        var frame = (Frame)msg["frame"]!;
        long? seq = null;
        lock (_lock)
        {
            Received.Add((conversationId, frame));
            if (Protocol.IsPersistent(frame)) seq = NextSeq(conversationId);
        }
        if (seq is { } n && frame.GetValueOrDefault("id") is string id && frame.ContainsKey("from"))
        {
            await SendAsync(s, new Dictionary<string, object?>
            {
                ["conversationId"] = conversationId,
                ["frame"] = new Dictionary<string, object?>
                {
                    ["type"] = "ack",
                    ["clientId"] = id,
                    ["id"] = $"act-{Interlocked.Increment(ref _acks)}",
                    ["seq"] = n,
                    ["timestamp"] = 0L,
                },
            });
        }
    }
}
