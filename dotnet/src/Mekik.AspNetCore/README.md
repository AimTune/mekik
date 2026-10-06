# Mekik.AspNetCore

ASP.NET Core WebSocket transport for [mekik](https://github.com/AimTune/mekik) —
serves a `MekikApp` over the `mekik/1` wire protocol. A thin adapter: every
protocol rule lives in the engine.

```csharp
var builder = WebApplication.CreateBuilder(args);
var web = builder.Build();

web.UseWebSockets();
web.MapMekik("/ws", new MekikApp(new MekikOptions { Graph = graph }));
web.Run();
```

Identity may arrive in the URL query string or the first `hello` frame; both are
merged at connect.

The same package serves the graph to *agents*: `web.MapMekikMcp("/mcp", new
MekikMcpServer(app, new McpServerOptions { Name = "support_desk" }))` exposes it
as two Model Context Protocol tools over Streamable HTTP (PROTOCOL.md §13) — a
turn, and a resume for its human-in-the-loop pauses. `web.MapMekikA2a("/a2a",
new MekikA2aServer(app, new A2aServerOptions { Name = "Support desk", Url = "…" }))`
serves it as an Agent2Agent peer instead (PROTOCOL.md §14): an Agent Card at
`/.well-known/agent-card.json`, one turn per task, pauses as `input-required`.

MIT
