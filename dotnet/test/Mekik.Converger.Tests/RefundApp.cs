using Ilmek;

namespace Mekik.Converger.Tests;

/// <summary>
/// The refund example's graph (dotnet/examples/Mekik.Examples, ts/examples/refund.ts), for
/// the hub conformance scenario (conformance/converger/refund.json). Kept in step with the
/// example; the scenario pins the wire it produces, not the example file.
/// </summary>
internal static class RefundApp
{
    // Orders are plain dictionaries, not a record: a tool result goes on the wire in the
    // tool_call trace, and frames are canonical JSON of dictionaries, lists and scalars.
    private static readonly Dictionary<string, Dictionary<string, object?>> Orders = new()
    {
        ["ORD-42"] = new() { ["id"] = "ORD-42", ["total"] = 249.9, ["items"] = new List<object?> { "Kettle", "Mug" } },
    };

    public static readonly CompiledGraph Graph = Ilmek.Graph.Create("refund")
        .Channel("input", Channels.LastWrite(""))
        .Channel("order", Channels.LastWrite())
        .Channel("reply", Channels.LastWrite(""))
        .Node("lookup", async (State state, IContext ctx) =>
        {
            var id = state.Get<string>("input").Trim();
            var order = await Shuttle.Tool(ctx, "get_order", new Dictionary<string, object?> { ["id"] = id }, () =>
            {
                if (!Orders.TryGetValue(id, out var o)) throw new Exception($"no order {id}");
                return (object?)o;
            });
            var ord = (IReadOnlyDictionary<string, object?>)order!;
            Shuttle.Ui(ctx, "order-card", new Dictionary<string, object?> { ["id"] = ord["id"], ["total"] = ord["total"], ["items"] = ord["items"] });
            return Update.Of("order", order);
        })
        .Node("approve", async (State state, IContext ctx) =>
        {
            var ord = state.Get<IReadOnlyDictionary<string, object?>>("order");
            var answer = await Shuttle.Approve<Dictionary<string, object?>>(
                ctx,
                new Dictionary<string, object?> { ["title"] = FormattableString.Invariant($"Refund ${ord["total"]} for {ord["id"]}?") },
                ui: new Dictionary<string, object?> { ["component"] = "approval-form", ["props"] = new Dictionary<string, object?> { ["orderId"] = ord["id"], ["amount"] = ord["total"] } },
                actions: new List<object>
                {
                    new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } },
                    new Dictionary<string, object?> { ["label"] = "Reject", ["value"] = new Dictionary<string, object?> { ["approved"] = false } },
                });
            return answer.GetValueOrDefault("approved") is true
                ? Command.Goto_("refund")
                : Command.Create(Update.Of("reply", "Refund declined."), Ilmek.Graph.End);
        })
        .Node("refund", async (State state, IContext ctx) =>
        {
            var ord = state.Get<IReadOnlyDictionary<string, object?>>("order");
            await Shuttle.Tool(ctx, "refund_payment", new Dictionary<string, object?> { ["orderId"] = ord["id"] }, () =>
                (object?)new Dictionary<string, object?> { ["refunded"] = ord["total"] });
            ctx.EmitToken("Refund processed ✅");
            return Update.Of("reply", $"Refund complete: {ord["id"]}");
        })
        .Edge(Ilmek.Graph.Start, "lookup")
        .Edge("lookup", "approve")
        .Edge("refund", Ilmek.Graph.End)
        .Compile();

    private sealed class CountingMinter : IIdMinter
    {
        private int _msg;
        private int _stream;
        public string Message() => $"msg-{Interlocked.Increment(ref _msg)}";
        public string Stream() => $"stream-{Interlocked.Increment(ref _stream)}";
    }

    /// <summary>The conformance environment: a counting minter and a fixed clock (conformance/README.md).</summary>
    public static MekikOptions Options(string greeting, long clock) => new()
    {
        Graph = Graph,
        Input = f => Update.Of("input", ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"]),
        Reply = s => s.GetValueOrDefault("reply") as string,
        Context = (conv, _) => new Dictionary<string, object?> { ["userId"] = conv.UserId, ["locale"] = "en" },
        Greeting = _ => greeting,
        Minter = new CountingMinter(),
        Now = () => clock,
    };
}
