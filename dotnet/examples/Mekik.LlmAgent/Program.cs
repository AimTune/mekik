// The same refund desk as ts/examples/llm-agent.ts, in .NET: nothing is
// scripted, a real Claude model reads the user's message and decides which
// functions to call, in what order, and when it is done. Mekik.Agents sits
// between the model and the functions so that every call it makes is
//
//   visible      — each call surfaces as a `tool_call` frame, live
//   approvable   — `refund_payment` pauses the graph for a human first
//   exactly-once — the pause replays the node, but journaled calls do not re-run
//
//   ANTHROPIC_API_KEY=sk-ant-… dotnet run --project dotnet/examples/Mekik.LlmAgent
//
// Needs a real API key, so this example is deliberately outside the CI test path
// (CI compiles it; it never runs it).
//
// The model↔tool loop is `Agent.RunAsync` (Mekik.Agents), not
// `ChatClientBuilder.UseFunctionInvocation()`. That helper owns the invocation and
// decides for itself what to do with an exception a function throws — and an ilmek
// pause *is* an exception in flight. Agent.RunAsync drives the loop so the interrupt
// propagates out of the node, which is what parks the graph.

using System.Text.Json;

using Anthropic;
using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

// ── the domain ────────────────────────────────────────────────────────────────

var orders = new Dictionary<string, Dictionary<string, object?>>
{
    ["ORD-42"] = new() { ["id"] = "ORD-42", ["total"] = 249.9, ["items"] = new[] { "Kettle", "Mug" }, ["customer"] = "CUS-7" },
    ["ORD-99"] = new() { ["id"] = "ORD-99", ["total"] = 18.5, ["items"] = new[] { "Cable" }, ["customer"] = "CUS-7" },
};

// Asserted to be 1 after the pause/resume cycle. This is the whole point: the
// node re-runs on resume, the model is asked again, and yet the refund is still
// charged exactly once because the function went through ctx.StepAsync.
var sideEffects = new Dictionary<string, int> { ["get_order"] = 0, ["refund_payment"] = 0, ["customer_tier"] = 0 };

// ── the functions the model may call ──────────────────────────────────────────

var functions = new List<AIFunction>
{
    AIFunctionFactory.Create(
        (string id) =>
        {
            sideEffects["get_order"]++;
            return orders.TryGetValue(id.Trim().ToUpperInvariant(), out var o)
                ? JsonSerializer.Serialize(o)
                : $"No order named {id}. Known orders: {string.Join(", ", orders.Keys)}.";
        },
        "get_order",
        "Look up one order by its id (e.g. ORD-42). Returns the total, items and customer."),

    AIFunctionFactory.Create(
        (string customer) =>
        {
            sideEffects["customer_tier"]++;
            return customer == "CUS-7" ? "gold" : "standard";
        },
        "customer_tier",
        "Get a customer's loyalty tier. Gold customers may be refunded without extra checks."),

    AIFunctionFactory.Create(
        (string orderId, double amount) =>
        {
            sideEffects["refund_payment"]++;
            return $"Refunded ${amount} for {orderId}.";
        },
        "refund_payment",
        "Refund money to the customer for an order. Irreversible — only call once you know the amount."),
};

var policies = new Dictionary<string, ToolPolicy>
{
    ["get_order"] = new ToolPolicy(),
    // The one irreversible action: pause the graph and ask a human. The model
    // just sees a function that takes a while — or, on a decline, a result
    // telling it the user said no.
    ["refund_payment"] = new ToolPolicy
    {
        Approve = new ApproveSpec
        {
            Title = "Approve this refund?",
            Ui = new Dictionary<string, object?>
            {
                ["component"] = "approval-form",
                ["props"] = new Dictionary<string, object?>(),
            },
            DenyMessage = "The customer's refund was declined by a human reviewer. Explain that politely.",
        },
    },
    // Runs, but the customer never sees us checking their tier.
    ["customer_tier"] = new ToolPolicy { Show = false },
};

const string System = "You are a refund desk agent. Use the tools to answer; never invent order data. " +
    "Look the order up before refunding, and refund the order's full total unless the user says otherwise. " +
    "When you are done, reply to the customer in one or two short sentences.";

const int MaxTurns = 6;

// Lazily built: the SDK reads ANTHROPIC_API_KEY at construction, and we would
// rather say so ourselves than surface its exception.
IChatClient? chat = null;
IChatClient Model() => chat ??= new AnthropicClient()
    .AsIChatClient("claude-opus-4-8", defaultMaxOutputTokens: 2048);

// ── the graph: one node that lets the model drive ─────────────────────────────

var desk = Graph.Create("llm-refund")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("agent", async (State state, IContext ctx) =>
        // The whole model↔tool loop — journaled per turn, tools wrapped for
        // visibility + exactly-once, text streamed live — is Agent.RunAsync. The
        // node just supplies the prompt, the input and the functions.
        Update.Of("reply", await Agent.RunAsync(ctx, Model(), new AgentRunOptions
        {
            System = System,
            Input = state.Get<string>("input") ?? string.Empty,
            Tools = functions,
            Policies = policies,
            MaxTurns = MaxTurns,
        })))
    .Edge(Graph.Start, "agent")
    .Edge("agent", Graph.End)
    .Compile();

// ── the app ───────────────────────────────────────────────────────────────────

var app = new MekikApp(new MekikOptions
{
    Graph = desk,
    Input = f => Update.Of("input", ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"]),
    Reply = s => s.GetValueOrDefault("reply") as string,
    Greeting = _ => $"Refund desk. Ask me anything about your orders ({string.Join(", ", orders.Keys)}) — " +
        "I'll look them up and refund if you want.",
});

return await Run();

// ── one scripted conversation against the real API ────────────────────────────

async Task<int> Run()
{
    if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY")))
    {
        Console.Error.WriteLine("Set ANTHROPIC_API_KEY — this example calls the real Claude API.");
        return 1;
    }

    var c = new Collector();
    await app.ConnectAsync(c);
    c.Drain();

    Console.WriteLine("turn 1 — user: \"I want to refund ORD-42, it arrived broken\"");
    await app.ReceiveAsync(c, Text("I want to refund ORD-42, it arrived broken"));
    var t1 = c.Drain();
    Describe(t1);

    var interrupt = t1.FirstOrDefault(f => f["type"] as string == "interrupt");
    if (interrupt is null)
    {
        // The model may have chosen to ask a clarifying question instead of
        // refunding — a real model is allowed to do that, so this is a soft stop.
        Console.WriteLine("\nThe model did not reach the refund this run; no approval to answer.");
        return 0;
    }

    var interruptId = (string)interrupt["id"]!;
    Console.WriteLine($"\nturn 2 — human approves {interruptId}");
    await app.ReceiveAsync(c, new Dictionary<string, object?>
    {
        ["type"] = "resume",
        ["answers"] = new Dictionary<string, object?>
        {
            [interruptId] = new Dictionary<string, object?> { ["approved"] = true },
        },
    });
    Describe(c.Drain());

    Console.WriteLine($"\nside effects: {string.Join(", ", sideEffects.Select(kv => $"{kv.Key}={kv.Value}"))}");
    if (sideEffects["refund_payment"] != 1)
    {
        Console.Error.WriteLine($"❌ refund_payment ran {sideEffects["refund_payment"]}× — the journal did not hold");
        return 1;
    }

    Console.WriteLine("✅ a real model drove the tools, a human gated the refund, and it charged exactly once");
    return 0;
}

static void Describe(List<IReadOnlyDictionary<string, object?>> frames)
{
    foreach (var f in frames)
    {
        var type = f["type"] as string;
        var data = f.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>;
        if (type == "tool_call" && data is not null)
        {
            var shown = data.GetValueOrDefault("result") ?? data.GetValueOrDefault("params");
            Console.WriteLine($"  tool {data.GetValueOrDefault("name")} {data.GetValueOrDefault("status")} {JsonSerializer.Serialize(shown)}");
        }
        else if (type == "interrupt" && data is not null)
        {
            Console.WriteLine($"  interrupt {f["id"]} {JsonSerializer.Serialize(data.GetValueOrDefault("payload"))}");
        }
        else if (type == "text" && f.GetValueOrDefault("from") as string == "bot" && data is not null)
        {
            Console.WriteLine($"  bot: {data.GetValueOrDefault("text")}");
        }
        else if (type == "error" && data is not null)
        {
            Console.WriteLine($"  error {data.GetValueOrDefault("code")}: {data.GetValueOrDefault("message")}");
        }
    }
}

static Dictionary<string, object?> Text(string text) => new()
{
    ["type"] = "text",
    ["data"] = new Dictionary<string, object?> { ["text"] = text },
};

internal sealed class Collector : IConnection
{
    public string Id => "conn-llm";
    private readonly List<IReadOnlyDictionary<string, object?>> _frames = new();
    public void Send(IReadOnlyDictionary<string, object?> frame) => _frames.Add(frame);
    public void Close(int? code = null, string? reason = null) { }
    public List<IReadOnlyDictionary<string, object?>> Drain()
    {
        var copy = _frames.ToList();
        _frames.Clear();
        return copy;
    }
}
