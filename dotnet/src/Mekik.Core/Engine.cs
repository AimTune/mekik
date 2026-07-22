using System.Security.Cryptography;
using Ilmek;

namespace Mekik;

using Frame = System.Collections.Generic.Dictionary<string, object?>;

/// <summary>One live client connection, as the engine sees it. `Id` is the mekik `connectionId`.</summary>
public interface IConnection
{
    string Id { get; }
    void Send(IReadOnlyDictionary<string, object?> frame);
    void Close(int? code = null, string? reason = null);
}

/// <summary>Identity a transport asserts at connect — travels here or in a first `hello`.</summary>
public sealed record HelloInfo
{
    public string? UserId { get; init; }
    public string? ConversationId { get; init; }
    public long? Watermark { get; init; }
    public string? Token { get; init; }
    public IReadOnlyDictionary<string, object?>? Meta { get; init; }
}

public sealed record ConnectParams
{
    public HelloInfo? Hello { get; init; }
    public Credential? Credential { get; init; }
}

/// <summary>Everything the engine needs, assembled by <see cref="MekikApp"/>.</summary>
public sealed record EngineConfig
{
    public required IlmekAdapter Adapter { get; init; }
    public required IHistoryStore History { get; init; }
    public required IConversationStore Conversations { get; init; }
    public IAuthenticator? Authenticator { get; init; }
    /// <summary>Map an inbound `text` frame to the graph's input update.</summary>
    public required Func<IReadOnlyDictionary<string, object?>, IReadOnlyDictionary<string, object?>> Input { get; init; }
    public Func<IReadOnlyDictionary<string, object?>, string?>? Reply { get; init; }
    public Func<(string ConversationId, string UserId), (string Text, IReadOnlyDictionary<string, object?>? Meta), IReadOnlyDictionary<string, object?>>? Context { get; init; }
    public Func<IReadOnlyDictionary<string, object?>, IReadOnlyDictionary<string, object?>?>? AcceptClientMeta { get; init; }
    /// <summary>A one-time bot greeting sent when a fresh conversation first connects (PROTOCOL.md §1).</summary>
    public Func<(string ConversationId, string UserId), string?>? Greeting { get; init; }
    public required IIdMinter Minter { get; init; }
    public required Func<long> Now { get; init; }
    /// <summary>Cross-node single-writer lease. Default: <see cref="LocalTurnLock"/> (single node).</summary>
    public required ITurnLock TurnLock { get; init; }
    /// <summary>Cross-node fan-out. Default: <see cref="NoopBackplane"/> (single node fans out directly).</summary>
    public required IBackplane Backplane { get; init; }
}

/// <summary>
/// The ConversationEngine (PROTOCOL.md §1, §5), mirror of the TypeScript engine.
/// Transport-agnostic: it talks to <see cref="IConnection"/> handles.
/// <see cref="MekikAspNetCore"/> supplies WebSocket connections; the conformance
/// suite supplies in-memory ones.
/// </summary>
public sealed class ConversationEngine
{
    private sealed class ConnState
    {
        public required IConnection Conn { get; init; }
        public required string UserId { get; init; }
        public IReadOnlyDictionary<string, object?>? Claims { get; init; }
    }

    private sealed class Live
    {
        public long Seq;
        public readonly Dictionary<string, ConnState> Connections = new();
        /// <summary>The in-flight run's cancellation source, or null when idle — the local turn lock.</summary>
        public CancellationTokenSource? Turn;
        /// <summary>This node's backplane subscription for the conversation (NoopBackplane: inert).</summary>
        public IAsyncDisposable? Sub;
        public readonly object Gate = new();
    }

    private readonly EngineConfig _cfg;
    private readonly Dictionary<string, Live> _live = new();
    private readonly Dictionary<string, string> _connIndex = new();
    private readonly object _registryLock = new();
    /// <summary>This node's identity — stamped on published frames so we skip our own on the backplane.</summary>
    private readonly string _nodeId = $"node-{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}";

    public ConversationEngine(EngineConfig cfg) => _cfg = cfg;

    // ── connect / disconnect ──────────────────────────────────────────────────

    public async Task ConnectAsync(IConnection conn, ConnectParams? paramsIn = null)
    {
        var hello = paramsIn?.Hello ?? new HelloInfo();

        string? verifiedUserId = null;
        IReadOnlyDictionary<string, object?>? claims = null;
        if (_cfg.Authenticator is not null)
        {
            var credential = paramsIn?.Credential ?? new Credential { Token = hello.Token };
            var verdict = await _cfg.Authenticator.AuthenticateAsync(credential).ConfigureAwait(false);
            if (!verdict.Ok)
            {
                conn.Send(ErrorFrame("unauthorized", verdict.Reason ?? "unauthorized"));
                conn.Close(Protocol.AuthCloseCode, "unauthorized");
                return;
            }
            verifiedUserId = verdict.UserId;
            claims = verdict.Claims;
        }

        // A verified id always wins over a client-asserted one (anti-spoof, §1).
        var userId = verifiedUserId ?? hello.UserId ?? Mint("user");

        var (conversationId, watermarkReset) = await ResolveConversationAsync(hello.ConversationId, userId).ConfigureAwait(false);

        var live = await EnsureLiveAsync(conversationId).ConfigureAwait(false);
        lock (live.Gate)
        {
            live.Connections[conn.Id] = new ConnState { Conn = conn, UserId = userId, Claims = claims };
        }
        lock (_registryLock) _connIndex[conn.Id] = conversationId;

        var pending = await _cfg.Adapter.PendingAsync(conversationId).ConfigureAwait(false);
        var pendingViews = pending
            .Select(p => new Frame { ["id"] = p.Id, ["data"] = TurnMapper.InterruptFrameData(p) })
            .Cast<object?>().ToList();

        conn.Send(new Frame
        {
            ["type"] = "welcome",
            ["data"] = new Frame
            {
                ["protocol"] = Protocol.Version,
                ["conversationId"] = conversationId,
                ["userId"] = userId,
                ["connectionId"] = conn.Id,
                ["watermark"] = Interlocked.Read(ref live.Seq),
                ["pending"] = pendingViews,
            },
        });

        var clientWatermark = watermarkReset ? 0 : hello.Watermark ?? 0;
        foreach (var frame in await _cfg.History.AfterAsync(conversationId, clientWatermark).ConfigureAwait(false))
            conn.Send(frame);

        // A fresh conversation gets a one-time bot greeting, persisted like any
        // bot text so a later reconnect replays it instead of greeting twice.
        if (_cfg.Greeting is not null && Interlocked.Read(ref live.Seq) == 0)
        {
            var text = _cfg.Greeting((conversationId, userId));
            if (!string.IsNullOrEmpty(text))
            {
                await DispatchAsync(conversationId, new Frame
                {
                    ["type"] = "text",
                    ["id"] = _cfg.Minter.Message(),
                    ["seq"] = Interlocked.Increment(ref live.Seq),
                    ["from"] = "bot",
                    ["data"] = new Frame { ["text"] = text },
                    ["timestamp"] = _cfg.Now(),
                }).ConfigureAwait(false);
            }
        }
    }

    public void Disconnect(IConnection conn)
    {
        string? convId;
        lock (_registryLock)
        {
            _connIndex.Remove(conn.Id, out convId);
        }
        if (convId is null) return;
        if (_live.TryGetValue(convId, out var live))
            lock (live.Gate) live.Connections.Remove(conn.Id);
    }

    // ── inbound frames ────────────────────────────────────────────────────────

    public async Task ReceiveAsync(IConnection conn, object? raw)
    {
        IReadOnlyDictionary<string, object?> frame;
        try { frame = Protocol.ParseIncoming(raw); }
        catch (ProtocolException ex)
        {
            conn.Send(ErrorFrame(ex.Code, ex.Message));
            return;
        }

        string? convId;
        lock (_registryLock) convId = _connIndex.GetValueOrDefault(conn.Id);
        if (convId is null)
        {
            conn.Send(ErrorFrame("no_session", "connect before sending frames"));
            return;
        }

        switch (frame["type"] as string)
        {
            case "hello": return; // re-hello ignored in v1
            case "text": await HandleTextAsync(conn, convId, frame).ConfigureAwait(false); break;
            case "resume": await HandleResumeAsync(conn, convId, frame).ConfigureAwait(false); break;
            case "abort": HandleAbort(convId); break;
            case "genui_event": await HandleGenUIEventAsync(conn, convId, frame).ConfigureAwait(false); break;
        }
    }

    // ── turns ─────────────────────────────────────────────────────────────────

    private async Task HandleTextAsync(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame)
    {
        var live = _live[convId];
        var cts = new CancellationTokenSource();
        lock (live.Gate)
        {
            if (live.Turn is not null) { conn.Send(ErrorFrame("busy", "a run is already in flight")); return; }
            live.Turn = cts;
        }
        ITurnLease? lease = null;
        try
        {
            // The cross-node lease: null means another node owns the turn
            // (single-node LocalTurnLock always grants). See docs/SCALING.md.
            lease = await _cfg.TurnLock.AcquireAsync(convId).ConfigureAwait(false);
            if (lease is null) { conn.Send(ErrorFrame("busy", "a run is already in flight")); return; }

            var pending = await _cfg.Adapter.PendingAsync(convId).ConfigureAwait(false);
            if (pending.Count > 0)
            {
                conn.Send(ErrorFrame("interrupted", "answer the open interrupt(s) first"));
                return;
            }

            ConnState state;
            lock (live.Gate) state = live.Connections[conn.Id];
            var text = ((IReadOnlyDictionary<string, object?>)frame["data"]!)["text"] as string ?? "";

            // The user's own turn: stored + shown to the other tabs, not echoed back (§1).
            await DispatchAsync(convId, new Frame
            {
                ["type"] = "text",
                ["id"] = _cfg.Minter.Message(),
                ["seq"] = Interlocked.Increment(ref live.Seq),
                ["from"] = "user",
                ["data"] = new Frame { ["text"] = text },
                ["timestamp"] = _cfg.Now(),
            }, conn.Id).ConfigureAwait(false);

            var meta = BuildMeta(convId, state.UserId, text, frame.GetValueOrDefault("meta") as IReadOnlyDictionary<string, object?>, state.Claims);
            var input = _cfg.Input(frame);
            await DriveAsync(convId, live, _cfg.Adapter.Run(input, new RunContext { ThreadId = convId, Meta = meta, CancellationToken = cts.Token })).ConfigureAwait(false);
        }
        finally
        {
            if (lease is not null) await lease.DisposeAsync().ConfigureAwait(false);
            lock (live.Gate) live.Turn = null;
            cts.Dispose();
        }
    }

    private async Task HandleResumeAsync(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame)
    {
        var live = _live[convId];
        var cts = new CancellationTokenSource();
        lock (live.Gate)
        {
            if (live.Turn is not null) { conn.Send(ErrorFrame("busy", "a run is already in flight")); return; }
            live.Turn = cts;
        }
        ITurnLease? lease = null;
        try
        {
            lease = await _cfg.TurnLock.AcquireAsync(convId).ConfigureAwait(false);
            if (lease is null) { conn.Send(ErrorFrame("busy", "a run is already in flight")); return; }

            var pending = await _cfg.Adapter.PendingAsync(convId).ConfigureAwait(false);
            if (pending.Count == 0)
            {
                conn.Send(ErrorFrame("not_interrupted", "no open interrupt to resume"));
                return;
            }
            var answers = (IReadOnlyDictionary<string, object?>)frame["answers"]!;
            var missing = pending.Where(p => !answers.ContainsKey(p.Id)).ToList();
            if (missing.Count > 0)
            {
                conn.Send(ErrorFrame("incomplete_resume", $"answer all open interrupts: {string.Join(", ", missing.Select(m => m.Id))}"));
                return;
            }

            ConnState state;
            lock (live.Gate) state = live.Connections[conn.Id];

            // Tell every tab (and the transcript) each pause is closed, before the continuation streams (§4.4).
            foreach (var p in pending)
            {
                await DispatchAsync(convId, new Frame
                {
                    ["type"] = "interrupt_resolved",
                    ["seq"] = Interlocked.Increment(ref live.Seq),
                    ["id"] = p.Id,
                    ["data"] = new Frame { ["answer"] = answers.GetValueOrDefault(p.Id) },
                }).ConfigureAwait(false);
            }

            var meta = BuildMeta(convId, state.UserId, "", null, state.Claims);
            await DriveAsync(convId, live, _cfg.Adapter.Resume(answers, new RunContext { ThreadId = convId, Meta = meta, CancellationToken = cts.Token })).ConfigureAwait(false);
        }
        finally
        {
            if (lease is not null) await lease.DisposeAsync().ConfigureAwait(false);
            lock (live.Gate) live.Turn = null;
            cts.Dispose();
        }
    }

    private void HandleAbort(string convId)
    {
        if (_live.TryGetValue(convId, out var live))
        {
            CancellationTokenSource? turn;
            lock (live.Gate) turn = live.Turn;
            turn?.Cancel();
        }
    }

    private async Task HandleGenUIEventAsync(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame)
    {
        // v1: a component `submit` naming an open interrupt is coerced to a resume (PROTOCOL.md §4.4).
        if (frame.GetValueOrDefault("eventType") is not "submit") return;
        if (frame.GetValueOrDefault("payload") is not IReadOnlyDictionary<string, object?> payload) return;
        if (payload.GetValueOrDefault("id") is not string id) return;
        var pending = await _cfg.Adapter.PendingAsync(convId).ConfigureAwait(false);
        if (pending.All(p => p.Id != id)) return;
        await HandleResumeAsync(conn, convId, new Frame
        {
            ["type"] = "resume",
            ["answers"] = new Frame { [id] = payload.GetValueOrDefault("answer") },
        }).ConfigureAwait(false);
    }

    /// <summary>Stream one run's events through a fresh TurnMapper, fanning frames out.</summary>
    private async Task DriveAsync(string convId, Live live, IAsyncEnumerable<IlmekEvent> events)
    {
        var mapper = new TurnMapper(new TurnMapperDeps
        {
            AllocSeq = () => Interlocked.Increment(ref live.Seq),
            Mint = _cfg.Minter,
            Now = _cfg.Now,
            Reply = _cfg.Reply,
        });
        await foreach (var ev in events.ConfigureAwait(false))
            foreach (var outFrame in mapper.Map(ev))
                await DispatchAsync(convId, outFrame).ConfigureAwait(false);
    }

    // ── plumbing ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Persist a persistent frame, fan it out to this node's connections, then hand
    /// it to the backplane for the other nodes. The producing node records once;
    /// backplane subscribers only re-fan (see <see cref="EnsureLiveAsync"/>).
    /// </summary>
    private async Task DispatchAsync(string convId, IReadOnlyDictionary<string, object?> frame, string? exceptConnId = null)
    {
        if (Protocol.IsPersistent(frame)) await _cfg.History.RecordAsync(convId, frame).ConfigureAwait(false);
        FanOutLocal(convId, frame, exceptConnId);
        await _cfg.Backplane.PublishAsync(convId, new BackplaneMessage(_nodeId, frame)).ConfigureAwait(false);
    }

    /// <summary>Send a frame to this node's own connections for the conversation (no record, no publish).</summary>
    private void FanOutLocal(string convId, IReadOnlyDictionary<string, object?> frame, string? exceptConnId = null)
    {
        if (!_live.TryGetValue(convId, out var live)) return;
        List<ConnState> targets;
        lock (live.Gate) targets = live.Connections.Values.ToList();
        foreach (var state in targets)
        {
            if (exceptConnId is not null && state.Conn.Id == exceptConnId) continue;
            state.Conn.Send(frame);
        }
    }

    private IReadOnlyDictionary<string, object?> BuildMeta(string convId, string userId, string text, IReadOnlyDictionary<string, object?>? clientMeta, IReadOnlyDictionary<string, object?>? claims)
    {
        var meta = new Frame();
        if (_cfg.Context is not null) meta["mekik"] = _cfg.Context((convId, userId), (text, clientMeta));
        if (claims is not null) meta["auth"] = claims;
        if (_cfg.AcceptClientMeta is not null && clientMeta is not null)
        {
            var client = _cfg.AcceptClientMeta(clientMeta);
            if (client is not null) meta["client"] = client;
        }
        return meta;
    }

    private async Task<(string ConversationId, bool WatermarkReset)> ResolveConversationAsync(string? requested, string userId)
    {
        if (requested is not null)
        {
            var rec = await _cfg.Conversations.GetAsync(requested).ConfigureAwait(false);
            // Adopt only if it exists AND belongs to this user.
            if (rec is not null && rec.UserId == userId) return (requested, false);
            var minted = Mint("conv");
            await _cfg.Conversations.CreateAsync(new ConversationRecord(minted, userId, _cfg.Now(), new Frame())).ConfigureAwait(false);
            return (minted, true);
        }
        var conversationId = Mint("conv");
        await _cfg.Conversations.CreateAsync(new ConversationRecord(conversationId, userId, _cfg.Now(), new Frame())).ConfigureAwait(false);
        return (conversationId, false);
    }

    private async Task<Live> EnsureLiveAsync(string convId)
    {
        Live? live;
        lock (_registryLock) _live.TryGetValue(convId, out live);
        if (live is not null) return live;
        var seq = await _cfg.History.CurrentSeqAsync(convId).ConfigureAwait(false);
        var created = false;
        lock (_registryLock)
        {
            if (!_live.TryGetValue(convId, out live))
            {
                live = new Live { Seq = seq };
                _live[convId] = live;
                created = true;
            }
        }
        if (created)
        {
            // Subscribe once per conversation this node holds. Frames another node
            // produced arrive here and fan out to our local sockets; we skip our own
            // (OriginId) to avoid the pub/sub self-delivery echo. NoopBackplane never
            // delivers, so single-node behaviour is unchanged.
            live.Sub = await _cfg.Backplane.SubscribeAsync(convId, msg =>
            {
                if (msg.OriginId == _nodeId) return;
                FanOutLocal(convId, msg.Frame);
            }).ConfigureAwait(false);
        }
        return live;
    }

    private static Frame ErrorFrame(string code, string message) => new()
    {
        ["type"] = "error",
        ["data"] = new Frame { ["code"] = code, ["message"] = message },
    };

    private static string Mint(string prefix) =>
        $"{prefix}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}";
}

/// <summary>The default production id minter: random. Fixtures inject a deterministic one.</summary>
public sealed class RandomMinter : IIdMinter
{
    private static string Rand() => Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();
    public string Message() => $"msg-{Rand()}";
    public string Stream() => $"stream-{Rand()}";
}
