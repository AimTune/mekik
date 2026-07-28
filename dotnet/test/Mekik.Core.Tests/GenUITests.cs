using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// Tests for the typed GenUI catalog (<see cref="GenUI"/>). The contract is thin
/// by design: every method must compile down to the exact ui chunk
/// <see cref="Shuttle.Ui"/> emits — chativa's registry name + camelCase props,
/// null parameters omitted. Mirror of ts/packages/core/test/genui.test.ts.
/// </summary>
public class GenUITests
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
        var g = Graph.Create("genui")
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

    private static async Task<List<IReadOnlyDictionary<string, object?>>> UiChunks(Action<IContext> body)
    {
        var app = App(body);
        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "text",
            ["data"] = new Dictionary<string, object?> { ["text"] = "go" },
        });
        return conn.Sent
            .Where(f => f.GetValueOrDefault("type") as string == "genui")
            .Select(f => (IReadOnlyDictionary<string, object?>)f["chunk"]!)
            .Where(c => c.GetValueOrDefault("type") as string == "ui")
            .ToList();
    }

    [Fact]
    public async Task Card_emits_the_registry_name_and_only_the_given_props()
    {
        var chunks = await UiChunks(ctx =>
            GenUI.Card(ctx, title: "ORD-42", actions: [GenUI.CardAction("Detail", "detail:ORD-42")]));

        var chunk = Assert.Single(chunks);
        Assert.Equal("genui-card", chunk["component"]);
        var props = (IReadOnlyDictionary<string, object?>)chunk["props"]!;
        Assert.Equal("ORD-42", props["title"]);
        // Omitted optionals (description, image) never reach the wire.
        Assert.False(props.ContainsKey("description"));
        Assert.False(props.ContainsKey("image"));
        var actionDict = ((System.Collections.IEnumerable)props["actions"]!).Cast<IReadOnlyDictionary<string, object?>>().Single();
        Assert.Equal(new Dictionary<string, object?> { ["label"] = "Detail", ["value"] = "detail:ORD-42" }, actionDict);
    }

    [Fact]
    public async Task Progress_with_the_same_id_updates_one_element_in_place()
    {
        var chunks = await UiChunks(ctx =>
        {
            GenUI.Progress(ctx, 0, label: "Deploying", id: "deploy");
            GenUI.Progress(ctx, 60, label: "Deploying", caption: "rolling out", id: "deploy");
        });

        Assert.Equal(2, chunks.Count);
        Assert.All(chunks, c => Assert.Equal("genui-progress", c["component"]));
        Assert.All(chunks, c => Assert.Equal("deploy", c["id"]));
        Assert.Equal(60d, ((IReadOnlyDictionary<string, object?>)chunks[1]["props"]!)["value"]);
    }

    [Fact]
    public async Task Table_and_Steps_pass_typed_structures_through_as_camelCase_props()
    {
        var chunks = await UiChunks(ctx =>
        {
            GenUI.Table(ctx, columns: ["id", "total"], rows: [["ORD-1", 249.9]], title: "Orders");
            GenUI.Steps(ctx, [GenUI.Step("Paid", "done"), GenUI.Step("Shipped", "active", "on a truck")]);
        });

        var table = (IReadOnlyDictionary<string, object?>)chunks[0]["props"]!;
        Assert.Equal("Orders", table["title"]);
        Assert.Equal(["id", "total"], (IReadOnlyList<string>)table["columns"]!);

        var steps = ((System.Collections.IEnumerable)((IReadOnlyDictionary<string, object?>)chunks[1]["props"]!)["steps"]!)
            .Cast<IReadOnlyDictionary<string, object?>>().ToList();
        Assert.Equal(new Dictionary<string, object?> { ["label"] = "Paid", ["status"] = "done" }, steps[0]);
        Assert.Equal(
            new Dictionary<string, object?> { ["label"] = "Shipped", ["status"] = "active", ["description"] = "on a truck" },
            steps[1]);
    }

    [Fact]
    public void FormRef_builds_the_UiRef_an_interrupt_mounts_as_its_form()
    {
        var uiRef = GenUI.FormRef([GenUI.Field("date", "Date", "date", required: true)], buttonText: "Book");

        Assert.Equal(GenUI.Names.Form, uiRef["component"]);
        var props = (IReadOnlyDictionary<string, object?>)uiRef["props"]!;
        Assert.Equal("Book", props["buttonText"]);
        var field = ((System.Collections.IEnumerable)props["fields"]!).Cast<IReadOnlyDictionary<string, object?>>().Single();
        Assert.Equal(
            new Dictionary<string, object?> { ["name"] = "date", ["label"] = "Date", ["type"] = "date", ["required"] = true },
            field);
    }
}
