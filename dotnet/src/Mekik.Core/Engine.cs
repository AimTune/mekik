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
    /// <summary>Hash of the component catalog this client has cached (PROTOCOL.md §10.2).</summary>
    public string? ComponentsHash { get; init; }
    /// <summary>
    /// Tools this client can execute (PROTOCOL.md §11.1), as raw parsed JSON —
    /// the engine sanitizes with <see cref="ClientTools.Sanitize"/>. Inert unless
    /// <see cref="EngineConfig.ClientTools"/> opts in.
    /// </summary>
    public IReadOnlyList<object?>? Tools { get; init; }
    /// <summary>Hash of the server skill catalog this client has cached (PROTOCOL.md §12.2).</summary>
    public string? SkillsHash { get; init; }
    /// <summary>
    /// Skills this client declares (PROTOCOL.md §12.4), as raw parsed JSON — the
    /// engine sanitizes with <see cref="ClientSkills.Sanitize"/>. Inert unless
    /// <see cref="EngineConfig.ClientSkills"/> opts in.
    /// </summary>
    public IReadOnlyList<object?>? Skills { get; init; }
}

public sealed record ConnectParams
{
    public HelloInfo? Hello { get; init; }
    public Credential? Credential { get; init; }
}

/// <summary>
/// One graph-addressed interaction from a mounted GenUI component — what a
/// <c>mekik-event</c> element hands the server (PROTOCOL.md §10.4).
/// </summary>
/// <remarks>
/// Two kinds of interaction never reach here, because both are already spoken for:
/// a <c>submit</c> whose payload names an open interrupt (coerced to a resume, §4.4),
/// and a <c>component-event</c> claimed by a node parked on
/// <see cref="Shuttle.OnEvent{T}"/>. What is left is the graph-wide traffic: a click
/// on a widget whose turn is long over.
/// </remarks>
public sealed record GenUiEvent
{
    public required string ConversationId { get; init; }
    public required string UserId { get; init; }
    /// <summary>The turn stream the component was mounted in.</summary>
    public required string StreamId { get; init; }
    /// <summary>The element's event name — its <c>mekik-event</c> or <c>data-event</c> value.</summary>
    public required string EventType { get; init; }
    /// <summary>The registry name of the component it came from, when the client knows it.</summary>
    public string? Component { get; init; }
    /// <summary>The element's <c>data-payload</c>, parsed — a dictionary for JSON,
    /// the raw string for anything that did not parse, null when it carried none.</summary>
    public object? Payload { get; init; }
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
    /// <summary>Accept client-declared tools → <c>ctx.Meta["clientTools"]</c> (PROTOCOL.md §11). Default: ignore them.</summary>
    public ClientToolsPolicy? ClientTools { get; init; }
    /// <summary>The server's skill catalog (PROTOCOL.md §12), announced on connect and offered to nodes at <c>ctx.Meta["skills"]</c>.</summary>
    public ISkillSource? Skills { get; init; }
    /// <summary>Accept client-declared skills into <c>ctx.Meta["skills"]</c> (PROTOCOL.md §12.4). Default: ignore them.</summary>
    public ClientSkillsPolicy? ClientSkills { get; init; }
    /// <summary>
    /// A one-time bot greeting sent when a fresh conversation first connects (PROTOCOL.md §1).
    /// Returns a <see cref="string"/> (one <c>text</c> frame), a described rich message
    /// (<see cref="Messages.Spec"/>), or a list mixing both — see <see cref="MekikOptions.Greeting"/>.
    /// </summary>
    public Func<(string ConversationId, string UserId), object?>? Greeting { get; init; }
    /// <summary>Components the server defines itself, announced on connect (PROTOCOL.md §5).</summary>
    public ComponentCatalog? Components { get; init; }
    /// <summary>Turn a component interaction into a graph input update, or null to ignore it (PROTOCOL.md §10.4).</summary>
    public Func<GenUiEvent, IReadOnlyDictionary<string, object?>?>? OnGenUiEvent { get; init; }
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
/// <c>Mekik.AspNetCore</c>'s <c>MapMekik</c> supplies WebSocket connections; the conformance
/// suite supplies in-memory ones.
/// </summary>
public sealed class ConversationEngine
{
    private sealed class ConnState
    {
        public required IConnection Conn { get; init; }
        public required string UserId { get; init; }
        public IReadOnlyDictionary<string, object?>? Claims { get; init; }
        /// <summary>This connection's <c>hello.meta</c> (§6) — laid under each turn's frame meta before the allowlist sees it.</summary>
        public IReadOnlyDictionary<string, object?>? HelloMeta { get; init; }
        /// <summary>
        /// Live frames that arrived while this connection's replay tail was still being
        /// read (§2). Flushed — minus anything the tail already carried — once the tail
        /// is sent, so a tab joining mid-stream never sees a seq twice or out of order.
        /// Null once the handshake is done. Guarded by <see cref="Live.Gate"/>.
        /// </summary>
        public List<IReadOnlyDictionary<string, object?>>? Backlog { get; set; } = new();
        /// <summary>The highest seq the replay tail carried; a later live copy of one of those is not re-sent.</summary>
        public long ReplayedThrough { get; set; }
        /// <summary>
        /// The tools this connection declared (§11.1), already sanitized and passed
        /// through the <see cref="ClientToolsPolicy"/>. <c>Stamp</c> orders
        /// declarations across a conversation's connections: when two tabs declare
        /// the same tool name, the most recent declaration wins in the snapshot.
        /// </summary>
        public (IReadOnlyList<ClientToolDefinition> Defs, long Stamp)? Tools { get; set; }
        /// <summary>The skills this connection declared (§12.4), sanitized and policy-filtered; <c>Stamp</c> as for tools.</summary>
        public (IReadOnlyList<ClientSkillDefinition> Defs, long Stamp)? Skills { get; set; }
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
    /// <summary>Orders client tool declarations across connections (see ConnState.Tools).</summary>
    private long _declStamp;

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
        var state = new ConnState { Conn = conn, UserId = userId, Claims = claims, HelloMeta = hello.Meta };
        lock (live.Gate)
        {
            live.Connections[conn.Id] = state;
        }
        lock (_registryLock) _connIndex[conn.Id] = conversationId;

        // Client tool declarations (§11.1). Inert unless the app opted in — the
        // same default-drop posture as client meta, because a declaration is
        // client-controlled input a model will read.
        if (hello.Tools is not null) ApplyClientTools(state, hello.Tools, conversationId, userId);
        if (hello.Skills is not null) ApplyClientSkills(state, hello.Skills, conversationId, userId);

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

        // The component catalog (§10.2). Sent straight after `welcome` so a widget
        // named by the very first turn is already registered. An unchanged catalog
        // costs one tiny frame — the markup itself travels only when the hash moved.
        var catalog = _cfg.Components;
        if (catalog is not null && !catalog.IsEmpty)
        {
            var frame = new Frame { ["type"] = "genui_components", ["hash"] = catalog.Hash };
            if (hello.ComponentsHash == catalog.Hash) frame["unchanged"] = true;
            else frame["components"] = catalog.Definitions.Cast<object?>().ToList();
            conn.Send(frame);
        }

        // The skill catalog (§12.2): the server's level-1 summaries, hash-versioned
        // exactly like the component catalog, so a UI can show what the agent can
        // do and a returning client pays one tiny frame.
        var skills = _cfg.Skills?.List() ?? [];
        if (skills.Count > 0)
        {
            var hash = Mekik.Skills.Hash(skills);
            var frame = new Frame { ["type"] = "skills", ["hash"] = hash };
            if (hello.SkillsHash == hash) frame["unchanged"] = true;
            else frame["skills"] = skills.Select(s => (object?)(s with { Source = SkillOrigin.Server }).ToWire()).ToList();
            conn.Send(frame);
        }

        var clientWatermark = watermarkReset ? 0 : hello.Watermark ?? 0;
        var tail = await _cfg.History.AfterAsync(conversationId, clientWatermark).ConfigureAwait(false);
        foreach (var frame in tail) conn.Send(frame);

        // Frames dispatched while the handshake was in flight were held back (see
        // FanOutLocal). The tail was read after some of them were recorded, so it may
        // already carry them: drop any persistent frame at or below the last replayed
        // seq and send the rest, in order. Under the gate, so a concurrent fan-out
        // cannot overtake the backlog.
        var lastReplayed = tail.Count > 0 ? SeqOf(tail[^1]) ?? 0 : 0;
        var replayedTo = tail.Count > 0 ? lastReplayed : clientWatermark;
        lock (live.Gate)
        {
            foreach (var frame in state.Backlog ?? [])
            {
                if (Protocol.IsPersistent(frame) && SeqOf(frame) is { } s && s <= replayedTo) continue;
                conn.Send(frame);
            }
            state.Backlog = null;
            state.ReplayedThrough = lastReplayed;
        }

        // A fresh conversation gets a one-time bot greeting, persisted like any
        // bot frame so a later reconnect replays it instead of greeting twice.
        if (_cfg.Greeting is not null && Interlocked.Read(ref live.Seq) == 0)
        {
            foreach (var spec in GreetingFrames(_cfg.Greeting((conversationId, userId))))
            {
                await DispatchAsync(conversationId, new Frame
                {
                    ["type"] = spec.GetValueOrDefault("type"),
                    ["id"] = spec.GetValueOrDefault("id") as string ?? _cfg.Minter.Message(),
                    ["seq"] = Interlocked.Increment(ref live.Seq),
                    ["from"] = "bot",
                    ["data"] = spec.GetValueOrDefault("data"),
                    ["timestamp"] = _cfg.Now(),
                }).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Normalize a greeting into the message specs to send. A bare string becomes a
    /// <c>text</c> spec; empty strings are skipped (an app that computes "no greeting"
    /// as <c>""</c> means it). A reserved frame type can't get here through
    /// <see cref="Messages.Spec"/>, which throws — but a hand-built spec naming one is
    /// dropped rather than allowed to collide with the protocol's own frames.
    /// Mirror of the TypeScript <c>greetingFrames</c>.
    /// </summary>
    private static List<IReadOnlyDictionary<string, object?>> GreetingFrames(object? greeting)
    {
        var items = greeting switch
        {
            null => [],
            string or IReadOnlyDictionary<string, object?> => new List<object?> { greeting },
            System.Collections.IEnumerable seq => seq.Cast<object?>().ToList(),
            _ => new List<object?> { greeting },
        };

        var specs = new List<IReadOnlyDictionary<string, object?>>();
        foreach (var item in items)
        {
            if (item is string text)
            {
                if (!string.IsNullOrEmpty(text))
                {
                    specs.Add(new Dictionary<string, object?>
                    {
                        ["type"] = "text",
                        ["data"] = new Dictionary<string, object?> { ["text"] = text },
                    });
                }
                continue;
            }
            if (item is not IReadOnlyDictionary<string, object?> spec) continue;
            if (spec.GetValueOrDefault("type") is not string type) continue;
            if (Protocol.ReservedFrameTypes.Contains(type) && type != "text") continue;
            specs.Add(spec);
        }
        return specs;
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
            case "client_tools": HandleClientTools(conn, convId, frame); break;
            case "client_skills": HandleClientSkills(conn, convId, frame); break;
        }
    }

    /// <summary>
    /// Replace this connection's declared client skills (§12.4) — the whole new set,
    /// <c>[]</c> withdrawing everything. Takes effect on the next turn, like client tools.
    /// </summary>
    private void HandleClientSkills(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame)
    {
        if (!_live.TryGetValue(convId, out var live)) return;
        ConnState? state;
        lock (live.Gate) live.Connections.TryGetValue(conn.Id, out state);
        if (state is null) return;
        ApplyClientSkills(state, frame.GetValueOrDefault("skills"), convId, state.UserId);
    }

    /// <summary>Sanitize a skill declaration, pass it through the policy, and store it on the connection.</summary>
    private void ApplyClientSkills(ConnState state, object? raw, string convId, string userId)
    {
        var policy = _cfg.ClientSkills;
        if (policy is null) return; // opted out: declarations are inert
        var defs = Mekik.ClientSkills.Sanitize(raw);
        defs = policy(defs, (convId, userId)) ?? [];
        state.Skills = (defs, Interlocked.Increment(ref _declStamp));
    }

    /// <summary>The conversation's client skills as one turn sees them (§12.4): the union across live connections, last declaration of a name wins.</summary>
    private IReadOnlyList<ClientSkillDefinition> ClientSkillsFor(string convId)
    {
        if (!_live.TryGetValue(convId, out var live)) return [];
        List<(IReadOnlyList<ClientSkillDefinition> Defs, long Stamp)> declared;
        lock (live.Gate)
        {
            declared = live.Connections.Values
                .Where(s => s.Skills is not null)
                .Select(s => s.Skills!.Value)
                .OrderBy(t => t.Stamp)
                .ToList();
        }
        var order = new List<string>();
        var byName = new Dictionary<string, ClientSkillDefinition>();
        foreach (var (defs, _) in declared)
        {
            foreach (var def in defs)
            {
                if (!byName.ContainsKey(def.Name)) order.Add(def.Name);
                byName[def.Name] = def;
            }
        }
        return order.Select(n => byName[n]).ToList();
    }

    /// <summary>
    /// Replace this connection's declared client tools (§11.1). The frame carries
    /// the connection's whole new set; <c>[]</c> withdraws every tool. Takes effect
    /// on the next turn — an in-flight run keeps the snapshot it started with.
    /// </summary>
    private void HandleClientTools(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame)
    {
        if (!_live.TryGetValue(convId, out var live)) return;
        ConnState? state;
        lock (live.Gate) live.Connections.TryGetValue(conn.Id, out state);
        if (state is null) return;
        ApplyClientTools(state, frame.GetValueOrDefault("tools"), convId, state.UserId);
    }

    /// <summary>Sanitize a declaration, pass it through the policy, and store it on the connection.</summary>
    private void ApplyClientTools(ConnState state, object? raw, string convId, string userId)
    {
        var policy = _cfg.ClientTools;
        if (policy is null) return; // opted out: declarations are inert
        var defs = Mekik.ClientTools.Sanitize(raw);
        defs = policy(defs, (convId, userId)) ?? [];
        state.Tools = (defs, Interlocked.Increment(ref _declStamp));
    }

    /// <summary>
    /// The conversation's client tools as one turn sees them (§11.2): the union of
    /// every live connection's declaration, deduped by name — the most recent
    /// declaration of a name wins, keeping the position of its first appearance.
    /// Null when nothing is declared (or the app never opted in), so <c>ctx.Meta</c>
    /// stays clean for the common case.
    /// </summary>
    private IReadOnlyList<ClientToolDefinition>? ClientToolsFor(string convId)
    {
        if (!_live.TryGetValue(convId, out var live)) return null;
        List<(IReadOnlyList<ClientToolDefinition> Defs, long Stamp)> declared;
        lock (live.Gate)
        {
            declared = live.Connections.Values
                .Where(s => s.Tools is not null)
                .Select(s => s.Tools!.Value)
                .OrderBy(t => t.Stamp)
                .ToList();
        }
        if (declared.Count == 0) return null;
        var order = new List<string>();
        var byName = new Dictionary<string, ClientToolDefinition>();
        foreach (var (defs, _) in declared)
        {
            foreach (var def in defs)
            {
                if (!byName.ContainsKey(def.Name)) order.Add(def.Name);
                byName[def.Name] = def;
            }
        }
        return order.Count > 0 ? order.Select(n => byName[n]).ToList() : null;
    }

    // ── turns ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// The guarded turn. Takes the local lock, then the cross-node lease, refuses a
    /// second run with <c>busy</c>, and always releases both — every path that drives
    /// the graph goes through here, so none of them can drift on the locking rules
    /// (PROTOCOL.md §5). The body gets the live state, the sending connection's state
    /// and the turn's cancellation token.
    /// </summary>
    private async Task WithTurnAsync(IConnection conn, string convId, Func<Live, ConnState, CancellationToken, Task> body)
    {
        var live = _live[convId];
        var cts = new CancellationTokenSource();
        ConnState? state;
        lock (live.Gate)
        {
            // Read the sender's state now: a tab may send and close at once, and the
            // turn it asked for still belongs to the conversation.
            if (!live.Connections.TryGetValue(conn.Id, out state)) { cts.Dispose(); return; }
            if (live.Turn is not null) { conn.Send(ErrorFrame("busy", "a run is already in flight")); cts.Dispose(); return; }
            live.Turn = cts;
        }
        ITurnLease? lease = null;
        try
        {
            // The cross-node lease: null means another node owns the turn
            // (single-node LocalTurnLock always grants). See docs/SCALING.md.
            lease = await _cfg.TurnLock.AcquireAsync(convId).ConfigureAwait(false);
            if (lease is null) { conn.Send(ErrorFrame("busy", "a run is already in flight")); return; }

            await body(live, state, cts.Token).ConfigureAwait(false);
        }
        finally
        {
            // Free the local lock even when the lease release fails (a Redis blip): the
            // remote lease has a TTL, but a stuck live.Turn would answer busy forever.
            try
            {
                if (lease is not null) await lease.DisposeAsync().ConfigureAwait(false);
            }
            finally
            {
                lock (live.Gate) live.Turn = null;
                cts.Dispose();
            }
        }
    }

    private Task HandleTextAsync(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame) =>
        WithTurnAsync(conn, convId, async (live, state, ct) =>
        {
            var pending = await _cfg.Adapter.PendingAsync(convId).ConfigureAwait(false);
            if (pending.Count > 0)
            {
                conn.Send(ErrorFrame("interrupted", "answer the open interrupt(s) first"));
                return;
            }

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

            var meta = BuildMeta(convId, state, text, frame.GetValueOrDefault("meta") as IReadOnlyDictionary<string, object?>);
            var input = _cfg.Input(frame);
            await DriveAsync(convId, live, _cfg.Adapter.Run(input, new RunContext { ThreadId = convId, Meta = meta, CancellationToken = ct })).ConfigureAwait(false);
        });

    private Task HandleResumeAsync(IConnection conn, string convId, IReadOnlyDictionary<string, object?> frame) =>
        WithTurnAsync(conn, convId, async (live, state, ct) =>
        {
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

            var meta = BuildMeta(convId, state, "", null);
            await DriveAsync(convId, live, _cfg.Adapter.Resume(answers, new RunContext { ThreadId = convId, Meta = meta, CancellationToken = ct })).ConfigureAwait(false);
        });

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
        var eventType = frame.GetValueOrDefault("eventType") as string ?? "";
        var payload = frame.GetValueOrDefault("payload");

        // Where the interaction is addressed, straight from the markup that fired it
        // (PROTOCOL.md §10.4): `component-event` → the component's own pause,
        // `mekik-event` → the graph, a plain `data-event` → whichever answers first.
        var scope = frame.GetValueOrDefault("scope") as string;
        var toComponent = scope != "graph";
        var toGraph = scope != "component";

        var open = await _cfg.Adapter.PendingAsync(convId).ConfigureAwait(false);

        // 1. A `submit` naming an open interrupt is coerced to a resume (§4.4) — a form
        //    bound to a pause answers that pause. The id in the payload is a direct
        //    address, so it outranks the scope rather than being filtered by it.
        if (eventType == "submit" &&
            payload is IReadOnlyDictionary<string, object?> answer &&
            answer.GetValueOrDefault("id") is string id &&
            open.Any(p => p.Id == id))
        {
            await HandleResumeAsync(conn, convId, new Frame
            {
                ["type"] = "resume",
                ["answers"] = new Frame { [id] = answer.GetValueOrDefault("answer") },
            }).ConfigureAwait(false);
            return;
        }

        // 2. A node parked on `Shuttle.OnEvent` is waiting for exactly this interaction.
        //    The pause it holds is the binding, so no id has to travel in the payload.
        if (toComponent && open.FirstOrDefault(p => TurnMapper.AwaitedEvent(p) == eventType) is { } waiting)
        {
            await HandleResumeAsync(conn, convId, new Frame
            {
                ["type"] = "resume",
                ["answers"] = new Frame { [waiting.Id] = payload },
            }).ConfigureAwait(false);
            return;
        }

        // 3. Otherwise it is the app's call. A `component-event` stops here: it was
        //    addressed to a component's own pause, and no node is holding one — the
        //    widget outlived the turn that mounted it. Without a handler the click is
        //    inert either way; a decorative button should cost nothing.
        if (!toGraph || _cfg.OnGenUiEvent is null) return;

        // Ask before taking the turn, not after: an ignored event must not answer a
        // click with `busy` just because a run happens to be in flight.
        string userId;
        {
            if (!_live.TryGetValue(convId, out var live)) return;
            lock (live.Gate)
            {
                if (!live.Connections.TryGetValue(conn.Id, out var state)) return;
                userId = state.UserId;
            }
        }

        var input = _cfg.OnGenUiEvent(new GenUiEvent
        {
            ConversationId = convId,
            UserId = userId,
            StreamId = frame.GetValueOrDefault("streamId") as string ?? "",
            EventType = eventType,
            Component = frame.GetValueOrDefault("component") as string,
            Payload = payload,
        });
        if (input is null) return;

        await WithTurnAsync(conn, convId, async (live, state, ct) =>
        {
            // A parked run is answered, not overtaken — the same rule a `text` turn
            // obeys (§4.4). The click is refused, the pause stands.
            var pending = await _cfg.Adapter.PendingAsync(convId).ConfigureAwait(false);
            if (pending.Count > 0)
            {
                conn.Send(ErrorFrame("interrupted", "answer the open interrupt(s) first"));
                return;
            }

            // No `text` frame is dispatched: a click is not something the user said,
            // and the transcript already carries the widget it came from.
            var meta = BuildMeta(convId, state, "", null);
            await DriveAsync(convId, live, _cfg.Adapter.Run(input, new RunContext { ThreadId = convId, Meta = meta, CancellationToken = ct })).ConfigureAwait(false);
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
        var started = false;
        var ended = false;
        try
        {
            await foreach (var ev in events.ConfigureAwait(false))
            {
                if (ev is RunStartEvent) started = true;
                if (ev is RunEndEvent) ended = true;
                foreach (var outFrame in mapper.Map(ev))
                    await DispatchAsync(convId, outFrame).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (started && !ended && ex is not OperationCanceledException)
        {
            // A stream that throws mid-run (ilmek's recursion limit, a failing
            // checkpointer) never yields its run_end. Every tab already saw
            // run{started}, so close the run on the wire as an error rather than
            // leave them spinning (§4.1, §13.2). A stream that fails before it
            // started has put nothing on the wire — the caller sees that one.
            foreach (var outFrame in mapper.Fail(ex))
                await DispatchAsync(convId, outFrame).ConfigureAwait(false);
        }
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
        var targets = new List<ConnState>();
        var seq = Protocol.IsPersistent(frame) ? SeqOf(frame) : null;
        lock (live.Gate)
        {
            foreach (var state in live.Connections.Values)
            {
                if (exceptConnId is not null && state.Conn.Id == exceptConnId) continue;
                // Still handshaking: hold the frame until welcome and the replay tail are out.
                if (state.Backlog is not null) { state.Backlog.Add(frame); continue; }
                // Recorded before the replay read but fanned out after it: already delivered.
                if (seq is { } s && s <= state.ReplayedThrough) continue;
                targets.Add(state);
            }
        }
        foreach (var state in targets) state.Conn.Send(frame);
    }

    private static long? SeqOf(IReadOnlyDictionary<string, object?> frame) => frame.GetValueOrDefault("seq") switch
    {
        long l => l,
        int i => i,
        _ => null,
    };

    private IReadOnlyDictionary<string, object?> BuildMeta(string convId, ConnState state, string text, IReadOnlyDictionary<string, object?>? frameMeta)
    {
        var meta = new Frame();
        if (_cfg.Context is not null) meta["mekik"] = _cfg.Context((convId, state.UserId), (text, frameMeta));
        if (state.Claims is not null) meta["auth"] = state.Claims;
        // Client meta is this connection's hello.meta with the frame's own meta laid
        // over it per key (§6); only the allowlisted subset survives.
        IReadOnlyDictionary<string, object?>? clientMeta = null;
        if (state.HelloMeta is not null || frameMeta is not null)
        {
            var merged = new Frame();
            foreach (var kv in state.HelloMeta ?? new Frame()) merged[kv.Key] = kv.Value;
            foreach (var kv in frameMeta ?? new Frame()) merged[kv.Key] = kv.Value;
            clientMeta = merged;
        }
        if (_cfg.AcceptClientMeta is not null && clientMeta is not null)
        {
            var client = _cfg.AcceptClientMeta(clientMeta);
            if (client is not null) meta["client"] = client;
        }
        // The turn's client-tool snapshot (§11.2): taken here, at run start, so a
        // set that changes mid-run does not shift under the node's feet.
        if (ClientToolsFor(convId) is { } clientTools) meta["clientTools"] = clientTools;
        // The turn's skill set (§12.3): the server catalog plus accepted client
        // declarations, merged once at run start for the same reason.
        var clientSkills = ClientSkillsFor(convId);
        if (_cfg.Skills is not null || clientSkills.Count > 0)
            meta["skills"] = new TurnSkillSource(_cfg.Skills, clientSkills);
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
