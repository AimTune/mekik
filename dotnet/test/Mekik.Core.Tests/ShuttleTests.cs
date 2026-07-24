using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// End-to-end tests for the authoring helpers that own logic beyond a single emit.
/// <see cref="Shuttle.StreamText{T}"/> drives an async delta source through
/// <see cref="Shuttle.Text"/> and returns the joined text for the node's reply;
/// we assert on the frames a client would actually receive. Mirror of the
/// TypeScript <c>mekik.streamText</c> suite in ts/packages/core/test/helpers.test.ts.
/// </summary>
public class ShuttleTests
{
    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame) => _sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
    }

    private static Dictionary<string, object?> TextFrame(string text) => new()
    {
        ["type"] = "text",
        ["data"] = new Dictionary<string, object?> { ["text"] = text },
    };

    private static async IAsyncEnumerable<string> Deltas(params string[] items)
    {
        foreach (var item in items)
        {
            await Task.Yield();
            yield return item;
        }
    }

    private static MekikApp StreamerApp(Func<IContext, ValueTask<string>> body, IAuthenticator? authenticator = null)
    {
        var g = Graph.Create("streamer")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("answer", async (State _, IContext ctx) => Update.Of("reply", await body(ctx)))
            .Edge(Graph.Start, "answer")
            .Edge("answer", Graph.End)
            .Compile();

        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Authenticator = authenticator,
            Reply = s => s.GetValueOrDefault("reply") as string,
        });
    }

    private static string? Reply(FakeConn conn) => conn.Sent
        .Where(f => f.GetValueOrDefault("type") as string == "text")
        .Select(f => ((IReadOnlyDictionary<string, object?>)f["data"]!).GetValueOrDefault("text") as string)
        .LastOrDefault();

    [Fact]
    public async Task StreamText_streams_one_coalesced_bubble_and_returns_the_full_text()
    {
        var app = StreamerApp(async ctx =>
            await Shuttle.StreamText(ctx, Deltas("Hel", "", "lo"), ctx.CancellationToken));

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        // The two non-empty deltas ride the same text-run chunk id → one growing bubble.
        var textChunks = conn.Sent
            .Where(f => f.GetValueOrDefault("type") as string == "genui")
            .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
            .Where(c => c.GetValueOrDefault("type") as string == "text")
            .ToList();
        Assert.Equal(["Hel", "lo"], textChunks.Select(c => c["content"] as string));
        Assert.Single(textChunks.Select(c => c["id"]).Distinct());

        // The consolidated reply is the concatenation, delivered as one durable text frame.
        var reply = conn.Sent
            .Where(f => f.GetValueOrDefault("type") as string == "text")
            .Select(f => (IReadOnlyDictionary<string, object?>)f["data"]!)
            .Select(d => d["text"] as string)
            .LastOrDefault();
        Assert.Equal("Hello", reply);
    }

    private sealed record Delta(string Text);

    private static async IAsyncEnumerable<Delta> StructuredDeltas(params string[] items)
    {
        foreach (var item in items)
        {
            await Task.Yield();
            yield return new Delta(item);
        }
    }

    [Fact]
    public async Task StreamText_pulls_text_out_of_structured_deltas_with_the_selector()
    {
        var app = StreamerApp(async ctx =>
            await Shuttle.StreamText(ctx, StructuredDeltas("A", "B"), u => u.Text, ctx.CancellationToken));

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        var reply = conn.Sent
            .Where(f => f.GetValueOrDefault("type") as string == "text")
            .Select(f => (IReadOnlyDictionary<string, object?>)f["data"]!)
            .Select(d => d["text"] as string)
            .LastOrDefault();
        Assert.Equal("AB", reply);
    }

    [Fact]
    public void ClaimStrings_coerces_a_string_list_a_single_string_and_a_boxed_list()
    {
        Assert.Equal(["a", "b"], Shuttle.ClaimStrings(new Dictionary<string, object?> { ["roles"] = new[] { "a", "b" } }, "roles"));
        Assert.Equal(["solo"], Shuttle.ClaimStrings(new Dictionary<string, object?> { ["roles"] = "solo" }, "roles"));
        Assert.Equal(["1", "2"], Shuttle.ClaimStrings(new Dictionary<string, object?> { ["roles"] = new object?[] { 1, 2 } }, "roles"));
        Assert.Empty(Shuttle.ClaimStrings(new Dictionary<string, object?>(), "roles"));
    }

    [Fact]
    public async Task AuthClaims_exposes_the_authenticated_claims_to_a_node()
    {
        var authenticator = new StaticTokenAuthenticator(new Dictionary<string, (string, IReadOnlyDictionary<string, object?>?)>
        {
            ["t1"] = ("alice", new Dictionary<string, object?> { ["roles"] = new[] { "admin", "lead" } }),
        });

        var app = StreamerApp(
            ctx => new ValueTask<string>(string.Join(",", Shuttle.ClaimStrings(Shuttle.AuthClaims(ctx), "roles"))),
            authenticator);

        var conn = new FakeConn();
        await app.ConnectAsync(conn, new ConnectParams { Credential = new Credential { Token = "t1" } });
        await app.ReceiveAsync(conn, TextFrame("hi"));

        Assert.Equal("admin,lead", Reply(conn));
    }
}
