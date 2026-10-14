# Mekik.Converger

Run a [mekik](https://github.com/AimTune/mekik) app behind the
[Converger](https://github.com/AimTune/converger) channel hub — the .NET mirror
of `@mekik/converger`. Like `MapMekik` it only speaks sockets — every protocol
rule lives in the engine — but it dials **out**: one `ClientWebSocket` from your
process to the hub's bot channel, every conversation multiplexed on it as
`{conversationId, frame}`, each one driven through its own virtual `IConnection`.

```csharp
using Mekik;

var app = new MekikApp(new MekikOptions { Graph = graph }.WithExternalTranscript());
await using var hub = ConvergerTransport.Connect(app, new ConvergerOptions
{
    Url = "wss://hub.example.com/socket/converger/v1",
    Secret = Environment.GetEnvironmentVariable("CONVERGER_BOT_SECRET"), // the bot channel's secret
});
await hub.Ready;
```

`WithExternalTranscript()` is required: behind a hub, the hub owns the
transcript, the seq space and identity, so the app records nothing, replays
nothing, trusts the hub-verified user and does not echo the user's own turn.

Options: `Url`, `Secret` (tokens are minted with `tokens/generate` and renewed
before they expire), `Token` or `TokenProvider`, `ApiUrl`, `Group` (processes
sharing a channel), `Meta` / `MetaFilter` (allowlist of a user turn's
`metadata` / `meta` keys), `IdleTimeout` (default 15 min), `MaxConcurrentTurns`,
`MaxConversations` (default 5000), `ReconnectMin` / `ReconnectMax` (default
500 ms to 30 s, full jitter), `MaxBuffered` (default 10 000), `OnError`,
`HttpClient`. The transport has `Ready`, `Connected`, `Conversations` and
`DisposeAsync()`.

The frames are mekik/1, unchanged (`PROTOCOL.md` §15, pinned by
`conformance/converger/refund.json`).

Docs: https://mekik.aimtune.dev/serving/converger

MIT
