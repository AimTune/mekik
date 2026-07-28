using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// Tests for the typed rich-message catalog (<see cref="Messages"/> over
/// <see cref="Shuttle.Message"/>). The mapper side (custom → persistent frame,
/// reserved-type drop, id override) is pinned cross-language by the
/// <c>rich-message</c> golden fixture; here we cover the author-facing surface
/// end-to-end. Mirror of ts/packages/core/test/messages.test.ts.
/// </summary>
public class MessagesTests
{
    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame) => _sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    private static MekikApp App(Action<IContext> body)
    {
        var g = Graph.Create("messages")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("show", (State _, IContext ctx) =>
            {
                body(ctx);
                return Update.Of("reply", "ok");
            })
            .Edge(Graph.Start, "show")
            .Edge("show", Graph.End)
            .Compile();

        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
        });
    }

    private static async Task<FakeConn> Run(Action<IContext> body)
    {
        var app = App(body);
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = "go" },
        });
        return conn;
    }

    [Fact]
    public async Task Image_becomes_a_persistent_rich_message_frame_with_the_bot_envelope()
    {
        var conn = await Run(ctx => Messages.Image(ctx, "https://x/receipt.png", caption: "Your receipt"));

        var frame = Assert.Single(conn.Sent, f => f.GetValueOrDefault("type") as string == "image");
        Assert.Equal("bot", frame["from"]);
        Assert.IsType<string>(frame["id"]);
        Assert.True(frame["seq"] is long or int);
        Assert.Equal(
            new Dictionary<string, object?> { ["src"] = "https://x/receipt.png", ["caption"] = "Your receipt" },
            frame["data"]);
        Assert.True(Protocol.IsPersistent(frame));
        Assert.True(Protocol.IsMessageFrame(frame));
    }

    [Fact]
    public async Task Card_and_Carousel_pass_typed_builders_through_and_honour_a_custom_id()
    {
        var conn = await Run(ctx =>
        {
            Messages.Card(ctx, "ORD-1", subtitle: "$249.90", buttons: [Messages.Button("Track", "/track ORD-1")], id: "card-ORD-1");
            Messages.Carousel(ctx, [Messages.CarouselCard("Kettle", image: "https://x/k.png")]);
        });

        var card = Assert.Single(conn.Sent, f => f.GetValueOrDefault("type") as string == "card");
        Assert.Equal("card-ORD-1", card["id"]);
        var cardData = (IReadOnlyDictionary<string, object?>)card["data"]!;
        var button = ((System.Collections.IEnumerable)cardData["buttons"]!).Cast<IReadOnlyDictionary<string, object?>>().Single();
        Assert.Equal(new Dictionary<string, object?> { ["label"] = "Track", ["value"] = "/track ORD-1" }, button);

        var carousel = Assert.Single(conn.Sent, f => f.GetValueOrDefault("type") as string == "carousel");
        var carouselCard = ((System.Collections.IEnumerable)((IReadOnlyDictionary<string, object?>)carousel["data"]!)["cards"]!)
            .Cast<IReadOnlyDictionary<string, object?>>().Single();
        Assert.Equal(new Dictionary<string, object?> { ["title"] = "Kettle", ["image"] = "https://x/k.png" }, carouselCard);
    }

    [Fact]
    public void Reserved_protocol_frame_types_are_rejected_text_is_the_allowed_overlap()
    {
        var g = Graph.Create("noop")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("n", (State _, IContext ctx) =>
            {
                foreach (var reserved in new[] { "genui", "interrupt", "run", "welcome", "typing" })
                {
                    Assert.Throws<ArgumentException>(() =>
                        Shuttle.Message(ctx, reserved, new Dictionary<string, object?>()));
                }
                Messages.Text(ctx, "hi", urls: ["https://example.test"]);
                return Update.Of("reply", "ok");
            })
            .Edge(Graph.Start, "n")
            .Edge("n", Graph.End)
            .Compile();

        // The assertions above run inside the node; driving the graph runs them.
        var app = new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
        });
        var conn = new FakeConn();
        app.ConnectAsync(conn).GetAwaiter().GetResult();
        app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = "go" },
        }).GetAwaiter().GetResult();

        // Two text frames: the rich text message (with urls) and the consolidated reply.
        var texts = conn.Sent.Where(f => f.GetValueOrDefault("type") as string == "text").ToList();
        Assert.Contains(texts, f =>
            f["data"] is IReadOnlyDictionary<string, object?> d && d.ContainsKey("urls"));
    }
}
