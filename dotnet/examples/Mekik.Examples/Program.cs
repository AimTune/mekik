// The showcase (mirror of ts/examples/refund.ts): a refund-approval agent served
// over mekik. One ilmek graph exercises every feature — a tool trace, a GenUI
// card, a form-driven human-in-the-loop pause, a second tool, a streamed token,
// and a consolidated reply — driven here in-memory as a console self-test.
//
//   dotnet run --project dotnet/examples/Mekik.Examples   # asserts the wire trace, exit 0/1

using Mekik;
using Ilmek;

// ── the domain ────────────────────────────────────────────────────────────────

var orders = new Dictionary<string, OrderRec>
{
    ["ORD-42"] = new("ORD-42", 249.9, new List<object?> { "Kettle", "Mug" }),
};

// Side-effect counters — asserted to be 1 each, proving the journal memoized them
// across the interrupt (a pure-replay engine would double them).
var sideEffects = new Dictionary<string, int> { ["get_order"] = 0, ["refund_payment"] = 0 };

// ── the graph ─────────────────────────────────────────────────────────────────

var refund = Graph.Create("refund")
    .Channel("input", Channels.LastWrite(""))
    .Channel("order", Channels.LastWrite())
    .Channel("reply", Channels.LastWrite(""))
    .Node("lookup", async (State state, IContext ctx) =>
    {
        var id = state.Get<string>("input").Trim();
        var order = await Shuttle.Tool(ctx, "get_order", new Dictionary<string, object?> { ["id"] = id }, () =>
        {
            sideEffects["get_order"]++;
            if (!orders.TryGetValue(id, out var o)) throw new Exception($"no order {id}");
            return (object?)o;
        });
        var ord = (OrderRec)order!;
        Shuttle.Ui(ctx, "order-card", new Dictionary<string, object?> { ["id"] = ord.Id, ["total"] = ord.Total, ["items"] = ord.Items });
        return Update.Of("order", order);
    })
    .Node("approve", async (State state, IContext ctx) =>
    {
        var ord = state.Get<OrderRec>("order");
        var answer = await Shuttle.Approve<Dictionary<string, object?>>(
            ctx,
            new Dictionary<string, object?> { ["title"] = $"Refund ${ord.Total} for {ord.Id}?" },
            ui: new Dictionary<string, object?> { ["component"] = "approval-form", ["props"] = new Dictionary<string, object?> { ["orderId"] = ord.Id, ["amount"] = ord.Total } },
            actions: new List<object> {
                new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } },
                new Dictionary<string, object?> { ["label"] = "Reject", ["value"] = new Dictionary<string, object?> { ["approved"] = false } },
            });
        var approved = answer.GetValueOrDefault("approved") is true;
        return approved
            ? Command.Goto_("refund")
            : Command.Create(Update.Of("reply", "Refund declined."), Graph.End);
    })
    .Node("refund", async (State state, IContext ctx) =>
    {
        var ord = state.Get<OrderRec>("order");
        await Shuttle.Tool(ctx, "refund_payment", new Dictionary<string, object?> { ["orderId"] = ord.Id }, () =>
        {
            sideEffects["refund_payment"]++;
            return (object?)new Dictionary<string, object?> { ["refunded"] = ord.Total };
        });
        ctx.EmitToken("Refund processed ✅");
        return Update.Of("reply", $"Refund complete: {ord.Id}");
    })
    .Edge(Graph.Start, "lookup")
    .Edge("lookup", "approve")
    .Edge("refund", Graph.End)
    .Compile();

// ── the app ───────────────────────────────────────────────────────────────────

var app = new MekikApp(new MekikOptions
{
    Graph = refund,
    Input = f => Update.Of("input", ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"]),
    Reply = s => s.GetValueOrDefault("reply") as string,
    Context = (conv, _) => new Dictionary<string, object?> { ["userId"] = conv.UserId, ["locale"] = "en" },
    Greeting = _ => $"Hi! Send an order number to start a refund. Available orders: {string.Join(", ", orders.Keys)}.",
});

return await SelfTest();

// ── self-test (in-memory, no socket) ──────────────────────────────────────────

async Task<int> SelfTest()
{
    var c = new Collector();
    await app.ConnectAsync(c);
    var welcome = c.Drain().First(f => f["type"] as string == "welcome");
    Check(((IReadOnlyDictionary<string, object?>)welcome["data"]!)["protocol"] as string == "mekik/1", "welcome announces mekik/1");

    // ── turn 1: the user asks to refund ORD-42 ────────────────────────────────
    await app.ReceiveAsync(c, Text("ORD-42"));
    var t1 = c.Drain();
    Console.WriteLine("turn 1 frames: " + string.Join(" → ", t1.Select(f => f["type"])));

    Check(t1.Any(f => f["type"] as string == "tool_call" && Data(f, "name") == "get_order" && Data(f, "status") == "running"), "get_order running");
    Check(t1.Any(f => f["type"] as string == "tool_call" && Data(f, "name") == "get_order" && Data(f, "status") == "completed"), "get_order completed");
    Check(t1.Any(f => f["type"] as string == "genui" && Chunk(f, "component") == "order-card"), "order-card GenUI chunk");

    var interrupt = t1.First(f => f["type"] as string == "interrupt");
    var idata = (IReadOnlyDictionary<string, object?>)interrupt["data"]!;
    var ui = (IReadOnlyDictionary<string, object?>?)idata.GetValueOrDefault("ui");
    Check(ui?.GetValueOrDefault("component") as string == "approval-form", "interrupt mounts approval-form");
    Check(t1.Any(f => f["type"] as string == "run" && Data(f, "status") == "interrupted"), "run ends interrupted");
    var interruptId = (string)interrupt["id"]!;

    // A new turn while parked is refused.
    await app.ReceiveAsync(c, Text("hello?"));
    Check(c.Drain().Any(f => f["type"] as string == "error" && Data(f, "code") == "interrupted"), "new turn while parked refused");

    // ── turn 2: the human approves ────────────────────────────────────────────
    await app.ReceiveAsync(c, new Dictionary<string, object?>
    {
        ["type"] = "resume",
        ["answers"] = new Dictionary<string, object?> { [interruptId] = new Dictionary<string, object?> { ["approved"] = true } },
    });
    var t2 = c.Drain();
    Console.WriteLine("turn 2 frames: " + string.Join(" → ", t2.Select(f => f["type"])));

    Check(t2.Any(f => f["type"] as string == "interrupt_resolved" && (string)f["id"]! == interruptId), "interrupt_resolved for the answered id");
    Check(t2.Any(f => f["type"] as string == "tool_call" && Data(f, "name") == "refund_payment"), "refund_payment tool trace");
    Check(t2.Any(f => f["type"] as string == "genui" && Chunk(f, "type") == "text"), "streamed token chunk");
    Check(t2.Any(f => f["type"] as string == "text" && f["from"] as string == "bot" && Data(f, "text") == "Refund complete: ORD-42"), "consolidated reply");
    Check(t2.Any(f => f["type"] as string == "run" && Data(f, "status") == "finished"), "run finishes");

    Console.WriteLine($"side effects: get_order={sideEffects["get_order"]}, refund_payment={sideEffects["refund_payment"]}");
    Check(sideEffects["get_order"] == 1, "get_order ran once");
    Check(sideEffects["refund_payment"] == 1, "refund_payment ran once");

    Console.WriteLine("\n✅ refund self-test passed — genui, tool traces, form approval, resume, and exactly-once all verified");
    return 0;
}

static Dictionary<string, object?> Text(string text) => new()
{
    ["type"] = "text",
    ["data"] = new Dictionary<string, object?> { ["text"] = text },
};

static string? Data(IReadOnlyDictionary<string, object?> frame, string key) =>
    ((IReadOnlyDictionary<string, object?>)frame["data"]!).GetValueOrDefault(key) as string;

static string? Chunk(IReadOnlyDictionary<string, object?> frame, string key) =>
    ((IReadOnlyDictionary<string, object?>)frame["chunk"]!).GetValueOrDefault(key) as string;

static void Check(bool cond, string msg)
{
    if (!cond) throw new Exception($"assertion failed: {msg}");
}

internal sealed record OrderRec(string Id, double Total, List<object?> Items);

internal sealed class Collector : IConnection
{
    public string Id => "conn-selftest";
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
