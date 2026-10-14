using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace Mekik;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>Options for <see cref="ConvergerTransport"/>, mirror of the TypeScript <c>ConvergerOptions</c>.</summary>
public sealed record ConvergerOptions
{
    /// <summary>The native endpoint, e.g. <c>wss://hub.example/socket/converger/v1</c>.</summary>
    public required string Url { get; init; }
    /// <summary>
    /// A fixed channel-scoped token (<c>scope: "channel"</c>). It cannot be renewed, so the
    /// transport stops when Converger rejects it (close 4401). Prefer <see cref="TokenProvider"/>
    /// or <see cref="Secret"/> for a long-running process.
    /// </summary>
    public string? Token { get; init; }
    /// <summary>Returns a fresh channel-scoped token; called on every (re)connect and before the token expires.</summary>
    public Func<CancellationToken, Task<string>>? TokenProvider { get; init; }
    /// <summary>The bot channel's secret: tokens are minted with <c>POST {ApiUrl}/api/v1/converger/tokens/generate</c>.</summary>
    public string? Secret { get; init; }
    /// <summary>Base URL of Converger's HTTP API for <see cref="Secret"/>. Default: <see cref="Url"/>'s origin, <c>ws(s)</c> → <c>http(s)</c>.</summary>
    public string? ApiUrl { get; init; }
    /// <summary><c>hello.group</c>: processes sharing a group share the channel's conversations, one serving each.</summary>
    public string? Group { get; init; }
    /// <summary>
    /// Which of a user turn's <c>metadata</c> / <c>meta</c> keys (meta wins) reach the engine as the
    /// turn's client meta (then <c>AcceptClientMeta</c>, PROTOCOL.md §6). Default: none.
    /// </summary>
    public IReadOnlyList<string>? Meta { get; init; }
    /// <summary>The function form of <see cref="Meta"/>; wins when both are set.</summary>
    public Func<IReadOnlyDictionary<string, object?>, IReadOnlyDictionary<string, object?>?>? MetaFilter { get; init; }
    /// <summary>Disconnect a conversation's virtual connection after this long without traffic. Default: 15 minutes.</summary>
    public TimeSpan IdleTimeout { get; init; } = TimeSpan.FromMinutes(15);
    /// <summary>Turns (<c>text</c>, <c>resume</c>, <c>genui_event</c>) running at once across all conversations. Default: unlimited.</summary>
    public int? MaxConcurrentTurns { get; init; }
    /// <summary>Conversations whose watermark is remembered for the re-hello after a reconnect. Default: 5000.</summary>
    public int MaxConversations { get; init; } = 5000;
    /// <summary>Reconnect backoff floor (full jitter over an exponential ceiling). Default: 500 ms.</summary>
    public TimeSpan ReconnectMin { get; init; } = TimeSpan.FromMilliseconds(500);
    /// <summary>Reconnect backoff ceiling. Default: 30 s.</summary>
    public TimeSpan ReconnectMax { get; init; } = TimeSpan.FromSeconds(30);
    /// <summary>Persistent frames buffered while the socket is down. Default: 10 000.</summary>
    public int MaxBuffered { get; init; } = 10_000;
    /// <summary>Transport problems: a dropped socket, a refused token, a hub error about a conversation.</summary>
    public Action<Exception>? OnError { get; init; }
    /// <summary>The HTTP client for <see cref="Secret"/> mode. Default: a shared one.</summary>
    public HttpClient? HttpClient { get; init; }
}

/// <summary>
/// The Converger transport (PROTOCOL.md "Running behind a hub"), mirror of the TypeScript
/// <c>@mekik/converger</c>. Like <c>MapMekik</c> it only speaks sockets — all protocol logic
/// stays in the engine — but it dials OUT: one <see cref="ClientWebSocket"/> from this process to
/// Converger's channel-scoped agent socket, every conversation multiplexed on it as
/// <c>{conversationId, frame}</c>. Each conversation becomes one virtual <see cref="IConnection"/>,
/// driven through <see cref="MekikApp.ConnectAsync"/> / <see cref="MekikApp.ReceiveAsync"/> /
/// <see cref="MekikApp.Disconnect"/>.
/// <code>
/// var app = new MekikApp(new MekikOptions { Graph = graph }.WithExternalTranscript());
/// await using var hub = ConvergerTransport.Connect(app, new ConvergerOptions
/// {
///     Url = "wss://hub.example/socket/converger/v1",
///     Secret = Environment.GetEnvironmentVariable("CONVERGER_SECRET"),
/// });
/// await hub.Ready;
/// </code>
/// </summary>
public sealed class ConvergerTransport : IAsyncDisposable
{
    /// <summary>Converger's protocol id, sent in <c>hello</c>.</summary>
    public const string Protocol = "converger/1";

    private static readonly HashSet<string> Forwarded = ["resume", "genui_event", "client_tools", "client_skills", "abort"];
    private static readonly HashSet<string> Turns = ["text", "resume", "genui_event"];
    private static readonly HashSet<string> NotATurn = ["typing", "event", "conversationUpdate"];
    private static readonly HttpClient SharedHttp = new();

    private readonly MekikApp _app;
    private readonly ConvergerOptions _opts;
    private readonly ExternalTranscript _transcript;
    private readonly Dictionary<string, Virtual> _virtuals = new();
    private readonly Dictionary<string, (long Seq, long Stamp)> _watermarks = new();
    private long _stamp;
    private readonly List<string> _outbox = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim? _turnSlots;
    private readonly CancellationTokenSource _closing = new();
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _loop;
    private Channel<string>? _outbound;
    private bool _welcomed;
    private Timer? _pingTimer;
    private Timer? _refreshTimer;

    private ConvergerTransport(MekikApp app, ConvergerOptions options)
    {
        if (app.History is not ExternalTranscriptHistoryStore history)
            throw new ArgumentException("ConvergerTransport needs the external-transcript profile: new MekikOptions { ... }.WithExternalTranscript()", nameof(app));
        if (options.Token is null && options.TokenProvider is null && options.Secret is null)
            throw new ArgumentException("ConvergerTransport needs Token, TokenProvider or Secret", nameof(options));
        _app = app;
        _opts = options;
        _transcript = history.Transcript;
        _turnSlots = options.MaxConcurrentTurns is { } max ? new SemaphoreSlim(max, max) : null;
        _ = _ready.Task.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
        _loop = Task.Run(RunAsync);
    }

    /// <summary>Serve <paramref name="app"/> behind Converger. The app must use the external-transcript profile.</summary>
    public static ConvergerTransport Connect(MekikApp app, ConvergerOptions options) => new(app, options);

    /// <summary>Completes on the first <c>welcome</c>; faults if the transport stops before it.</summary>
    public Task Ready => _ready.Task;

    /// <summary>Whether the socket is open and welcomed.</summary>
    public bool Connected
    {
        get { lock (_lock) return _welcomed; }
    }

    /// <summary>Live virtual connections (conversations being served).</summary>
    public int Conversations
    {
        get { lock (_lock) return _virtuals.Count; }
    }

    /// <summary>Mint a channel-scoped token with the channel secret (Converger client API).</summary>
    public static async Task<string> GenerateChannelTokenAsync(string apiUrl, string secret, HttpClient? http = null, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(apiUrl), "/api/v1/converger/tokens/generate"))
        {
            Content = new StringContent("{\"scope\":\"channel\"}", Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        using var res = await (http ?? SharedHttp).SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"converger token generation failed: HTTP {(int)res.StatusCode}");
        var body = Json.Parse(await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false)) as Frame;
        return body?.GetValueOrDefault("token") as string ?? throw new InvalidOperationException("converger token generation returned no token");
    }

    /// <summary>Disconnect every conversation and close the socket.</summary>
    public async ValueTask DisposeAsync()
    {
        if (_closing.IsCancellationRequested) return;
        _closing.Cancel();
        List<string> ids;
        lock (_lock) ids = _virtuals.Keys.ToList();
        foreach (var id in ids) Evict(id);
        _ready.TrySetException(new OperationCanceledException("converger transport closed"));
        try { await _loop.ConfigureAwait(false); } catch { /* the loop reports its own errors */ }
    }

    // ── the socket ────────────────────────────────────────────────────────────

    private async Task RunAsync()
    {
        var attempt = 0;
        var ct = _closing.Token;
        while (!ct.IsCancellationRequested)
        {
            int? closeCode = null;
            try
            {
                var token = await TokenAsync(ct).ConfigureAwait(false);
                using var ws = new ClientWebSocket();
                ws.Options.SetRequestHeader("Authorization", $"Bearer {token}");
                await ws.ConnectAsync(new Uri(_opts.Url), ct).ConfigureAwait(false);
                var outbound = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
                var writer = WritePumpAsync(ws, outbound.Reader);
                lock (_lock) _outbound = outbound;
                outbound.Writer.TryWrite(Json.Serialize(Hello()));
                try
                {
                    closeCode = await ReadLoopAsync(ws, () => attempt = 0, ct).ConfigureAwait(false);
                }
                finally
                {
                    lock (_lock)
                    {
                        _welcomed = false;
                        _outbound = null;
                    }
                    StopTimers();
                    outbound.Writer.TryComplete();
                    if (ws.State == WebSocketState.Open)
                    {
                        try
                        {
                            using var grace = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                            await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "closing", grace.Token).ConfigureAwait(false);
                        }
                        catch { /* already gone */ }
                    }
                    try { await writer.ConfigureAwait(false); } catch { /* socket gone */ }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { Report(ex); }

            if (ct.IsCancellationRequested) break;
            // A fixed token Converger refused cannot get better by retrying.
            if (closeCode == 4401 && _opts.TokenProvider is null && _opts.Secret is null)
            {
                var err = new InvalidOperationException("converger refused the token (close 4401); use Secret or TokenProvider to renew it");
                Report(err);
                _ready.TrySetException(err);
                return;
            }
            Report(new WebSocketException($"converger socket closed ({closeCode?.ToString() ?? "error"}); reconnecting"));
            // Full jitter: a fleet of mekik processes does not reconnect in lockstep.
            var ceiling = Math.Min(_opts.ReconnectMax.TotalMilliseconds, _opts.ReconnectMin.TotalMilliseconds * Math.Pow(2, attempt++));
            var delay = Math.Max(_opts.ReconnectMin.TotalMilliseconds / 2, Random.Shared.NextDouble() * ceiling);
            try { await Task.Delay(TimeSpan.FromMilliseconds(delay), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task<string> TokenAsync(CancellationToken ct)
    {
        if (_opts.TokenProvider is { } provider) return await provider(ct).ConfigureAwait(false);
        if (_opts.Secret is { } secret)
            return await GenerateChannelTokenAsync(_opts.ApiUrl ?? HttpOrigin(_opts.Url), secret, _opts.HttpClient, ct).ConfigureAwait(false);
        return _opts.Token!;
    }

    /// <summary>One bare hello; every conversation still remembered resumes from its watermark.</summary>
    private Dictionary<string, object?> Hello()
    {
        var hello = new Dictionary<string, object?> { ["type"] = "hello", ["protocol"] = Protocol };
        if (_opts.Group is not null) hello["group"] = _opts.Group;
        lock (_lock)
        {
            if (_watermarks.Count > 0)
                hello["watermarks"] = _watermarks.ToDictionary(kv => kv.Key, kv => (object?)kv.Value.Seq);
        }
        return hello;
    }

    private static async Task WritePumpAsync(ClientWebSocket ws, ChannelReader<string> reader)
    {
        await foreach (var text in reader.ReadAllAsync().ConfigureAwait(false))
        {
            if (ws.State != WebSocketState.Open) break;
            await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None).ConfigureAwait(false);
        }
    }

    /// <summary>Reads until the socket closes; returns its close code.</summary>
    private async Task<int?> ReadLoopAsync(ClientWebSocket ws, Action welcomed, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var acc = new MemoryStream();
        while (ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try { result = await ws.ReceiveAsync(buffer, ct).ConfigureAwait(false); }
            catch (WebSocketException) { return null; }
            if (result.MessageType == WebSocketMessageType.Close) return (int?)result.CloseStatus;
            acc.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;
            var text = Encoding.UTF8.GetString(acc.GetBuffer(), 0, (int)acc.Length);
            acc.SetLength(0);
            try { OnMessage(text, welcomed); }
            catch (Exception ex) { Report(ex); }
        }
        return (int?)ws.CloseStatus;
    }

    /// <summary>A frame the engine produced for one conversation, sent in its envelope.</summary>
    internal void Emit(string conversationId, Frame frame)
    {
        var text = Json.Serialize(new Dictionary<string, object?> { ["conversationId"] = conversationId, ["frame"] = frame });
        lock (_lock)
        {
            if (_welcomed && _outbound is { } outbound && outbound.Writer.TryWrite(text)) return;
            // Socket down: keep what Converger must store, drop what is live-only
            // (a stale run{started} would mislead a UI after the reconnect).
            if (!Mekik.Protocol.IsPersistent(frame)) return;
            _outbox.Add(text);
            if (_outbox.Count <= _opts.MaxBuffered) return;
            _outbox.RemoveAt(0);
        }
        Report(new InvalidOperationException("converger outbox full; dropped the oldest buffered frame"));
    }

    private void Send(Frame frame)
    {
        lock (_lock)
        {
            if (_welcomed) _outbound?.Writer.TryWrite(Json.Serialize(frame));
        }
    }

    // ── inbound ───────────────────────────────────────────────────────────────

    private void OnMessage(string text, Action welcomed)
    {
        Frame? msg;
        try { msg = Json.Parse(text) as Frame; }
        catch { return; }
        if (msg is null) return;
        if (msg.GetValueOrDefault("type") is string) { OnConnectionFrame(msg, welcomed); return; }
        // The envelope has no `type`: that is how it differs from a bare frame.
        if (msg.GetValueOrDefault("conversationId") is string conversationId && msg.GetValueOrDefault("frame") is Frame frame)
            OnConversationFrame(conversationId, frame);
    }

    private void OnConnectionFrame(Frame frame, Action welcomed)
    {
        var data = frame.GetValueOrDefault("data") as Frame ?? new Dictionary<string, object?>();
        switch (frame["type"] as string)
        {
            case "welcome":
            {
                lock (_lock)
                {
                    foreach (var queued in _outbox) _outbound?.Writer.TryWrite(queued);
                    _outbox.Clear();
                    _welcomed = true;
                }
                welcomed();
                var limits = data.GetValueOrDefault("limits") as Frame;
                var idle = limits?.GetValueOrDefault("idleTimeoutMs") is long ms ? ms : 60_000;
                // Converger closes a silent connection after idleTimeoutMs (4408).
                var period = TimeSpan.FromMilliseconds(Math.Max(1000, idle / 2));
                _pingTimer = new Timer(_ => Send(new Dictionary<string, object?> { ["type"] = "ping" }), null, period, period);
                ScheduleRefresh(data.GetValueOrDefault("expiresAt"));
                _ready.TrySetResult();
                return;
            }
            case "tokenRefreshed":
                ScheduleRefresh(data.GetValueOrDefault("expiresAt"));
                return;
            case "error":
                Report(new InvalidOperationException($"converger: {data.GetValueOrDefault("code")}: {data.GetValueOrDefault("message")}"));
                return;
        }
    }

    /// <summary>Renew the token a minute before it expires (only a token provider or a secret can).</summary>
    private void ScheduleRefresh(object? expiresAt)
    {
        _refreshTimer?.Dispose();
        _refreshTimer = null;
        if (expiresAt is not long at || (_opts.TokenProvider is null && _opts.Secret is null)) return;
        var delay = TimeSpan.FromMilliseconds(Math.Max(1000, at - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 60_000));
        _refreshTimer = new Timer(_ => _ = RefreshAsync(), null, delay, Timeout.InfiniteTimeSpan);
    }

    private async Task RefreshAsync()
    {
        try
        {
            var token = await TokenAsync(_closing.Token).ConfigureAwait(false);
            Send(new Dictionary<string, object?> { ["type"] = "auth", ["token"] = token });
        }
        catch (Exception ex) { Report(ex); }
    }

    private void OnConversationFrame(string conversationId, Frame frame)
    {
        if (frame.GetValueOrDefault("type") is not string type) return;
        long? seq = frame.GetValueOrDefault("seq") is long s ? s : null;

        if (type == "ack")
        {
            // Our own stored message: it will not come back, but it moves the resume point.
            if (seq is { } acked) Advance(conversationId, acked);
            return;
        }
        if (type == "error")
        {
            var data = frame.GetValueOrDefault("data") as Frame;
            Report(new InvalidOperationException($"converger ({conversationId}): {data?.GetValueOrDefault("code")}: {data?.GetValueOrDefault("message")}"));
            return;
        }
        if (seq is { } n)
        {
            // A replay overlapping what we already handled (a reconnect race).
            lock (_lock)
            {
                if (_watermarks.TryGetValue(conversationId, out var w) && n <= w.Seq) return;
            }
            Advance(conversationId, n);
        }

        if (Forwarded.Contains(type))
        {
            Deliver(conversationId, frame, userTurn: null);
            return;
        }
        if (frame.GetValueOrDefault("from") as string == "user" && !NotATurn.Contains(type) &&
            frame.GetValueOrDefault("data") is Frame d && d.GetValueOrDefault("text") is string text)
        {
            // A user turn of any message type, from any channel, is a mekik/1 text turn.
            var turn = new Dictionary<string, object?>
            {
                ["type"] = "text",
                ["data"] = new Dictionary<string, object?> { ["text"] = text },
            };
            if (TurnMeta(frame) is { } meta) turn["meta"] = meta;
            Deliver(conversationId, turn, frame);
        }
        // Everything else (the bot's and agents' frames, receipts, typing, presence) is not mekik's to answer.
    }

    private IReadOnlyDictionary<string, object?>? TurnMeta(Frame frame)
    {
        if (_opts.MetaFilter is null && _opts.Meta is null) return null;
        var merged = new Dictionary<string, object?>();
        if (frame.GetValueOrDefault("metadata") is Frame metadata) foreach (var kv in metadata) merged[kv.Key] = kv.Value;
        if (frame.GetValueOrDefault("meta") is Frame meta) foreach (var kv in meta) merged[kv.Key] = kv.Value;
        if (_opts.MetaFilter is { } filter) return filter(merged);
        var picked = _opts.Meta!.Where(merged.ContainsKey).ToDictionary(k => k, k => merged[k]);
        return picked.Count > 0 ? picked : null;
    }

    private void Advance(string conversationId, long seq)
    {
        lock (_lock)
        {
            var prev = _watermarks.TryGetValue(conversationId, out var w) ? w.Seq : 0;
            _watermarks[conversationId] = (Math.Max(prev, seq), ++_stamp);
            while (_watermarks.Count > _opts.MaxConversations)
            {
                var oldest = _watermarks.Where(kv => !_virtuals.ContainsKey(kv.Key)).OrderBy(kv => kv.Value.Stamp).Select(kv => kv.Key).FirstOrDefault();
                if (oldest is null) break;
                _watermarks.Remove(oldest);
            }
        }
    }

    // ── virtual connections ───────────────────────────────────────────────────

    private sealed class VirtualConnection(ConvergerTransport transport, string conversationId) : IConnection
    {
        public string Id { get; } = $"converger-{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}";

        public void Send(Frame frame)
        {
            // `welcome` answers the synthesised hello; Converger has its own handshake.
            if (frame.GetValueOrDefault("type") as string == "welcome") return;
            transport.Emit(conversationId, frame);
        }

        // Only an auth rejection closes a connection; drop this conversation.
        public void Close(int? code = null, string? reason = null) => transport.Evict(conversationId);
    }

    private sealed class Virtual
    {
        public required VirtualConnection Conn { get; init; }
        public required Channel<Frame> Inbox { get; init; }
        public Task Handshake { get; set; } = Task.CompletedTask;
        public int Inflight;
        public Timer? Idle;
    }

    /// <summary>Hand one inner frame to the conversation's virtual connection, connecting it first if needed.</summary>
    private void Deliver(string conversationId, Frame inner, Frame? userTurn)
    {
        Virtual v;
        lock (_lock)
        {
            if (!_virtuals.TryGetValue(conversationId, out v!)) v = ConnectVirtual(conversationId, userTurn);
            Interlocked.Increment(ref v.Inflight);
            v.Idle?.Dispose();
            v.Idle = null;
        }
        v.Inbox.Writer.TryWrite(inner);
    }

    /// <summary>Called under <see cref="_lock"/>.</summary>
    private Virtual ConnectVirtual(string conversationId, Frame? userTurn)
    {
        var sender = userTurn?.GetValueOrDefault("sender") as Frame;
        var userId = sender?.GetValueOrDefault("id") as string is { Length: > 0 } sid
            ? sid
            : _transcript.Owner(conversationId) ?? "anonymous";
        // The engine continues the hub's numbering: the turn that brought the conversation
        // in has seq N, so mekik's own (unsent) copy of it is N and its first reply N+1 —
        // exactly what Converger will assign if nothing else is written in between. Only a
        // hint; Converger renumbers on persistence. A conversation first seen through a
        // forwarded frame (a resume after a restart) already has history: at least 1, so it
        // is not greeted again.
        var seq = userTurn?.GetValueOrDefault("seq") is long turnSeq
            ? turnSeq - 1
            : Math.Max(1, _watermarks.TryGetValue(conversationId, out var w) ? w.Seq : 0);
        _transcript.Observe(conversationId, userId, seq);

        var auth = new Dictionary<string, object?> { ["userId"] = userId };
        if (sender?.GetValueOrDefault("role") is string role) auth["role"] = role;
        if (sender?.GetValueOrDefault("name") is string name) auth["name"] = name;
        var meta = new Dictionary<string, object?> { ["auth"] = auth };

        // Registered before connecting, so a refusal (Conn.Close) finds it to evict.
        var v = new Virtual
        {
            Conn = new VirtualConnection(this, conversationId),
            Inbox = Channel.CreateUnbounded<Frame>(new UnboundedChannelOptions { SingleReader = true }),
        };
        _virtuals[conversationId] = v;
        var connect = new ConnectParams
        {
            Hello = new HelloInfo { UserId = userId, ConversationId = conversationId, Watermark = seq, Meta = meta },
            Credential = new Credential { Meta = meta },
        };
        v.Handshake = Task.Run(() => _app.ConnectAsync(v.Conn, connect));
        _ = PumpAsync(conversationId, v);
        return v;
    }

    /// <summary>
    /// Frames of one conversation enter the engine in arrival order, after the handshake.
    /// They are not serialised behind each other's runs, so an <c>abort</c> reaches a
    /// running turn and a second turn draws <c>busy</c>.
    /// </summary>
    private async Task PumpAsync(string conversationId, Virtual v)
    {
        try { await v.Handshake.ConfigureAwait(false); }
        catch (Exception ex) { Report(ex); }
        await foreach (var frame in v.Inbox.Reader.ReadAllAsync().ConfigureAwait(false))
        {
            var task = Turns.Contains(frame.GetValueOrDefault("type") as string ?? "")
                ? MeteredAsync(v.Conn, frame)
                : _app.ReceiveAsync(v.Conn, frame);
            _ = task.ContinueWith(t =>
            {
                if (t.Exception is { } ex) Report(ex.GetBaseException());
                if (Interlocked.Decrement(ref v.Inflight) == 0) Arm(conversationId, v);
            }, TaskScheduler.Default);
        }
    }

    /// <summary>Run a turn under <see cref="ConvergerOptions.MaxConcurrentTurns"/>; the rest wait for a slot.</summary>
    private async Task MeteredAsync(IConnection conn, Frame frame)
    {
        if (_turnSlots is null)
        {
            await _app.ReceiveAsync(conn, frame).ConfigureAwait(false);
            return;
        }
        await _turnSlots.WaitAsync().ConfigureAwait(false);
        try { await _app.ReceiveAsync(conn, frame).ConfigureAwait(false); }
        finally { _turnSlots.Release(); }
    }

    private void Arm(string conversationId, Virtual v)
    {
        lock (_lock)
        {
            if (!_virtuals.TryGetValue(conversationId, out var current) || current != v || v.Inflight > 0) return;
            v.Idle?.Dispose();
            v.Idle = new Timer(_ =>
            {
                if (Volatile.Read(ref v.Inflight) == 0) Evict(conversationId, v);
            }, null, _opts.IdleTimeout, Timeout.InfiniteTimeSpan);
        }
    }

    /// <summary>Disconnect a conversation's virtual connection (idle, auth refusal, close).</summary>
    private void Evict(string conversationId, Virtual? only = null)
    {
        Virtual? v;
        lock (_lock)
        {
            if (!_virtuals.TryGetValue(conversationId, out v) || (only is not null && v != only)) return;
            _virtuals.Remove(conversationId);
            v.Idle?.Dispose();
            v.Idle = null;
            _transcript.Forget(conversationId);
        }
        v.Inbox.Writer.TryComplete();
        _ = v.Handshake.ContinueWith(_ => _app.Disconnect(v.Conn), TaskScheduler.Default);
    }

    // ── plumbing ──────────────────────────────────────────────────────────────

    private void StopTimers()
    {
        _pingTimer?.Dispose();
        _refreshTimer?.Dispose();
        _pingTimer = null;
        _refreshTimer = null;
    }

    private void Report(Exception ex)
    {
        try { _opts.OnError?.Invoke(ex); }
        catch { /* a throwing handler must not take the transport down */ }
    }

    /// <summary><c>wss://host/socket/...</c> → <c>https://host</c>.</summary>
    private static string HttpOrigin(string url)
    {
        var u = new Uri(url);
        var scheme = u.Scheme == "wss" ? "https" : "http";
        return $"{scheme}://{u.Authority}";
    }
}
