# Mekik.Core

The realtime serving layer for [ilmek](https://www.nuget.org/packages/Ilmek.Core)
graphs — WebSocket sessions, streaming generative UI, and durable, interactive
human-in-the-loop over the **`mekik/1`** wire protocol. The .NET mirror of the
TypeScript `@mekik/core`; both are held to one wire by shared golden fixtures.

```csharp
var graph = Graph.Create("refund")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("gate", async (State state, IContext ctx) =>
    {
        Shuttle.Ui(ctx, "order-card", new Dictionary<string, object?> { ["id"] = state.Get<string>("input") });
        var ok = await Shuttle.Approve<Dictionary<string, object?>>(
            ctx, new Dictionary<string, object?> { ["title"] = "Refund?" });
        return Update.Of("reply", ok.GetValueOrDefault("approved") is true ? "refunded" : "cancelled");
    })
    .Edge(Graph.Start, "gate").Edge("gate", Graph.End)
    .Compile();

var app = new MekikApp(new MekikOptions { Graph = graph, Reply = s => s.GetValueOrDefault("reply") as string });
```

Serve it with `Mekik.AspNetCore`. Helpers live on `Shuttle` (what *mekik* means —
the loom part that carries the thread across); it can't be named `Mekik` because a
static class may not share its namespace's name.

Docs and the normative protocol spec: https://github.com/AimTune/mekik

MIT
