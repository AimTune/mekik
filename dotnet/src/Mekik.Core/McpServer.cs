namespace Mekik;

using Frame = System.Collections.Generic.Dictionary<string, object?>;

/// <summary>Options for <see cref="MekikMcpServer"/> (PROTOCOL.md §13), mirror of TypeScript's <c>McpServerOptions</c>.</summary>
public sealed record McpServerOptions
{
    /// <summary>The tool's name — what a calling agent invokes. Letters, digits, <c>_</c> and <c>-</c>, at most 64 characters.</summary>
    public required string Name { get; init; }
    /// <summary>What the agent does; this is what a calling model reads.</summary>
    public string? Description { get; init; }
    /// <summary><c>serverInfo</c> in the <c>initialize</c> result. Default <c>{ name: "mekik", version: "0" }</c>.</summary>
    public (string Name, string Version)? ServerInfo { get; init; }
    /// <summary>The mekik <c>userId</c> every MCP conversation belongs to. Default <c>"mcp"</c>.</summary>
    public string? UserId { get; init; }
    /// <summary>Put the turn's persistent frames in <c>structuredContent.frames</c>. Default off.</summary>
    public bool IncludeFrames { get; init; }
}

/// <summary>A bad argument shape — the JSON-RPC layer answers <c>-32602</c>.</summary>
public sealed class McpArgumentException(string message) : Exception(message);

/// <summary>
/// A <see cref="MekikApp"/> exposed as an MCP server (PROTOCOL.md §13): two tools —
/// <c>&lt;name&gt;</c> runs a turn, <c>&lt;name&gt;__resume</c> answers a paused one —
/// over any JSON-RPC transport. Transport-agnostic: it drives the engine through an
/// in-process <see cref="IConnection"/>, exactly as the conformance suite does.
/// <see cref="MekikAspNetCore.MapMekikMcp"/> puts it behind Streamable HTTP. Mirror of
/// TypeScript's <c>MekikMcpServer</c>.
/// </summary>
public sealed class MekikMcpServer
{
    /// <summary>The MCP protocol revisions this server speaks; the first is what it answers an unknown request with.</summary>
    public static readonly IReadOnlyList<string> ProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];

    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    private static readonly System.Text.RegularExpressions.Regex ToolName = new("^[A-Za-z0-9_-]{1,64}$");

    private readonly MekikApp _app;
    private readonly McpServerOptions _options;
    private int _connSeq;

    public string Name { get; }

    /// <summary>The resume tool's name: <c>&lt;name&gt;__resume</c>.</summary>
    public string ResumeName => $"{Name}__resume";

    public MekikMcpServer(MekikApp app, McpServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(app);
        ArgumentNullException.ThrowIfNull(options);
        if (!ToolName.IsMatch(options.Name))
            throw new ArgumentException($"MCP tool name \"{options.Name}\" must be 1–64 letters, digits, \"_\" or \"-\"", nameof(options));
        _app = app;
        _options = options;
        Name = options.Name;
    }

    /// <summary>What <c>tools/list</c> advertises, as wire dictionaries.</summary>
    public IReadOnlyList<Frame> Tools()
    {
        var description = _options.Description ?? $"Talk to the {Name} agent.";
        return
        [
            new Frame
            {
                ["name"] = Name,
                ["description"] =
                    $"{description} Send one message and receive the agent's reply. If the result says it is " +
                    $"\"interrupted\", the agent is waiting for an answer: call {ResumeName} with the conversationId and answers.",
                ["inputSchema"] = new Frame
                {
                    ["type"] = "object",
                    ["properties"] = new Frame
                    {
                        ["message"] = new Frame { ["type"] = "string", ["description"] = "The user's message for this turn." },
                        ["conversationId"] = new Frame
                        {
                            ["type"] = "string",
                            ["description"] = "Continue an existing conversation (from a previous result). Omit to start a new one.",
                        },
                    },
                    ["required"] = new List<object?> { "message" },
                },
            },
            new Frame
            {
                ["name"] = ResumeName,
                ["description"] =
                    $"Answer the open interrupts of a paused {Name} conversation and continue it. " +
                    "Every id listed in the previous result's pending[] must be answered.",
                ["inputSchema"] = new Frame
                {
                    ["type"] = "object",
                    ["properties"] = new Frame
                    {
                        ["conversationId"] = new Frame { ["type"] = "string", ["description"] = "The paused conversation, from the previous result." },
                        ["answers"] = new Frame
                        {
                            ["type"] = "object",
                            ["description"] = "Answers keyed by interrupt id. For a pause with actions, an action's value (or its label).",
                            ["additionalProperties"] = true,
                        },
                    },
                    ["required"] = new List<object?> { "conversationId", "answers" },
                },
            },
        ];
    }

    /// <summary>
    /// Run one tool. Argument shape errors throw <see cref="McpArgumentException"/> (the
    /// JSON-RPC layer maps them to <c>-32602</c>); a turn that fails inside the graph is a
    /// <b>result</b> with <c>isError: true</c>, as the protocol wants.
    /// </summary>
    public async Task<Frame> CallToolAsync(string name, IReadOnlyDictionary<string, object?>? arguments = null)
    {
        arguments ??= new Frame();
        if (name == Name)
        {
            if (arguments.GetValueOrDefault("message") is not string message)
                throw new McpArgumentException("`message` (string) is required");
            var conversationId = OptionalString(arguments.GetValueOrDefault("conversationId"), "conversationId");
            return await TurnAsync(conversationId, new Frame { ["type"] = "text", ["data"] = new Frame { ["text"] = message } }).ConfigureAwait(false);
        }
        if (name == ResumeName)
        {
            var conversationId = OptionalString(arguments.GetValueOrDefault("conversationId"), "conversationId")
                ?? throw new McpArgumentException("`conversationId` (string) is required");
            if (arguments.GetValueOrDefault("answers") is not IReadOnlyDictionary<string, object?> answers)
                throw new McpArgumentException("`answers` (object keyed by interrupt id) is required");
            return await TurnAsync(conversationId, new Frame { ["type"] = "resume", ["answers"] = answers }).ConfigureAwait(false);
        }
        throw new McpArgumentException($"unknown tool \"{name}\"");
    }

    /// <summary>Handle one JSON-RPC message (a parsed dictionary, or a JSON string). Returns null for a notification.</summary>
    public async Task<Frame?> HandleAsync(object? message)
    {
        if (message is string text)
        {
            try { message = Json.Parse(text); }
            catch { return RpcError(null, ParseError, "parse error"); }
        }
        if (message is not IReadOnlyDictionary<string, object?> req)
            return RpcError(null, InvalidRequest, "request must be a JSON-RPC object");

        var id = req.GetValueOrDefault("id");
        if (req.GetValueOrDefault("jsonrpc") is not "2.0" || req.GetValueOrDefault("method") is not string method)
            return RpcError(id, InvalidRequest, "request must carry jsonrpc \"2.0\" and a method");
        if (!req.ContainsKey("id")) return null; // a notification: initialized, cancelled, progress …

        var parameters = req.GetValueOrDefault("params") as IReadOnlyDictionary<string, object?> ?? new Frame();
        switch (method)
        {
            case "initialize":
            {
                var requested = parameters.GetValueOrDefault("protocolVersion") as string ?? "";
                var info = _options.ServerInfo ?? ("mekik", "0");
                return Ok(id, new Frame
                {
                    ["protocolVersion"] = ProtocolVersions.Contains(requested) ? requested : ProtocolVersions[0],
                    ["capabilities"] = new Frame { ["tools"] = new Frame() },
                    ["serverInfo"] = new Frame { ["name"] = info.Name, ["version"] = info.Version },
                });
            }
            case "ping":
                return Ok(id, new Frame());
            case "tools/list":
                return Ok(id, new Frame { ["tools"] = Tools().Cast<object?>().ToList() });
            case "tools/call":
            {
                if (parameters.GetValueOrDefault("name") is not string name) return RpcError(id, InvalidParams, "`name` is required");
                var args = parameters.GetValueOrDefault("arguments") as IReadOnlyDictionary<string, object?> ?? new Frame();
                try { return Ok(id, await CallToolAsync(name, args).ConfigureAwait(false)); }
                catch (McpArgumentException ex) { return RpcError(id, InvalidParams, ex.Message); }
                catch (Exception ex) { return RpcError(id, InternalError, ex.Message); }
            }
            default:
                return RpcError(id, MethodNotFound, $"method not found: {method}");
        }
    }

    // ── one turn over an in-process connection ────────────────────────────────

    private sealed class CollectingConnection(string id) : IConnection
    {
        public string Id => id;
        public List<IReadOnlyDictionary<string, object?>> Frames { get; } = new();
        public void Send(IReadOnlyDictionary<string, object?> frame) => Frames.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    private async Task<Frame> TurnAsync(string? conversationId, Frame frame)
    {
        var (convId, frames) = await DriveTurnAsync(_app, $"mcp-{Interlocked.Increment(ref _connSeq)}", _options.UserId ?? "mcp", conversationId, frame).ConfigureAwait(false);
        return Summarize(convId, frames, ResumeName, _options.IncludeFrames);
    }

    /// <summary>
    /// Run one turn of an app over an in-process connection and collect the frames it
    /// produced (PROTOCOL.md §13.2, §14.2): connect as <paramref name="userId"/> on
    /// <paramref name="conversationId"/> (a fresh conversation when null or unknown),
    /// drop the handshake and replay, send <paramref name="frame"/>, return what came
    /// back. Shared by the MCP and A2A servers. Mirror of TypeScript's <c>driveTurn</c>.
    /// </summary>
    public static async Task<(string ConversationId, IReadOnlyList<IReadOnlyDictionary<string, object?>> Frames)> DriveTurnAsync(
        MekikApp app, string connectionId, string userId, string? conversationId, IReadOnlyDictionary<string, object?> frame)
    {
        var conn = new CollectingConnection(connectionId);
        try
        {
            await app.ConnectAsync(conn, new ConnectParams { Hello = new HelloInfo { UserId = userId, ConversationId = conversationId } }).ConfigureAwait(false);
            var welcome = conn.Frames.FirstOrDefault(f => f.GetValueOrDefault("type") as string == "welcome");
            var convId = (welcome?.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>)?.GetValueOrDefault("conversationId") as string
                ?? conversationId ?? "";
            conn.Frames.Clear(); // the handshake and replay are not this turn's output
            await app.ReceiveAsync(conn, frame).ConfigureAwait(false);
            return (convId, conn.Frames.ToList());
        }
        finally
        {
            app.Disconnect(conn);
        }
    }

    private static string? OptionalString(object? value, string field) => value switch
    {
        null => null,
        string s => s,
        _ => throw new McpArgumentException($"`{field}` must be a string"),
    };

    private static Frame Ok(object? id, object? result) => new() { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result };

    private static Frame RpcError(object? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id,
        ["error"] = new Frame { ["code"] = (long)code, ["message"] = message },
    };

    /// <summary>Reduce a turn's frames to the tool result. Pure — both languages pin it through the same cases.</summary>
    public static Frame Summarize(string conversationId, IReadOnlyList<IReadOnlyDictionary<string, object?>> frames, string resumeName, bool includeFrames)
    {
        string? status = null;
        var replies = new List<string>();
        var streamed = new List<string>();
        var pending = new List<Frame>();
        var tools = new Dictionary<string, IReadOnlyDictionary<string, object?>>();
        var order = new List<string>();
        var skills = new List<object?>();
        string? refused = null;

        foreach (var f in frames)
        {
            var data = f.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>;
            switch (f.GetValueOrDefault("type") as string)
            {
                case "run":
                    var s = data?.GetValueOrDefault("status") as string;
                    if (s is not null && s != "started") status = s;
                    break;
                case "text":
                    if (f.GetValueOrDefault("from") as string == "bot" && data?.GetValueOrDefault("text") is string t) replies.Add(t);
                    break;
                case "genui":
                    if (f.GetValueOrDefault("chunk") is IReadOnlyDictionary<string, object?> chunk &&
                        chunk.GetValueOrDefault("type") as string == "text" && chunk.GetValueOrDefault("content") is string c)
                        streamed.Add(c);
                    break;
                case "interrupt":
                    var view = new Frame { ["id"] = f.GetValueOrDefault("id"), ["payload"] = data?.GetValueOrDefault("payload") };
                    if (data?.GetValueOrDefault("actions") is { } actions) view["actions"] = actions;
                    if (data?.GetValueOrDefault("tool") is IReadOnlyDictionary<string, object?> tool) view["tool"] = tool.GetValueOrDefault("name");
                    pending.Add(view);
                    break;
                case "tool_call":
                    if (data?.GetValueOrDefault("id") is string tid)
                    {
                        if (!tools.ContainsKey(tid)) order.Add(tid);
                        tools[tid] = data;
                    }
                    break;
                case "skill":
                    if (data?.GetValueOrDefault("status") as string == "loaded") skills.Add(data.GetValueOrDefault("name"));
                    break;
                case "error":
                    refused = $"{data?.GetValueOrDefault("code")}: {data?.GetValueOrDefault("message")}";
                    break;
            }
        }

        status ??= "refused";
        var reply = status == "refused" ? refused ?? "the turn was refused" : replies.Count > 0 ? string.Join("\n", replies) : string.Concat(streamed);
        var result = new Frame
        {
            ["conversationId"] = conversationId,
            ["status"] = status,
            ["reply"] = reply,
            ["pending"] = pending.Cast<object?>().ToList(),
            ["toolCalls"] = order.Select(tid => (object?)new Frame
            {
                ["id"] = tools[tid]["id"], ["name"] = tools[tid].GetValueOrDefault("name"), ["status"] = tools[tid].GetValueOrDefault("status"),
            }).ToList(),
            ["skills"] = skills,
        };
        if (includeFrames) result["frames"] = frames.Where(f => f.ContainsKey("seq")).Cast<object?>().ToList();

        string text;
        var isError = false;
        switch (status)
        {
            case "finished":
                text = reply.Length > 0 ? reply : "(no reply)";
                break;
            case "interrupted":
                text = "The agent paused and needs input before it can continue:\n" +
                    string.Join("\n", pending.Select(p => $"- interrupt {Json.Canonicalize(p["id"])}: {DescribePending(p)}")) +
                    $"\nCall {resumeName} with conversationId {Json.Canonicalize(conversationId)} and an answers object keyed by those ids.";
                break;
            case "error":
                text = reply.Length > 0 ? reply : "the run failed";
                isError = true;
                break;
            case "aborted":
                text = "The run was aborted; the conversation can be continued.";
                break;
            default:
                text = reply;
                isError = true;
                break;
        }

        var outFrame = new Frame
        {
            ["content"] = new List<object?> { new Frame { ["type"] = "text", ["text"] = text } },
            ["structuredContent"] = result,
        };
        if (isError) outFrame["isError"] = true;
        return outFrame;
    }

    private static string DescribePending(Frame p)
    {
        if (p.GetValueOrDefault("tool") is string tool) return $"a client tool call ({tool}) that only the conversation's own UI can answer";
        var payload = p.GetValueOrDefault("payload");
        // A string reads as itself; anything else as its canonical JSON — culture-free, and
        // what TypeScript's String()/JSON.stringify print (249.9, true, null), never "249,9" or "True".
        var text = payload is string str ? str : Json.Canonicalize(payload);
        if (p.GetValueOrDefault("actions") is IEnumerable<object?> actions)
        {
            var options = actions.OfType<IReadOnlyDictionary<string, object?>>()
                .Select(a => Json.Canonicalize(a.GetValueOrDefault("value") ?? a.GetValueOrDefault("label")))
                .ToList();
            if (options.Count > 0) return $"{text} — options: {string.Join(", ", options)}";
        }
        return text;
    }
}
