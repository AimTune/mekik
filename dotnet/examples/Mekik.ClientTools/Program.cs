// Client tools (PROTOCOL.md §11), mirror of ts/examples/client-tools.ts: the
// frontend's own UI as part of the toolbox. A delivery-scheduling desk where
// the *client* declares what it can do — open its date picker, fire its
// confetti — and the graph calls those declarations like any server tool:
//
//   pick_date  (mode "call",   tags ["scheduling"])  → parks the run; the client's
//                                                      handler answers via resume
//   celebrate  (mode "notify", untagged)             → fire-and-forget event chunk
//   share_location (tags ["geo"])                    → declared, but tag-scoped OUT
//   not_on_the_menu                                  → dropped by the allowlist
//
//   dotnet run --project dotnet/examples/Mekik.ClientTools   # self-test, exit 0/1
//
// The self-test plays the chativa connector's part — declaring tools in
// `hello.tools`, answering the tool interrupt with the {ok, result} envelope —
// and asserts the exact wire trace, including tag scoping, the allowlist, the
// notify chunk, the error envelope, and exactly-once across the pause.

using Mekik;
using Ilmek;

// ── the domain ────────────────────────────────────────────────────────────────

var orders = new Dictionary<string, DeliveryOrder>
{
    ["ORD-42"] = new("ORD-42", "2026-08-10"),
};

// Side-effect counter — asserted to be 1, proving the journal memoized the
// lookup across the client-tool pause.
var sideEffects = new Dictionary<string, int> { ["get_order"] = 0 };

// What the scheduling node actually saw in its toolbox — captured so the
// self-test can assert the tag rule and the allowlist from the outside.
var visibleTools = new List<string>();

// ── the graph ─────────────────────────────────────────────────────────────────

var delivery = Graph.Create("delivery")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("schedule", async (State state, IContext ctx) =>
    {
        var id = state.Get<string>("input").Trim();

        // A journaled server-side effect BEFORE the client-tool pause: on the
        // resume pass this returns the recorded order without re-running.
        var order = (DeliveryOrder)(await Shuttle.Tool(ctx, "get_order",
            new Dictionary<string, object?> { ["id"] = id }, () =>
            {
                sideEffects["get_order"]++;
                if (!orders.TryGetValue(id, out var o)) throw new Exception($"no order {id}");
                return (object?)o;
            }))!;

        // This node's toolbox: client tools tagged "scheduling" — plus untagged
        // ones, which are unrestricted (§11.2). "share_location" is tagged
        // ["geo"], so a different node could use it while this one never sees
        // it; "not_on_the_menu" was dropped by the server's allowlist below.
        visibleTools.Clear();
        visibleTools.AddRange(Shuttle.ClientTools(ctx, tags: ["scheduling"]).Select(t => t.Name));

        // The round-trip: parks the run on an interrupt carrying data.tool; the
        // client's handler answers {ok:true, result} through a resume, and the
        // whole wait survives a reconnect or restart like any mekik pause.
        var when = await Shuttle.CallClientToolAsync<IReadOnlyDictionary<string, object?>>(
            ctx, "pick_date", new Dictionary<string, object?> { ["min"] = order.Earliest });

        // Fire-and-forget: streams a `client_tool` event chunk, never parks.
        await Shuttle.CallClientToolAsync<object?>(ctx, "celebrate",
            new Dictionary<string, object?> { ["level"] = 2L });

        return Update.Of("reply", $"Delivery booked for {when!["date"]}.");
    })
    .Edge(Graph.Start, "schedule")
    .Edge("schedule", Graph.End)
    .Compile();

// ── the app ───────────────────────────────────────────────────────────────────

MekikApp MakeApp() => new(new MekikOptions
{
    Graph = delivery,
    Checkpointer = new InMemoryCheckpointer(),
    Input = f => Update.Of("input", ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"]),
    Reply = s => s.GetValueOrDefault("reply") as string,
    // The opt-in, in its allowlist form (§11.1): declarations are ignored
    // entirely without this option, and the delegate pins what survives — a
    // manipulated client cannot smuggle extra tools to a model.
    ClientTools = (tools, _) => tools
        .Where(t => t.Name is "pick_date" or "celebrate" or "share_location")
        .ToList(),
    Greeting = _ => "Hi! Send an order number and I'll schedule its delivery with your date picker.",
});

// What chativa's connector would declare in `hello.tools` (definitions only —
// the handlers stay in the page; the self-test plays the handler's part).
List<object?> Declared() =>
[
    new Dictionary<string, object?>
    {
        ["name"] = "pick_date",
        ["description"] = "Open the in-app date picker and let the user choose a delivery date.",
        ["parameters"] = new Dictionary<string, object?>
        {
            ["type"] = "object",
            ["properties"] = new Dictionary<string, object?>
            {
                ["min"] = new Dictionary<string, object?> { ["type"] = "string", ["description"] = "Earliest selectable ISO date" },
            },
            ["required"] = new List<object?> { "min" },
        },
        ["tags"] = new List<object?> { "scheduling" },
    },
    new Dictionary<string, object?> { ["name"] = "celebrate", ["description"] = "Fire the confetti cannon.", ["mode"] = "notify" },
    new Dictionary<string, object?> { ["name"] = "share_location", ["description"] = "Read the device location.", ["tags"] = new List<object?> { "geo" } },
    new Dictionary<string, object?> { ["name"] = "not_on_the_menu", ["description"] = "Declared by the client, refused by the server." },
];

return await SelfTest();

// ── self-test (in-memory, no socket) ──────────────────────────────────────────

async Task<int> SelfTest()
{
    var app = MakeApp();
    var c = new Collector("conn-selftest");
    await app.ConnectAsync(c, new ConnectParams { Hello = new HelloInfo { Tools = Declared() } });
    c.Drain();

    // ── turn 1: the graph reaches for the client's date picker ────────────────
    await app.ReceiveAsync(c, Text("ORD-42"));
    var t1 = c.Drain();
    Console.WriteLine("turn 1 frames: " + string.Join(" → ", t1.Select(f => f["type"])));

    // The tag rule + the allowlist, observed from inside the node.
    Check(string.Join("|", visibleTools) == "pick_date|celebrate",
        $"toolbox is scoped (saw {string.Join("|", visibleTools)})");

    Check(t1.Any(f => f["type"] as string == "tool_call" && Data(f, "name") == "pick_date" && Data(f, "status") == "running"),
        "pick_date surfaces as a running tool_call trace");

    var interrupt = t1.First(f => f["type"] as string == "interrupt");
    var idata = (IReadOnlyDictionary<string, object?>)interrupt["data"]!;
    var tool = (IReadOnlyDictionary<string, object?>?)idata.GetValueOrDefault("tool");
    Check(tool?.GetValueOrDefault("name") as string == "pick_date", "interrupt.data.tool names the tool");
    var toolParams = (IReadOnlyDictionary<string, object?>?)tool?.GetValueOrDefault("params");
    Check(toolParams?.GetValueOrDefault("min") as string == "2026-08-10",
        "params reach the client (min from the journaled lookup)");
    Check(!idata.ContainsKey("actions"), "no chips: the handler answers, not a human");
    Check(t1.Any(f => f["type"] as string == "run" && Data(f, "status") == "interrupted"), "run ends interrupted");
    var interruptId = (string)interrupt["id"]!;

    // ── turn 2: the client's handler answers with the result envelope ─────────
    await app.ReceiveAsync(c, Resume(interruptId, new Dictionary<string, object?>
    {
        ["ok"] = true,
        ["result"] = new Dictionary<string, object?> { ["date"] = "2026-08-15" },
    }));
    var t2 = c.Drain();
    Console.WriteLine("turn 2 frames: " + string.Join(" → ", t2.Select(f => f["type"])));

    Check(t2.Any(f => f["type"] as string == "interrupt_resolved" && (string)f["id"]! == interruptId),
        "interrupt_resolved for the answered id");
    var completed = t2.First(f => f["type"] as string == "tool_call" && Data(f, "name") == "pick_date" && Data(f, "status") == "completed");
    var result = (IReadOnlyDictionary<string, object?>)((IReadOnlyDictionary<string, object?>)completed["data"]!)["result"]!;
    Check(result.GetValueOrDefault("date") as string == "2026-08-15", "the completed trace carries the handler's result");

    // The notify tool: an event chunk under the reserved name, no second pause.
    var notify = t2.FirstOrDefault(f =>
        f["type"] as string == "genui" &&
        f["chunk"] is IReadOnlyDictionary<string, object?> ch &&
        ch.GetValueOrDefault("name") as string == Protocol.ClientToolEvent);
    Check(notify is not null, "celebrate streams a client_tool event chunk");
    var payload = (IReadOnlyDictionary<string, object?>)((IReadOnlyDictionary<string, object?>)notify!["chunk"]!)["payload"]!;
    Check(payload.GetValueOrDefault("name") as string == "celebrate", "the chunk payload names the tool");
    Check(((IReadOnlyDictionary<string, object?>)payload["params"]!).GetValueOrDefault("level") is 2L,
        "…and carries the params");
    Check(!t2.Any(f => f["type"] as string == "interrupt"), "notify never parks");

    Check(t2.Any(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot" &&
                      Data(f, "text") == "Delivery booked for 2026-08-15."),
        "the reply uses the client's answer");
    Check(t2.Any(f => f["type"] as string == "run" && Data(f, "status") == "finished"), "run finishes");

    Console.WriteLine($"side effects: get_order={sideEffects["get_order"]}");
    Check(sideEffects["get_order"] == 1, $"get_order ran once across the pause (was {sideEffects["get_order"]})");

    // ── the error envelope, in a fresh conversation ───────────────────────────
    var app2 = MakeApp();
    var c2 = new Collector("conn-selftest-2");
    await app2.ConnectAsync(c2, new ConnectParams { Hello = new HelloInfo { Tools = Declared() } });
    await app2.ReceiveAsync(c2, Text("ORD-42"));
    var parked = c2.Drain().First(f => f["type"] as string == "interrupt");
    await app2.ReceiveAsync(c2, Resume((string)parked["id"]!, new Dictionary<string, object?>
    {
        ["ok"] = false,
        ["error"] = "picker dismissed",
    }));
    var t3 = c2.Drain();
    Console.WriteLine("error-path frames: " + string.Join(" → ", t3.Select(f => f["type"])));
    Check(t3.Any(f => f["type"] as string == "tool_call" && Data(f, "status") == "error" && Data(f, "error") == "picker dismissed"),
        "an {ok:false} answer surfaces as an error trace");
    Check(t3.Any(f => f["type"] as string == "run" && Data(f, "status") == "error"),
        "…and the unhandled throw ends the run in error");

    Console.WriteLine("\n✅ client-tools self-test passed — declaration, allowlist, tag scoping, the durable round-trip, the notify chunk, the error envelope, and exactly-once all verified");
    return 0;
}

static Dictionary<string, object?> Text(string text) => new()
{
    ["type"] = "text",
    ["data"] = new Dictionary<string, object?> { ["text"] = text },
};

static Dictionary<string, object?> Resume(string id, object? answer) => new()
{
    ["type"] = "resume",
    ["answers"] = new Dictionary<string, object?> { [id] = answer },
};

static string? Data(IReadOnlyDictionary<string, object?> frame, string key) =>
    ((IReadOnlyDictionary<string, object?>)frame["data"]!).GetValueOrDefault(key) as string;

static void Check(bool cond, string msg)
{
    if (!cond) throw new Exception($"assertion failed: {msg}");
}

internal sealed record DeliveryOrder(string Id, string Earliest);

internal sealed class Collector(string id) : IConnection
{
    public string Id => id;
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
