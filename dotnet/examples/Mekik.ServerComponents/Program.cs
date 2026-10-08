// server-components — the backend owns the widget (PROTOCOL.md §10).
// Mirror of ts/examples/server-components.ts.
//
// Every other example emits `ui` chunks naming components the *client* already
// registered. This one defines the components on the server: markup, styles and
// prop defaults travel once in a `genui_components` frame, chativa registers each
// one as a custom element, and from then on a plain `ui` chunk mounts it. Adding
// a widget is a server deploy — no client build, no chativa release.
//
//   dotnet run --project dotnet/examples/Mekik.ServerComponents --no-launch-profile # self-test, exit 0/1
//   dotnet run --project dotnet/examples/Mekik.ServerComponents -- --serve          # ws://localhost:8816/ws
//
// A plain `dotnet run` (no flags) uses Properties/launchSettings.json, whose profile
// passes --serve: it starts the server. Pass --no-launch-profile for the self-test.
//
// The turn is paced on purpose: the card is re-rendered through Preparing → In
// transit at the same chunk id, then the run PAUSES on three chips, and the answer
// re-renders that same card again. An in-place update you can actually watch, and
// an approval that edits a widget already on screen.
//
// Then it pauses a second time, on the card itself. The two attributes are the whole
// routing story (PROTOCOL.md §10.4):
//
//   component-event="rate_delivery"  → the node parked on Shuttle.OnEvent, and only it
//   mekik-event="track_order"        → the app's OnGenUiEvent, which may start a turn
//
// What to watch on the wire:
//   1. connect      → welcome, then genui_components{hash, components:[…]}
//   2. reconnect    → genui_components{hash, unchanged:true} — no markup
//   3. a stale hash → the full catalog again
//   4. the turn     → 4 ui chunks under 2 ids, then an interrupt with the chips
//   5. the resume   → 2 more ui chunks at those same ids; nothing before the pause
//                     is re-emitted, because each phase ran inside ctx.StepAsync
//   6. a 2nd pause  → carrying `event: "rate_delivery"` and no chips: the card's own
//                     Rate button (component-event) answers it, not the chat
//   7. the Track button (mekik-event) → a new turn once the run is idle

using Mekik;
using Ilmek;
using Frame = System.Collections.Generic.IReadOnlyDictionary<string, object?>;

var components = new List<object> { new DeliveryCard(), new ShipmentStrip() };

// ── pacing ────────────────────────────────────────────────────────────────────

// An in-place update is invisible if it lands in the same millisecond as the
// mount — the element simply appears in its final state. Pacing the run is what
// makes the mechanism watchable. The self-test runs at 0 so it stays instant.
var stepMs = args.Contains("--serve") ? 1800 : 0;

// Explicit, replay-stable chunk ids — the two elements this turn keeps editing.
const string Card = "delivery-card-1";
const string Strip = "shipment-strip-1";

/// <summary>
/// One journaled phase: wait, then emit.
///
/// <para><c>ctx.StepAsync(name, fn)</c> runs its body once and records the result; on
/// the replay pass after a resume the recorded value comes back and the body is
/// <b>not</b> called. Emitting a chunk is a side effect like any other, so the
/// emissions go <i>inside</i> the step — otherwise answering the chips would replay
/// the whole pre-pause sequence and the user would watch the widget flash back
/// through states they already saw.</para>
/// </summary>
async ValueTask Phase(IContext ctx, string name, Action emit) =>
    await ctx.StepAsync(name, async () =>
    {
        if (stepMs > 0) await Task.Delay(stepMs);
        emit();
        return true;
    });

// ── the graph ─────────────────────────────────────────────────────────────────

var orders = new Dictionary<string, (string Title, double Total, List<object?> Lines)>
{
    ["ORD-42"] = ("Order ORD-42", 249.9,
    [
        new Dictionary<string, object?> { ["label"] = "Kettle", ["price"] = 199.9 },
        new Dictionary<string, object?> { ["label"] = "Mug", ["price"] = 50.0 },
    ]),
};

var tracker = Graph.Create("tracker")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("track", async (State state, IContext ctx) =>
    {
        var id = (System.Text.RegularExpressions.Regex.Match(state.Get<string>("input"), "ORD-\\d+",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Value).ToUpperInvariant();

        if (!orders.TryGetValue(id, out var order))
            return Update.Of("reply", "Try \"track ORD-42\".");

        // The card's props, with only the fields that move as parameters.
        Dictionary<string, object?> CardProps(string status, string note, bool rateable = false) => new()
        {
            ["id"] = id,
            ["title"] = order.Title,
            ["status"] = status,
            ["total"] = order.Total,
            ["note"] = note,
            ["rateable"] = rateable,
            ["lines"] = order.Lines,
        };

        // Each phase is one journaled beat: pause for effect, then re-render the
        // element at the same chunk id. Watch the card's badge change while the
        // bubble stays put.
        await Phase(ctx, "packing", () =>
            Shuttle.Ui(ctx, "delivery-card", CardProps("Preparing", "Packing your items."), Card));
        await Phase(ctx, "in_transit", () =>
            Shuttle.Ui(ctx, "delivery-card", CardProps("In transit", "Left the warehouse."), Card));
        await Phase(ctx, "picked_up", () =>
            Shuttle.Ui(ctx, "shipment-strip",
                new Dictionary<string, object?> { ["step"] = "Picked up", ["eta"] = "today, 18:00" }, Strip));
        await Phase(ctx, "out_for_delivery", () =>
            Shuttle.Ui(ctx, "shipment-strip",
                new Dictionary<string, object?> { ["step"] = "Out for delivery", ["eta"] = "today, 16:30" }, Strip));

        // The run parks here and the chips render in the chat. Everything above
        // stays on screen — a mounted component outlives the pause, and nothing
        // above re-runs when the answer arrives (the journal saw it already).
        var choice = await Shuttle.Choose<string>(ctx, $"{id} is at your door. What should the courier do?",
        [
            Shuttle.Action("Hand it to me", "handover"),
            Shuttle.Action("Leave at the door", "leave"),
            Shuttle.Action("Reschedule", "reschedule"),
        ]);

        // The answer drives the SAME two elements — this is the point of the
        // example: an approval that edits a component already on screen.
        var (status, note, step, eta) = choice switch
        {
            "handover" => ("Delivered", "Signed for at the door.", "Delivered", "just now"),
            "leave" => ("Delivered", "Left at the door as requested.", "Delivered", "just now"),
            _ => ("Rescheduled", "We'll try again tomorrow.", "Rescheduled", "tomorrow, 10:00"),
        };

        // Journaled like every other beat, because the run pauses again below: on the
        // rating's replay pass these must not re-emit.
        await Phase(ctx, "settled", () =>
        {
            Shuttle.Ui(ctx, "delivery-card", CardProps(status, note, rateable: true), Card);
            Shuttle.Ui(ctx, "shipment-strip",
                new Dictionary<string, object?> { ["step"] = step, ["eta"] = eta }, Strip);
        });

        // The second pause, and the point of `component-event`: no chips in the chat
        // this time — the run waits for a button on the card that is already on screen.
        // The interrupt frame carries `event: "rate_delivery"` so the client knows to
        // wait for the widget rather than offer Approve/Cancel.
        var rating = await Shuttle.OnEvent<IReadOnlyDictionary<string, object?>>(ctx, "rate_delivery");
        var stars = rating.GetValueOrDefault("stars");

        Shuttle.Ui(ctx, "delivery-card", CardProps(status, $"Thanks — you rated this {stars}/5."), Card);

        return Update.Of("reply", $"{id}: {status.ToLowerInvariant()}.");
    })
    .Edge(Graph.Start, "track")
    .Edge("track", Graph.End)
    .Compile();

MekikApp MakeApp() => new(new MekikOptions
{
    Graph = tracker,
    Reply = s => s.GetValueOrDefault("reply") as string,
    // The whole feature: hand the definitions to the app and every connecting
    // client gets them.
    Components = components,
    // …and the other half of it. The card's `data-event="track_order"` button
    // arrives here; returning an input update runs a turn on it, returning null
    // ignores it. Leave this out and the button is decorative — the frame reaches
    // the server and stops there.
    OnGenUiEvent = ev => ev switch
    {
        { EventType: "track_order", Payload: IReadOnlyDictionary<string, object?> p }
            when p.GetValueOrDefault("id") is string orderId =>
                new Dictionary<string, object?> { ["input"] = $"track {orderId}" },
        _ => null,
    },
});

// ── serve ─────────────────────────────────────────────────────────────────────

if (args.Contains("--serve"))
{
    var builder = Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(args);
    builder.WebHost.UseUrls("http://localhost:8816");
    var web = builder.Build();
    web.UseWebSockets();
    web.MapMekik("/ws", MakeApp());
    Console.WriteLine(
        "server-components listening on ws://localhost:8816/ws — connect chativa and say \"track ORD-42\".\n" +
        "The widgets are defined here, not in the page: edit a template above, restart, and the client picks up\n" +
        "the new markup on its next connect (the hash changed).");
    web.Run();
    return 0;
}

// ── self-test ─────────────────────────────────────────────────────────────────

var failures = 0;
void Check(bool ok, string label)
{
    Console.WriteLine($"  {(ok ? "✓" : "✗")} {label}");
    if (!ok) failures++;
}

Frame? Catalog(IReadOnlyList<Frame> frames) => frames.FirstOrDefault(f => (string?)f.GetValueOrDefault("type") == "genui_components");

var app = MakeApp();

// ── 1. first connect: the catalog travels once ───────────────────────────────
var c1 = new Collector();
await app.ConnectAsync(c1);
var opening = c1.Drain();

Console.WriteLine("connect frames: " + string.Join(" → ", opening.Select(f => f.GetValueOrDefault("type"))));
var catalog = Catalog(opening);
var definitions = catalog?.GetValueOrDefault("components") as IReadOnlyList<object?>;
var hash = catalog?.GetValueOrDefault("hash") as string ?? "";

Check((string?)opening[0].GetValueOrDefault("type") == "welcome", "welcome comes first");
Check(catalog is not null, "…immediately followed by the component catalog");
Check(definitions?.Count == 2, "both server-defined components are in it");
Check(System.Text.RegularExpressions.Regex.IsMatch(hash, "^[0-9a-f]{64}$"), "the catalog carries a sha256 hash");
Check(
    string.Join(",", definitions!.Cast<IReadOnlyDictionary<string, object?>>().Select(d => d["name"])) == "delivery-card,shipment-strip",
    "definitions are sorted by name (a stable hash needs a stable order)");
Check(
    (definitions?[0] as IReadOnlyDictionary<string, object?>)?.GetValueOrDefault("template") is string t &&
        t.Contains("{{#each lines}}"),
    "the markup itself is what travels — the client compiles nothing");

// The hash covers the definitions byte-for-byte, whitespace included — this example
// and its TypeScript twin therefore print different hashes purely because their source
// formatting differs. For identical definitions the two servers mint the identical
// hash; that contract is pinned by the unit tests on both sides.
Console.WriteLine($"catalog hash: {hash}");

var welcome = (IReadOnlyDictionary<string, object?>)opening[0]["data"]!;
var conversationId = (string)welcome["conversationId"]!;
var userId = (string)welcome["userId"]!;

// ── 2. reconnect with the cached hash: no markup ─────────────────────────────
var c2 = new Collector();
await app.ConnectAsync(c2, new ConnectParams
{
    Hello = new HelloInfo { ConversationId = conversationId, UserId = userId, ComponentsHash = hash },
});
var cached = Catalog(c2.Drain());

Check(cached?.GetValueOrDefault("unchanged") is true, "a client that already has this catalog is told `unchanged`");
Check(cached?.ContainsKey("components") == false, "…and no markup is re-sent");

// ── 3. a stale hash gets the catalog back ────────────────────────────────────
var c3 = new Collector();
await app.ConnectAsync(c3, new ConnectParams
{
    Hello = new HelloInfo { ConversationId = conversationId, UserId = userId, ComponentsHash = "hash-from-last-deploy" },
});
var refreshed = Catalog(c3.Drain());

Check(refreshed?.ContainsKey("unchanged") == false, "a stale hash is not treated as a cache hit");
Check((refreshed?.GetValueOrDefault("components") as IReadOnlyList<object?>)?.Count == 2, "…the full catalog is re-sent");

// ── 4. the turn mounts the components by name ────────────────────────────────
await app.ReceiveAsync(c1, new Dictionary<string, object?>
{
    ["type"] = "text",
    ["data"] = new Dictionary<string, object?> { ["text"] = "track ORD-42" },
});
var turn = c1.Drain();
var uiChunks = turn
    .Where(f => (string?)f.GetValueOrDefault("type") == "genui")
    .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
    .Where(c => (string?)c.GetValueOrDefault("type") == "ui")
    .ToList();

Console.WriteLine("turn frames: " + string.Join(" → ", turn.Select(f => f.GetValueOrDefault("type"))));
Check((string?)uiChunks[0].GetValueOrDefault("component") == "delivery-card", "the turn mounts the server-defined card by name");
Check(
    ((IReadOnlyDictionary<string, object?>)uiChunks[0]["props"]!)["lines"] is IReadOnlyList<object?> { Count: 2 },
    "…with props only — the markup already lives on the client");

var cardChunks = uiChunks.Where(c => (string?)c.GetValueOrDefault("component") == "delivery-card").ToList();
Check(cardChunks.Count == 2, "the card is emitted twice before the pause (Preparing → In transit)");
Check(
    cardChunks[0].GetValueOrDefault("id") is not null &&
    Equals(cardChunks[0].GetValueOrDefault("id"), cardChunks[1].GetValueOrDefault("id")),
    "…under one chunk id, so the client updates it in place instead of stacking cards");

var stripChunks = uiChunks.Where(c => (string?)c.GetValueOrDefault("component") == "shipment-strip").ToList();
Check(stripChunks.Count == 2, "the strip is emitted twice");
Check(
    stripChunks[0].GetValueOrDefault("id") is not null &&
    Equals(stripChunks[0].GetValueOrDefault("id"), stripChunks[1].GetValueOrDefault("id")),
    "…also under one chunk id");

// ── 5. the pause: chips render in the chat, the widgets stay on screen ───────
var interrupt = turn.FirstOrDefault(f => (string?)f.GetValueOrDefault("type") == "interrupt");
var actions = (interrupt?.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>)
    ?.GetValueOrDefault("actions") as IReadOnlyList<object?>;

Check(interrupt is not null, "the run parks on an interrupt — the courier question");
Check(actions?.Count == 3, "…whose chips are the three options");
Check(
    actions?.Cast<IReadOnlyDictionary<string, object?>>().Select(a => (string?)a["value"]).SequenceEqual(
        ["handover", "leave", "reschedule"]) == true,
    "…carrying the values the graph switches on");

// ── 6. answering the chips edits the components already on screen ────────────
await app.ReceiveAsync(c1, new Dictionary<string, object?>
{
    ["type"] = "resume",
    ["answers"] = new Dictionary<string, object?> { [(string)interrupt!["id"]!] = "reschedule" },
});
var after = c1.Drain();
var afterUi = after
    .Where(f => (string?)f.GetValueOrDefault("type") == "genui")
    .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
    .Where(c => (string?)c.GetValueOrDefault("type") == "ui")
    .ToList();
var finalCard = afterUi.FirstOrDefault(c => (string?)c.GetValueOrDefault("component") == "delivery-card");
var finalStrip = afterUi.FirstOrDefault(c => (string?)c.GetValueOrDefault("component") == "shipment-strip");

Console.WriteLine("resume frames: " + string.Join(" → ", after.Select(f => f.GetValueOrDefault("type"))));
var finalCardProps = finalCard?.GetValueOrDefault("props") as IReadOnlyDictionary<string, object?>;
var finalStripProps = finalStrip?.GetValueOrDefault("props") as IReadOnlyDictionary<string, object?>;

Check(
    (string?)finalCardProps?.GetValueOrDefault("status") == "Rescheduled",
    "the answer re-renders the card with a new status");
Check(
    Equals(finalCard?.GetValueOrDefault("id"), cardChunks[0].GetValueOrDefault("id")),
    "…at the SAME chunk id — the card on screen changes, none is added");
Check(
    (string?)finalStripProps?.GetValueOrDefault("step") == "Rescheduled",
    "the strip follows the same answer");
Check(
    Equals(finalStrip?.GetValueOrDefault("id"), stripChunks[0].GetValueOrDefault("id")),
    "…also in place");
Check(
    afterUi.Count(c => (string?)c.GetValueOrDefault("component") == "delivery-card") == 1,
    "the replay after the resume does not re-emit the pre-pause states (StepAsync journaled them)");

// ── 7. the second pause waits for the card's own button, not for chips ───────
var streamId0 = (string)turn.First(f => (string?)f.GetValueOrDefault("type") == "genui")["streamId"]!;
var rating = after.FirstOrDefault(f => (string?)f.GetValueOrDefault("type") == "interrupt");
var ratingData = rating?.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>;

Check((string?)ratingData?.GetValueOrDefault("event") == "rate_delivery",
    "the run parks again, announcing the component-event it waits for");
Check(ratingData?.ContainsKey("actions") != true,
    "…and offers no chips — a widget already on screen answers this one");
Check((bool?)(finalCardProps?.GetValueOrDefault("rateable")) == true,
    "…which is why the card was re-rendered with its Rate button showing");

// `component-event="rate_delivery"` — the pause the node is holding is the binding,
// so nothing has to name an interrupt id.
await app.ReceiveAsync(c1, new Dictionary<string, object?>
{
    ["type"] = "genui_event",
    ["streamId"] = streamId0,
    ["eventType"] = "rate_delivery",
    ["scope"] = "component",
    ["payload"] = new Dictionary<string, object?> { ["stars"] = 5 },
});
var rated = c1.Drain();
Console.WriteLine("rating frames: " + string.Join(" → ", rated.Select(f => f.GetValueOrDefault("type"))));

var ratedCard = rated
    .Where(f => (string?)f.GetValueOrDefault("type") == "genui")
    .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
    .FirstOrDefault(c => (string?)c.GetValueOrDefault("component") == "delivery-card");

Check(
    ((ratedCard?.GetValueOrDefault("props") as IReadOnlyDictionary<string, object?>)
        ?.GetValueOrDefault("note") as string)?.Contains("5/5") == true,
    "the button resolves the pause and its payload comes back as the node's value");
Check(
    rated.Any(f => (string?)f.GetValueOrDefault("type") == "run" &&
        (string?)((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("status") == "finished"),
    "…and the run finishes");

// ── 8. the card's own button drives a turn ───────────────────────────────────
// The run above finished, so the graph is idle and the click is free to start a
// new turn. `OnGenUiEvent` maps it to `{ input = "track ORD-42" }` — the same
// update a typed message would produce.
await app.ReceiveAsync(c1, new Dictionary<string, object?>
{
    ["type"] = "genui_event",
    ["streamId"] = streamId0,
    ["eventType"] = "track_order",
    ["scope"] = "graph",
    ["payload"] = new Dictionary<string, object?> { ["id"] = "ORD-42" },
});
var clicked = c1.Drain();
Console.WriteLine("click frames: " + string.Join(" → ", clicked.Select(f => f.GetValueOrDefault("type"))));

Check(
    clicked.Any(f => (string?)f.GetValueOrDefault("type") == "genui"),
    "the card's mekik-event button drives a turn — the graph re-mounts the card");
Check(
    clicked.All(f => (string?)f.GetValueOrDefault("type") != "text"),
    "…without writing a message the user never typed");

// An event with no mapping is inert: `OnGenUiEvent` returns null and no turn starts.
await app.ReceiveAsync(c1, new Dictionary<string, object?>
{
    ["type"] = "genui_event",
    ["streamId"] = streamId0,
    ["eventType"] = "hovered",
    ["scope"] = "graph",
    ["payload"] = new Dictionary<string, object?> { ["id"] = "ORD-42" },
});
Check(c1.Drain().Count == 0, "an event the handler maps to null costs nothing — no turn, no frames");

// ── 9. a server with no components sends no catalog ──────────────────────────
var bare = new MekikApp(new MekikOptions { Graph = tracker, Reply = s => s.GetValueOrDefault("reply") as string });
var c4 = new Collector();
await bare.ConnectAsync(c4);
Check(Catalog(c4.Drain()) is null, "a server that defines no components sends no catalog frame");

if (failures > 0)
{
    Console.Error.WriteLine($"\n❌ {failures} check(s) failed");
    return 1;
}
Console.WriteLine("\n✅ server-components self-test passed — catalog sent once, cached by hash, mounted by name");
return 0;

// ── the components ────────────────────────────────────────────────────────────
// Authored as classes: the .NET mirror of TypeScript's `defineComponent`.

/// <summary>The order card. `{{#each}}` renders the lines, `{{#if}}` hides an empty note,
/// and the button's `data-event` is what travels back as a `genui_event`.</summary>
sealed class DeliveryCard : GenUiComponent
{
    public override string Name => "delivery-card";

    public override string Template => """
        <div class="card">
            <header><h3>{{title}}</h3><span class="badge">{{status}}</span></header>
            <ul>
                {{#each lines}}<li><span>{{this.label}}</span><b>{{this.price}} ₺</b></li>{{/each}}
            </ul>
            {{#if note}}<p class="note">{{note}}</p>{{/if}}
            <footer>
                <strong>{{total}} ₺</strong>
                <button mekik-event="track_order" data-payload='{"id":"{{id}}"}'>Track</button>
                {{#if rateable}}<button component-event="rate_delivery" data-payload='{"stars":5}'>Rate</button>{{/if}}
            </footer>
        </div>
        """;

    public override string? Css => """
        .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; font-family: inherit; max-width: 340px; }
        header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        h3 { margin: 0; font-size: 0.95rem; }
        .badge { font-size: 0.72rem; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: 2px 8px; }
        ul { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 4px; }
        li { display: flex; justify-content: space-between; font-size: 0.85rem; }
        .note { margin: 0 0 8px; font-size: 0.78rem; color: #64748b; }
        footer { display: flex; align-items: center; justify-content: space-between; }
        button { border: 0; border-radius: 8px; padding: 7px 14px; background: #4f46e5; color: #fff; cursor: pointer; }
        """;

    public override IReadOnlyDictionary<string, object?>? Props => new Dictionary<string, object?>
    {
        ["id"] = "",
        ["title"] = "",
        ["status"] = "",
        ["total"] = 0,
        ["note"] = "",
        ["rateable"] = false,
        ["lines"] = new List<object?>(),
    };
}

/// <summary>A one-line status strip — re-emitted under the same chunk id to update in place.</summary>
sealed class ShipmentStrip : GenUiComponent
{
    public override string Name => "shipment-strip";
    public override string Template => """<div class="strip"><span class="dot"></span>{{step}} · <b>{{eta}}</b></div>""";
    public override string? Css => """
        .strip { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: #0f172a; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
        """;
    public override IReadOnlyDictionary<string, object?>? Props =>
        new Dictionary<string, object?> { ["step"] = "", ["eta"] = "" };
}

// ── test double ───────────────────────────────────────────────────────────────

sealed class Collector : IConnection
{
    private readonly List<Frame> _frames = [];
    public string Id { get; } = $"c-{Guid.NewGuid().ToString("N")[..6]}";
    public void Send(Frame frame) => _frames.Add(frame);
    public void Close(int? code = null, string? reason = null) { }

    public IReadOnlyList<Frame> Drain()
    {
        var out_ = _frames.ToList();
        _frames.Clear();
        return out_;
    }
}
