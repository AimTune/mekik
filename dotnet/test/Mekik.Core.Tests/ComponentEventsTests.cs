using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// Component interaction (PROTOCOL.md §10.4): what the engine does with a
/// <c>genui_event</c>. Two paths meet here — the §4.4 shortcut that turns a
/// <c>submit</c> into a resume, and <see cref="MekikOptions.OnGenUiEvent"/>, which
/// decides whether anything else is worth a turn. Mirror of the
/// `component events (§10.4)` suite in ts/packages/core/test/scenarios.test.ts.
/// </summary>
public class ComponentEventsTests
{
    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame) => _sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    /// <summary>Mounts a component and replies — the happy-path turn.</summary>
    private static readonly CompiledGraph Greeter = Graph.Create("greeter")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("greet", (State s, IContext ctx) =>
        {
            Shuttle.Ui(ctx, "hello-card", new Dictionary<string, object?> { ["name"] = s.Get<string>("input") });
            return Update.Of("reply", $"Hi, {s.Get<string>("input")}!");
        })
        .Edge(Graph.Start, "greet")
        .Edge("greet", Graph.End)
        .Compile();

    /// <summary>Pauses once for an approval.</summary>
    private static readonly CompiledGraph Approval = Graph.Create("approval")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("gate", async (State s, IContext ctx) =>
        {
            var answer = await Shuttle.Approve<IReadOnlyDictionary<string, object?>>(
                ctx, new Dictionary<string, object?> { ["title"] = $"approve {s.Get<string>("input")}?" });
            return Update.Of("reply", answer.GetValueOrDefault("approved") is true ? "approved" : "rejected");
        })
        .Edge(Graph.Start, "gate")
        .Edge("gate", Graph.End)
        .Compile();

    /// <summary>Mounts a widget and parks until its own button fires (§10.4).</summary>
    private static readonly CompiledGraph Awaiting = Graph.Create("awaiting")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("wait", async (State s, IContext ctx) =>
        {
            Shuttle.Ui(ctx, "delivery-card", new Dictionary<string, object?> { ["id"] = s.Get<string>("input") }, id: "card-1");
            var req = await Shuttle.OnEvent<IReadOnlyDictionary<string, object?>>(ctx, "track_order");
            return Update.Of("reply", $"tracking {req.GetValueOrDefault("id")}");
        })
        .Edge(Graph.Start, "wait")
        .Edge("wait", Graph.End)
        .Compile();

    private static MekikApp App(CompiledGraph graph, Func<GenUiEvent, IReadOnlyDictionary<string, object?>?>? onEvent) =>
        new(new MekikOptions
        {
            Graph = graph,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
            OnGenUiEvent = onEvent,
        });

    /// <summary>The Track button's frame: an interaction with no bound interrupt.</summary>
    private static Dictionary<string, object?> ClickEvent() => new()
    {
        ["type"] = "genui_event",
        ["streamId"] = "stream-1",
        ["eventType"] = "track_order",
        ["payload"] = new Dictionary<string, object?> { ["id"] = "ORD-42" },
    };

    private static IEnumerable<string?> Types(FakeConn c) => c.Sent.Select(f => f.GetValueOrDefault("type") as string);

    private static List<string?> RunStatuses(FakeConn c) => c.Sent
        .Where(f => (string?)f.GetValueOrDefault("type") == "run")
        .Select(f => ((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("status") as string)
        .ToList();

    private static async Task<(MekikApp App, FakeConn Conn)> Connected(
        CompiledGraph graph, Func<GenUiEvent, IReadOnlyDictionary<string, object?>?>? onEvent)
    {
        var app = App(graph, onEvent);
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        return (app, conn);
    }

    [Fact]
    public async Task Without_a_handler_a_component_event_is_inert()
    {
        var (app, conn) = await Connected(Greeter, null);
        var before = conn.Sent.Count;

        await app.ReceiveAsync(conn, ClickEvent());

        Assert.Equal(before, conn.Sent.Count);
    }

    [Fact]
    public async Task A_handler_that_returns_an_update_runs_a_turn_on_it()
    {
        var seen = new List<GenUiEvent>();
        var (app, conn) = await Connected(Greeter, ev =>
        {
            seen.Add(ev);
            return new Dictionary<string, object?>
            {
                ["input"] = ((IReadOnlyDictionary<string, object?>)ev.Payload!)["id"],
            };
        });
        var welcome = (IReadOnlyDictionary<string, object?>)conn.Sent[0]["data"]!;

        await app.ReceiveAsync(conn, ClickEvent());

        Assert.Equal(["started", "finished"], RunStatuses(conn));
        Assert.Contains(conn.Sent, f =>
            (string?)f.GetValueOrDefault("type") == "text" &&
            (string?)f.GetValueOrDefault("from") == "bot" &&
            (string?)((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") == "Hi, ORD-42!");

        // The handler sees the whole interaction, not just the payload.
        var ev = Assert.Single(seen);
        Assert.Equal("track_order", ev.EventType);
        Assert.Equal("stream-1", ev.StreamId);
        Assert.Equal("ORD-42", ((IReadOnlyDictionary<string, object?>)ev.Payload!)["id"]);
        Assert.Equal(welcome["conversationId"], ev.ConversationId);
        Assert.Equal(welcome["userId"], ev.UserId);
    }

    [Fact]
    public async Task A_click_is_not_an_utterance_so_no_user_text_lands_in_the_transcript()
    {
        var (app, conn) = await Connected(Greeter, _ => new Dictionary<string, object?> { ["input"] = "ORD-42" });

        await app.ReceiveAsync(conn, ClickEvent());

        Assert.DoesNotContain(conn.Sent, f =>
            (string?)f.GetValueOrDefault("type") == "text" && (string?)f.GetValueOrDefault("from") == "user");
    }

    [Fact]
    public async Task A_handler_that_returns_null_starts_no_turn()
    {
        var (app, conn) = await Connected(Greeter, _ => null);
        var before = conn.Sent.Count;

        await app.ReceiveAsync(conn, ClickEvent());

        Assert.Equal(before, conn.Sent.Count);
    }

    [Fact]
    public async Task A_submit_answering_an_open_interrupt_resumes_and_the_handler_never_sees_it()
    {
        var handled = 0;
        var (app, conn) = await Connected(Approval, _ =>
        {
            handled++;
            return new Dictionary<string, object?> { ["input"] = "should not happen" };
        });
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = "refund" },
        });
        var interruptId = (string)conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt")["id"]!;

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "genui_event",
            ["streamId"] = "stream-1",
            ["eventType"] = "submit",
            ["payload"] = new Dictionary<string, object?>
            {
                ["id"] = interruptId,
                ["answer"] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });

        Assert.Equal(0, handled); // the §4.4 shortcut wins over the handler
        Assert.Equal(interruptId, conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt_resolved")["id"]);
        Assert.Contains(conn.Sent, f =>
            (string?)f.GetValueOrDefault("type") == "text" &&
            (string?)f.GetValueOrDefault("from") == "bot" &&
            (string?)((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") == "approved");
    }

    [Fact]
    public async Task A_submit_naming_no_open_interrupt_falls_through_to_the_handler()
    {
        var seen = new List<string>();
        var (app, conn) = await Connected(Greeter, ev => { seen.Add(ev.EventType); return null; });

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "genui_event",
            ["streamId"] = "stream-1",
            ["eventType"] = "submit",
            ["payload"] = new Dictionary<string, object?> { ["id"] = "no-such-interrupt" },
        });

        Assert.Equal(["submit"], seen);
    }

    [Fact]
    public async Task A_component_driven_turn_cannot_overtake_a_pause()
    {
        var (app, conn) = await Connected(Approval, _ => new Dictionary<string, object?> { ["input"] = "again" });
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = "refund" },
        });
        var before = conn.Sent.Count;

        await app.ReceiveAsync(conn, ClickEvent());

        var error = conn.Sent.Skip(before).Single(f => (string?)f.GetValueOrDefault("type") == "error");
        Assert.Equal("interrupted", ((IReadOnlyDictionary<string, object?>)error["data"]!)["code"]);
        // The parked run is untouched.
        Assert.Equal(["started", "interrupted"], RunStatuses(conn));
    }

    // ── the in-graph listener: Shuttle.OnEvent ────────────────────────────────

    /// <summary>Start <see cref="Awaiting"/> and park it on the card's `track_order`.</summary>
    private static async Task<(MekikApp App, FakeConn Conn)> ParkedOnEvent(
        Func<GenUiEvent, IReadOnlyDictionary<string, object?>?>? onEvent = null)
    {
        var (app, conn) = await Connected(Awaiting, onEvent);
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = "ORD-42" },
        });
        return (app, conn);
    }

    private static Dictionary<string, object?> ComponentEvent(string eventType, object? payload, string? scope = "component")
    {
        var frame = new Dictionary<string, object?>
        {
            ["type"] = "genui_event",
            ["streamId"] = "stream-1",
            ["eventType"] = eventType,
            ["payload"] = payload,
        };
        if (scope is not null) frame["scope"] = scope;
        return frame;
    }

    private static bool RepliedWith(FakeConn c, string text) => c.Sent.Any(f =>
        (string?)f.GetValueOrDefault("type") == "text" &&
        (string?)f.GetValueOrDefault("from") == "bot" &&
        (string?)((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") == text);

    [Fact]
    public async Task The_pause_announces_which_event_it_waits_for_and_offers_no_chips()
    {
        var (_, conn) = await ParkedOnEvent();

        Assert.Equal(["started", "interrupted"], RunStatuses(conn));
        var data = (IReadOnlyDictionary<string, object?>)
            conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt")["data"]!;
        Assert.Equal("track_order", data["event"]);
        // A widget answers this, not default Approve/Cancel chips.
        Assert.False(data.ContainsKey("actions"));
    }

    [Fact]
    public async Task A_component_event_resolves_it_and_its_payload_is_the_return_value()
    {
        var (app, conn) = await ParkedOnEvent();

        await app.ReceiveAsync(conn, ComponentEvent("track_order", new Dictionary<string, object?> { ["id"] = "ORD-42" }));

        Assert.Equal(["started", "interrupted", "started", "finished"], RunStatuses(conn));
        Assert.True(RepliedWith(conn, "tracking ORD-42"));
    }

    [Fact]
    public async Task A_plain_data_event_resolves_it_too_because_an_unscoped_event_tries_both_routes()
    {
        var (app, conn) = await ParkedOnEvent();

        await app.ReceiveAsync(conn, ComponentEvent("track_order", new Dictionary<string, object?> { ["id"] = "ORD-42" }, scope: null));

        Assert.True(RepliedWith(conn, "tracking ORD-42"));
    }

    [Fact]
    public async Task A_mekik_event_never_resolves_a_pause_because_it_is_addressed_to_the_graph()
    {
        var handled = 0;
        var (app, conn) = await ParkedOnEvent(_ =>
        {
            handled++;
            return new Dictionary<string, object?> { ["input"] = "ORD-99" };
        });
        var before = conn.Sent.Count;

        await app.ReceiveAsync(conn, ComponentEvent("track_order", new Dictionary<string, object?> { ["id"] = "ORD-42" }, scope: "graph"));

        Assert.Equal(1, handled); // it went to the graph handler, not the waiting node
        var error = conn.Sent.Skip(before).Single(f => (string?)f.GetValueOrDefault("type") == "error");
        Assert.Equal("interrupted", ((IReadOnlyDictionary<string, object?>)error["data"]!)["code"]);
        Assert.Equal(["started", "interrupted"], RunStatuses(conn));
    }

    [Fact]
    public async Task An_event_no_node_is_waiting_for_does_not_reach_the_graph_handler_when_component_scoped()
    {
        var handled = 0;
        var (app, conn) = await ParkedOnEvent(_ => { handled++; return null; });

        await app.ReceiveAsync(conn, ComponentEvent("some_other_button", new Dictionary<string, object?>()));

        Assert.Equal(0, handled); // a component-event is for a component's own pause, nothing else
        Assert.Equal(["started", "interrupted"], RunStatuses(conn));
    }

    [Fact]
    public async Task A_submit_naming_the_interrupt_still_wins_whatever_the_scope_says()
    {
        var (app, conn) = await ParkedOnEvent();
        var interruptId = (string)conn.Sent.First(f => (string?)f.GetValueOrDefault("type") == "interrupt")["id"]!;

        await app.ReceiveAsync(conn, ComponentEvent("submit", new Dictionary<string, object?>
        {
            ["id"] = interruptId,
            ["answer"] = new Dictionary<string, object?> { ["id"] = "ORD-7" },
        }, scope: "graph"));

        Assert.True(RepliedWith(conn, "tracking ORD-7"));
    }

    [Fact]
    public async Task An_unknown_scope_is_a_bad_request()
    {
        var (app, conn) = await ParkedOnEvent();

        await app.ReceiveAsync(conn, ComponentEvent("track_order", null, scope: "everywhere"));

        var error = conn.Sent[^1];
        Assert.Equal("error", error["type"]);
        Assert.Equal("bad_request", ((IReadOnlyDictionary<string, object?>)error["data"]!)["code"]);
    }
}
