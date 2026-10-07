using System.Security.Cryptography;

namespace Mekik;

using Frame = System.Collections.Generic.Dictionary<string, object?>;

/// <summary>Options for <see cref="MekikA2aServer"/> (PROTOCOL.md §14), mirror of TypeScript's <c>A2aServerOptions</c>.</summary>
public sealed record A2aServerOptions
{
    /// <summary>The agent's name on its card.</summary>
    public required string Name { get; init; }
    /// <summary>What the agent does — what a calling agent reads on the card.</summary>
    public string? Description { get; init; }
    /// <summary>Where this agent's JSON-RPC endpoint is reachable — the card's <c>url</c>.</summary>
    public required string Url { get; init; }
    /// <summary>The agent's version on its card. Default <c>"0"</c>.</summary>
    public string? Version { get; init; }
    /// <summary>Skills listed on the card — pass the app's skill catalog summaries; the agent itself is always listed first.</summary>
    public IReadOnlyList<SkillSummary>? Skills { get; init; }
    /// <summary>The mekik <c>userId</c> every A2A conversation belongs to. Default <c>"a2a"</c>.</summary>
    public string? UserId { get; init; }
    /// <summary>Where tasks are kept. Default in-memory.</summary>
    public IA2aTaskStore? Tasks { get; init; }
    /// <summary>Clock for <c>status.timestamp</c> (ms since epoch); injected by tests.</summary>
    public Func<long>? Now { get; init; }
    /// <summary>Id minter for tasks, messages and artifacts (<c>kind</c> is <c>task</c>, <c>message</c> or <c>artifact</c>); injected by tests.</summary>
    public Func<string, string>? MintId { get; init; }
}

/// <summary>The task store port: a task (as a wire dictionary) by id.</summary>
public interface IA2aTaskStore
{
    Task<IReadOnlyDictionary<string, object?>?> GetAsync(string id);
    Task PutAsync(IReadOnlyDictionary<string, object?> task);
}

public sealed class InMemoryA2aTaskStore : IA2aTaskStore
{
    private readonly Dictionary<string, IReadOnlyDictionary<string, object?>> _tasks = new();
    private readonly object _gate = new();
    public Task<IReadOnlyDictionary<string, object?>?> GetAsync(string id)
    {
        lock (_gate) return Task.FromResult(_tasks.GetValueOrDefault(id));
    }
    public Task PutAsync(IReadOnlyDictionary<string, object?> task)
    {
        lock (_gate) _tasks[(string)task["id"]!] = task;
        return Task.CompletedTask;
    }
}

/// <summary>A bad request — answered with the given JSON-RPC code (default <c>-32602</c>).</summary>
public sealed class A2aRequestException(string message, int code = -32602) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// A <see cref="MekikApp"/> exposed as an A2A agent (PROTOCOL.md §14): <c>message/send</c>
/// runs a turn (or answers a paused task), <c>tasks/get</c> and <c>tasks/cancel</c> read and
/// cancel tasks, and the Agent Card describes it all. One mekik conversation is one A2A
/// <c>contextId</c>; one turn is one task; a run that paused for a human is
/// <c>input-required</c>. Mirror of TypeScript's <c>MekikA2aServer</c>.
/// </summary>
public sealed class MekikA2aServer
{
    public const string ProtocolVersion = "0.3.0";
    public const int TaskNotFound = -32001;
    public const int TaskNotCancelable = -32002;
    public const int UnsupportedOperation = -32004;
    public const int ContentTypeNotSupported = -32005;

    private readonly MekikApp _app;
    private readonly A2aServerOptions _options;
    private readonly IA2aTaskStore _tasks;
    private readonly Func<long> _now;
    private readonly Func<string, string> _mint;
    private int _connSeq;

    public MekikA2aServer(MekikApp app, A2aServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(app);
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrEmpty(options.Name)) throw new ArgumentException("an A2A agent needs a name", nameof(options));
        if (string.IsNullOrEmpty(options.Url)) throw new ArgumentException("an A2A agent card needs the url its JSON-RPC endpoint is served at", nameof(options));
        _app = app;
        _options = options;
        _tasks = options.Tasks ?? new InMemoryA2aTaskStore();
        _now = options.Now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _mint = options.MintId ?? (kind => $"{kind}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}");
    }

    /// <summary>The Agent Card (<c>/.well-known/agent-card.json</c>).</summary>
    public Frame AgentCard()
    {
        var description = _options.Description ?? $"The {_options.Name} agent, served by mekik.";
        var skills = new List<object?>
        {
            new Frame { ["id"] = "chat", ["name"] = _options.Name, ["description"] = description, ["tags"] = new List<object?> { "chat" } },
        };
        foreach (var s in _options.Skills ?? [])
            skills.Add(new Frame { ["id"] = s.Name, ["name"] = s.Name, ["description"] = s.Description, ["tags"] = (s.Tags ?? []).Cast<object?>().ToList() });
        return new Frame
        {
            ["protocolVersion"] = ProtocolVersion,
            ["name"] = _options.Name,
            ["description"] = description,
            ["url"] = _options.Url,
            ["preferredTransport"] = "JSONRPC",
            ["version"] = _options.Version ?? "0",
            ["capabilities"] = new Frame { ["streaming"] = false, ["pushNotifications"] = false, ["stateTransitionHistory"] = false },
            ["defaultInputModes"] = new List<object?> { "text/plain" },
            ["defaultOutputModes"] = new List<object?> { "text/plain" },
            ["skills"] = skills,
        };
    }

    /// <summary>Handle one JSON-RPC message (a parsed dictionary, or a JSON string). Returns null for a notification.</summary>
    public async Task<Frame?> HandleAsync(object? message)
    {
        if (message is string text)
        {
            try { message = Json.Parse(text); }
            catch { return RpcError(null, -32700, "parse error"); }
        }
        if (message is not IReadOnlyDictionary<string, object?> req) return RpcError(null, -32600, "request must be a JSON-RPC object");
        var id = req.GetValueOrDefault("id");
        if (req.GetValueOrDefault("jsonrpc") is not "2.0" || req.GetValueOrDefault("method") is not string method)
            return RpcError(id, -32600, "request must carry jsonrpc \"2.0\" and a method");
        if (!req.ContainsKey("id")) return null;
        var parameters = req.GetValueOrDefault("params") as IReadOnlyDictionary<string, object?> ?? new Frame();

        try
        {
            switch (method)
            {
                case "message/send":
                    return Ok(id, await SendMessageAsync(parameters).ConfigureAwait(false));
                case "tasks/get":
                {
                    var historyLength = parameters.GetValueOrDefault("historyLength") switch { long l => (int?)l, int i => i, double d => (int)d, _ => null };
                    return Ok(id, await GetTaskAsync(RequireString(parameters.GetValueOrDefault("id"), "id"), historyLength).ConfigureAwait(false));
                }
                case "tasks/cancel":
                    return Ok(id, await CancelTaskAsync(RequireString(parameters.GetValueOrDefault("id"), "id")).ConfigureAwait(false));
                case "message/stream":
                case "tasks/resubscribe":
                    return RpcError(id, UnsupportedOperation, $"{method} is not supported: this agent does not stream");
                case "tasks/pushNotificationConfig/set":
                case "tasks/pushNotificationConfig/get":
                case "tasks/pushNotificationConfig/list":
                case "tasks/pushNotificationConfig/delete":
                    return RpcError(id, UnsupportedOperation, $"{method} is not supported: this agent does not push notifications");
                default:
                    return RpcError(id, -32601, $"method not found: {method}");
            }
        }
        catch (A2aRequestException ex) { return RpcError(id, ex.Code, ex.Message); }
        catch (Exception ex) { return RpcError(id, -32603, ex.Message); }
    }

    /// <summary>
    /// <c>message/send</c>: a message without <c>taskId</c> starts a task — a new turn on the
    /// conversation <c>contextId</c> names, or a fresh conversation; a message naming an
    /// <c>input-required</c> task answers its open interrupts and continues it. Returns the task.
    /// </summary>
    public async Task<Frame> SendMessageAsync(IReadOnlyDictionary<string, object?> parameters)
    {
        var message = ParseMessage(parameters.GetValueOrDefault("message"));
        if (message.GetValueOrDefault("taskId") is string taskId) return await ResumeAsync(taskId, message).ConfigureAwait(false);

        var text = TextOf(message);
        if (text.Length == 0) throw new A2aRequestException("message needs at least one text part", ContentTypeNotSupported);
        var newTaskId = _mint("task");
        var (convId, frames) = await MekikMcpServer.DriveTurnAsync(_app, $"a2a-{Interlocked.Increment(ref _connSeq)}", _options.UserId ?? "a2a",
            message.GetValueOrDefault("contextId") as string, new Frame { ["type"] = "text", ["data"] = new Frame { ["text"] = text } }).ConfigureAwait(false);
        var result = (IReadOnlyDictionary<string, object?>)MekikMcpServer.Summarize(convId, frames, "message/send with taskId", false)["structuredContent"]!;
        var sent = new Frame(message) { ["taskId"] = newTaskId, ["contextId"] = convId };
        var task = ToTask(newTaskId, result, [sent], null);
        await _tasks.PutAsync(task).ConfigureAwait(false);
        return task;
    }

    private async Task<Frame> ResumeAsync(string taskId, Frame message)
    {
        var existing = await _tasks.GetAsync(taskId).ConfigureAwait(false)
            ?? throw new A2aRequestException($"task \"{taskId}\" not found", TaskNotFound);
        var state = StateOfTask(existing);
        if (state != "input-required") throw new A2aRequestException($"task \"{taskId}\" is {state} and takes no more input");
        var pending = (existing.GetValueOrDefault("metadata") as IReadOnlyDictionary<string, object?>)?.GetValueOrDefault("pending") as IEnumerable<object?>;
        var answers = AnswersFor(message, (pending ?? []).Cast<IReadOnlyDictionary<string, object?>>().ToList());
        var contextId = (string)existing["contextId"]!;
        var (convId, frames) = await MekikMcpServer.DriveTurnAsync(_app, $"a2a-{Interlocked.Increment(ref _connSeq)}", _options.UserId ?? "a2a",
            contextId, new Frame { ["type"] = "resume", ["answers"] = answers }).ConfigureAwait(false);
        var result = (IReadOnlyDictionary<string, object?>)MekikMcpServer.Summarize(convId, frames, "message/send with taskId", false)["structuredContent"]!;
        var history = ((existing.GetValueOrDefault("history") as IEnumerable<object?>) ?? []).ToList();
        history.Add(new Frame(message) { ["contextId"] = contextId });
        var task = ToTask(taskId, result, history, existing);
        await _tasks.PutAsync(task).ConfigureAwait(false);
        return task;
    }

    /// <summary><c>tasks/get</c>: the task, its history truncated to the last <paramref name="historyLength"/> messages when given.</summary>
    public async Task<Frame> GetTaskAsync(string id, int? historyLength = null)
    {
        var task = await _tasks.GetAsync(id).ConfigureAwait(false) ?? throw new A2aRequestException($"task \"{id}\" not found", TaskNotFound);
        var copy = new Frame(task);
        if (historyLength is { } n && task.GetValueOrDefault("history") is IEnumerable<object?> history)
        {
            var list = history.ToList();
            copy["history"] = n <= 0 ? new List<object?>() : list.Skip(Math.Max(0, list.Count - n)).ToList();
        }
        return copy;
    }

    /// <summary>
    /// <c>tasks/cancel</c>: an <c>input-required</c> task becomes <c>canceled</c> — the conversation
    /// stays parked on its interrupts (mekik never discards a pause on a caller's behalf). A
    /// finished task is not cancelable.
    /// </summary>
    public async Task<Frame> CancelTaskAsync(string id)
    {
        var task = await _tasks.GetAsync(id).ConfigureAwait(false) ?? throw new A2aRequestException($"task \"{id}\" not found", TaskNotFound);
        var state = StateOfTask(task);
        if (state != "input-required") throw new A2aRequestException($"task \"{id}\" is {state} and cannot be canceled", TaskNotCancelable);
        var canceled = new Frame(task) { ["status"] = new Frame { ["state"] = "canceled", ["timestamp"] = Timestamp() } };
        await _tasks.PutAsync(canceled).ConfigureAwait(false);
        return canceled;
    }

    private Frame ToTask(string id, IReadOnlyDictionary<string, object?> result, List<object?> history, IReadOnlyDictionary<string, object?>? previous)
    {
        var status = (string)result["status"]!;
        var reply = result.GetValueOrDefault("reply") as string ?? "";
        var conversationId = (string)result["conversationId"]!;
        var pending = (result.GetValueOrDefault("pending") as IEnumerable<object?> ?? []).ToList();

        var artifacts = ((previous?.GetValueOrDefault("artifacts") as IEnumerable<object?>) ?? []).ToList();
        if (reply.Length > 0 && status != "refused" && status != "error")
            artifacts.Add(new Frame { ["artifactId"] = _mint("artifact"), ["name"] = "reply", ["parts"] = new List<object?> { new Frame { ["kind"] = "text", ["text"] = reply } } });

        var statusMessage = StatusMessage(id, conversationId, status, reply, pending);
        if (statusMessage is not null) history.Add(statusMessage);

        var metadata = new Frame
        {
            ["mekik"] = new Frame
            {
                ["conversationId"] = conversationId, ["status"] = status,
                ["toolCalls"] = result.GetValueOrDefault("toolCalls"), ["skills"] = result.GetValueOrDefault("skills"),
            },
        };
        if (pending.Count > 0) metadata["pending"] = pending;

        var statusFrame = new Frame { ["state"] = StateOf(status), ["timestamp"] = Timestamp() };
        if (statusMessage is not null) statusFrame["message"] = statusMessage;
        return new Frame
        {
            ["kind"] = "task",
            ["id"] = id,
            ["contextId"] = conversationId,
            ["status"] = statusFrame,
            ["artifacts"] = artifacts,
            ["history"] = history,
            ["metadata"] = metadata,
        };
    }

    private Frame? StatusMessage(string taskId, string conversationId, string status, string reply, List<object?> pending)
    {
        string? text = null;
        var parts = new List<object?>();
        switch (status)
        {
            case "interrupted":
                text = "The agent needs input before it can continue:\n" +
                    string.Join("\n", pending.Cast<IReadOnlyDictionary<string, object?>>().Select(p => $"- interrupt {Json.Canonicalize(p["id"])}: {Describe(p)}")) +
                    "\nReply on this task: a text message answers a single open interrupt (an action's label or value), or a data part {\"answers\": {<interrupt id>: <answer>}} answers several.";
                parts.Add(new Frame { ["kind"] = "data", ["data"] = new Frame { ["pending"] = pending } });
                break;
            case "error":
                text = reply.Length > 0 ? reply : "the run failed";
                break;
            case "refused":
                text = reply.Length > 0 ? reply : "the turn was refused";
                break;
            case "aborted":
                text = "The run was aborted; the conversation can be continued.";
                break;
            default:
                return null;
        }
        var allParts = new List<object?> { new Frame { ["kind"] = "text", ["text"] = text } };
        allParts.AddRange(parts);
        return new Frame
        {
            ["kind"] = "message",
            ["messageId"] = _mint("message"),
            ["role"] = "agent",
            ["taskId"] = taskId,
            ["contextId"] = conversationId,
            ["parts"] = allParts,
        };
    }

    private string Timestamp() => DateTimeOffset.FromUnixTimeMilliseconds(_now()).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    // ── pure helpers ──────────────────────────────────────────────────────────

    /// <summary>A2A task state for a turn's status.</summary>
    public static string StateOf(string status) => status switch
    {
        "finished" => "completed",
        "interrupted" => "input-required",
        "error" => "failed",
        "aborted" => "canceled",
        _ => "rejected",
    };

    private static string StateOfTask(IReadOnlyDictionary<string, object?> task) =>
        (task.GetValueOrDefault("status") as IReadOnlyDictionary<string, object?>)?.GetValueOrDefault("state") as string ?? "unknown";

    /// <summary>Validate an inbound <c>message</c> param; throws <see cref="A2aRequestException"/>. Mirror of TypeScript's <c>parseMessage</c>.</summary>
    public static Frame ParseMessage(object? raw)
    {
        if (raw is not IReadOnlyDictionary<string, object?> m) throw new A2aRequestException("`message` is required");
        if (m.GetValueOrDefault("role") is not ("user" or "agent")) throw new A2aRequestException("`message.role` must be \"user\" or \"agent\"");
        if (m.GetValueOrDefault("parts") is not IEnumerable<object?> rawParts || !rawParts.Any())
            throw new A2aRequestException("`message.parts` must be a non-empty array");
        var parts = new List<object?>();
        var i = 0;
        foreach (var p in rawParts)
        {
            if (p is not IReadOnlyDictionary<string, object?> part) throw new A2aRequestException($"message.parts[{i}] must be an object");
            var kind = part.GetValueOrDefault("kind") as string;
            if (kind == "text" && part.GetValueOrDefault("text") is string t) parts.Add(new Frame { ["kind"] = "text", ["text"] = t });
            else if (kind == "data" && part.GetValueOrDefault("data") is IReadOnlyDictionary<string, object?> d) parts.Add(new Frame { ["kind"] = "data", ["data"] = d });
            else if (kind == "file" && part.GetValueOrDefault("file") is IReadOnlyDictionary<string, object?> f) parts.Add(new Frame { ["kind"] = "file", ["file"] = f });
            else throw new A2aRequestException($"message.parts[{i}] must be a text, data or file part");
            i++;
        }
        var message = new Frame
        {
            ["kind"] = "message",
            ["messageId"] = m.GetValueOrDefault("messageId") is string mid && mid.Length > 0 ? mid : $"message-{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}",
            ["role"] = m["role"],
            ["parts"] = parts,
        };
        if (m.TryGetValue("taskId", out var taskId) && taskId is not null)
            message["taskId"] = taskId as string ?? throw new A2aRequestException("`message.taskId` must be a string");
        if (m.TryGetValue("contextId", out var contextId) && contextId is not null)
            message["contextId"] = contextId as string ?? throw new A2aRequestException("`message.contextId` must be a string");
        if (m.GetValueOrDefault("metadata") is IReadOnlyDictionary<string, object?> metadata) message["metadata"] = metadata;
        return message;
    }

    /// <summary>The text parts of a message, joined by newlines.</summary>
    public static string TextOf(IReadOnlyDictionary<string, object?> message) =>
        string.Join("\n", ((IEnumerable<object?>)message["parts"]!).Cast<IReadOnlyDictionary<string, object?>>()
            .Where(p => p.GetValueOrDefault("kind") as string == "text")
            .Select(p => (string)p["text"]!)).Trim();

    /// <summary>
    /// Turn a message on an <c>input-required</c> task into the <c>resume</c> answers (PROTOCOL.md
    /// §14.3): a data part with <c>answers</c> is used as-is; otherwise a single open interrupt
    /// takes the message — its text, or the value of the action whose label the text matches,
    /// or the data part itself; several open interrupts require the <c>answers</c> form.
    /// </summary>
    public static Frame AnswersFor(IReadOnlyDictionary<string, object?> message, IReadOnlyList<IReadOnlyDictionary<string, object?>> pending)
    {
        var parts = ((IEnumerable<object?>)message["parts"]!).Cast<IReadOnlyDictionary<string, object?>>().ToList();
        var data = parts.FirstOrDefault(p => p.GetValueOrDefault("kind") as string == "data")?.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>;
        if (data?.GetValueOrDefault("answers") is IReadOnlyDictionary<string, object?> answers) return new Frame(answers);
        if (pending.Count == 0) throw new A2aRequestException("the task has no open interrupt to answer");
        if (pending.Count > 1)
            throw new A2aRequestException($"the task has {pending.Count} open interrupts; answer them all with a data part {{\"answers\": {{<id>: <answer>}}}}");
        var only = pending[0];
        var id = (string)only["id"]!;
        if (data is not null) return new Frame { [id] = data };
        var text = TextOf(message);
        if (text.Length == 0) throw new A2aRequestException("message needs a text or data part to answer the open interrupt");
        var action = (only.GetValueOrDefault("actions") as IEnumerable<object?>)?.Cast<IReadOnlyDictionary<string, object?>>()
            .FirstOrDefault(a => a.GetValueOrDefault("label") as string == text);
        if (action is null) return new Frame { [id] = text };
        return new Frame { [id] = action.TryGetValue("value", out var v) && v is not null ? v : action["label"] };
    }

    private static string Describe(IReadOnlyDictionary<string, object?> p)
    {
        if (p.GetValueOrDefault("tool") is string tool) return $"a client tool call ({tool}) that only the conversation's own UI can answer";
        var payload = p.GetValueOrDefault("payload");
        // A string reads as itself; anything else as its canonical JSON — culture-free, and
        // what TypeScript's String()/JSON.stringify print (249.9, true, null), never "249,9" or "True".
        var text = payload is string str ? str : Json.Canonicalize(payload);
        var labels = (p.GetValueOrDefault("actions") as IEnumerable<object?>)?.Cast<IReadOnlyDictionary<string, object?>>().Select(a => a.GetValueOrDefault("label") as string ?? "").ToList();
        return labels is { Count: > 0 } ? $"{text} — options: {string.Join(", ", labels)}" : text;
    }

    private static string RequireString(object? v, string field) =>
        v is string s && s.Length > 0 ? s : throw new A2aRequestException($"`{field}` (string) is required");

    private static Frame Ok(object? id, object? result) => new() { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result };

    private static Frame RpcError(object? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0", ["id"] = id, ["error"] = new Frame { ["code"] = (long)code, ["message"] = message },
    };
}
