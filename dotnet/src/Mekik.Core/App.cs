using Ilmek;

namespace Mekik;

/// <summary>Options for <see cref="MekikApp"/> (PROTOCOL.md §5, §6), mirror of the TypeScript `MekikOptions`.</summary>
public sealed record MekikOptions
{
    /// <summary>The ilmek graph this app serves. One run == one conversational turn.</summary>
    public required CompiledGraph Graph { get; init; }
    /// <summary>ilmek's checkpointer (durable HITL). Default: in-memory.</summary>
    public ICheckpointer? Checkpointer { get; init; }
    /// <summary>Map an inbound `text` turn to the graph's input update. Default: `{ input = text }`.</summary>
    public Func<IReadOnlyDictionary<string, object?>, IReadOnlyDictionary<string, object?>>? Input { get; init; }
    /// <summary>Pick the run's consolidated reply text from final channel state (PROTOCOL.md §4.3).</summary>
    public Func<IReadOnlyDictionary<string, object?>, string?>? Reply { get; init; }
    /// <summary>Per-turn server context placed at `ctx.Meta["mekik"]` (PROTOCOL.md §6).</summary>
    public Func<(string ConversationId, string UserId), (string Text, IReadOnlyDictionary<string, object?>? Meta), IReadOnlyDictionary<string, object?>>? Context { get; init; }
    /// <summary>Allowlist client-supplied meta into `ctx.Meta["client"]`. Default: drop everything.</summary>
    public Func<IReadOnlyDictionary<string, object?>, IReadOnlyDictionary<string, object?>?>? AcceptClientMeta { get; init; }
    /// <summary>
    /// What the bot sends once when a fresh conversation first connects (before any turn)
    /// — a greeting / instructions. Not sent on reconnect (the transcript already has it).
    /// Return <c>null</c> for no greeting.
    /// </summary>
    /// <remarks>
    /// A <see cref="string"/> is one <c>text</c> frame. It may also be a <b>described rich
    /// message</b> (<see cref="Messages.Spec"/> or a <c>…Spec</c> builder, PROTOCOL.md §4.5),
    /// or an <see cref="System.Collections.IEnumerable"/> mixing both, delivered in order —
    /// so a first impression can be a card with buttons rather than a paragraph. Each item
    /// lands as its own persistent frame and replays on reconnect like any other.
    ///
    /// <para>GenUI components are deliberately not accepted here: a chunk belongs to a turn's
    /// stream, and the greeting fires outside any run. Send the same thing as a message.</para>
    /// </remarks>
    /// <example><code>
    /// Greeting = conv => new object[]
    /// {
    ///     $"Hi {conv.UserId}! What can I do for you?",
    ///     Messages.ButtonsSpec([Messages.Button("Track an order", "/track")]),
    /// },
    /// </code></example>
    public Func<(string ConversationId, string UserId), object?>? Greeting { get; init; }
    public IAuthenticator? Authenticator { get; init; }
    public IHistoryStore? History { get; init; }
    public IConversationStore? Conversations { get; init; }
    /// <summary>Cross-node single-writer turn lease (docs/SCALING.md). Default: <see cref="LocalTurnLock"/>.</summary>
    public ITurnLock? TurnLock { get; init; }
    /// <summary>Cross-node fan-out backplane (docs/SCALING.md). Default: <see cref="NoopBackplane"/>.</summary>
    public IBackplane? Backplane { get; init; }
    public int? RecursionLimit { get; init; }
    public IIdMinter? Minter { get; init; }
    public Func<long>? Now { get; init; }
}

/// <summary>
/// The assembly point: wires ilmek + the ports + the engine into one app a
/// transport can drive. Sensible in-memory defaults everywhere. Mirror of the
/// TypeScript <c>mekik({ … })</c> factory.
/// </summary>
public sealed class MekikApp
{
    public ConversationEngine Engine { get; }
    public IlmekAdapter Adapter { get; }
    public IHistoryStore History { get; }
    public IConversationStore Conversations { get; }

    public MekikApp(MekikOptions options)
    {
        var checkpointer = options.Checkpointer ?? new InMemoryCheckpointer();
        Adapter = new IlmekAdapter(options.Graph, checkpointer, options.RecursionLimit);
        History = options.History ?? new InMemoryHistoryStore();
        Conversations = options.Conversations ?? new InMemoryConversationStore();

        Engine = new ConversationEngine(new EngineConfig
        {
            Adapter = Adapter,
            History = History,
            Conversations = Conversations,
            Authenticator = options.Authenticator,
            Input = options.Input ?? (f => new Dictionary<string, object?>
            {
                ["input"] = ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"],
            }),
            Reply = options.Reply,
            Context = options.Context,
            AcceptClientMeta = options.AcceptClientMeta,
            Greeting = options.Greeting,
            Minter = options.Minter ?? new RandomMinter(),
            Now = options.Now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            TurnLock = options.TurnLock ?? new LocalTurnLock(),
            Backplane = options.Backplane ?? new NoopBackplane(),
        });
    }

    /// <summary>Register a new connection and run the handshake (§1).</summary>
    public Task ConnectAsync(IConnection conn, ConnectParams? paramsIn = null) => Engine.ConnectAsync(conn, paramsIn);

    /// <summary>Feed one inbound frame (JSON string or parsed object).</summary>
    public Task ReceiveAsync(IConnection conn, object? raw) => Engine.ReceiveAsync(conn, raw);

    /// <summary>Drop a connection (socket closed).</summary>
    public void Disconnect(IConnection conn) => Engine.Disconnect(conn);
}
