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

MIT
